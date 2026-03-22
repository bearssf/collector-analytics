const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { htmlToPlainLines } = require('./documentExport');
const { normalizeCategory } = require('./anvilFeedback');

const MAX_DRAFT_CHARS = 12000;
const MAX_SUGGESTIONS = 8;
/** Minimum plain-text length after stripping HTML; below this we skip Bedrock (client can retry after more writing). */
const MIN_DRAFT_PLAIN_CHARS = 15;

/** Trim and strip accidental surrounding quotes from Render / .env paste. */
function trimBedrockEnv(value) {
  if (value == null || value === '') return '';
  let s = String(value).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * InvokeModel accepts a foundation model id **or** an inference profile id/ARN.
 * Many newer Claude models (e.g. Sonnet 4.x) require an **inference profile** — raw model ids can return
 * "on-demand throughput isn't supported; use an inference profile".
 *
 * Precedence: `BEDROCK_INFERENCE_PROFILE_ARN` → `BEDROCK_INFERENCE_PROFILE_ID` → `BEDROCK_MODEL_ID`.
 * If profile vars are empty, the old foundation model id may still be used and AWS can return "invalid model identifier".
 */
function resolveBedrockModelId() {
  const arnOrEither = trimBedrockEnv(process.env.BEDROCK_INFERENCE_PROFILE_ARN);
  if (arnOrEither) return arnOrEither;
  const profileIdOnly = trimBedrockEnv(process.env.BEDROCK_INFERENCE_PROFILE_ID);
  if (profileIdOnly) return profileIdOnly;
  return trimBedrockEnv(process.env.BEDROCK_MODEL_ID);
}

function isBedrockConfigured() {
  const region = trimBedrockEnv(process.env.AWS_REGION);
  return Boolean(region && resolveBedrockModelId());
}

function draftPlainFromHtml(html) {
  const lines = htmlToPlainLines(html);
  return lines.join('\n\n').trim();
}

function truncate(s, max) {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n[…truncated for review]`;
}

function buildPrompt({ sectionTitle, citationStyle, sourcesBlock, draftPlain }) {
  const title = String(sectionTitle || 'Section').trim() || 'Section';
  const style = String(citationStyle || 'APA').trim() || 'APA';
  return `You are an academic writing coach helping a graduate-level author revise a section of their project.

Project citation style (for in-text and reference expectations): ${style}

Sources linked to this section from the user's bibliography (Crucible):
${sourcesBlock}

Section title: ${title}

Draft (plain text converted from the editor):
"""
${draftPlain}
"""

Return ONLY a JSON array with between 0 and ${MAX_SUGGESTIONS} objects. No markdown fences, no commentary outside the array.
Each object must be exactly: {"category":"<one of logic evidence citations format>","body":"<one specific concise suggestion in plain English>"}

Category meanings:
- logic: argument structure, reasoning, gaps, or organization of ideas
- evidence: whether claims need support, data, or stronger backing
- citations: missing citations, reference list issues, or attribution
- format: APA/MLA/style, headings, grammar clarity, or presentation (not duplicate citation issues)

If the draft is too short to review meaningfully, return [].
If nothing needs improvement, return [].`;
}

function extractAssistantText(parsed) {
  if (parsed.content && Array.isArray(parsed.content)) {
    return parsed.content
      .filter((c) => c && c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('\n');
  }
  if (parsed.outputText) return String(parsed.outputText);
  return '';
}

function parseSuggestionsFromModelText(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();

  let arr;
  try {
    arr = JSON.parse(t);
  } catch (e) {
    const i = t.indexOf('[');
    const j = t.lastIndexOf(']');
    if (i >= 0 && j > i) {
      arr = JSON.parse(t.slice(i, j + 1));
    } else {
      throw new Error('Model did not return valid JSON');
    }
  }
  if (!Array.isArray(arr)) {
    throw new Error('Model JSON was not an array');
  }

  const out = [];
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const cat = normalizeCategory(row.category);
    const body = row.body != null ? String(row.body).trim() : '';
    if (!cat || !body) continue;
    out.push({ category: cat, body });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

async function invokeClaudeReview(prompt) {
  const region = trimBedrockEnv(process.env.AWS_REGION);
  const modelId = resolveBedrockModelId();

  const client = new BedrockRuntimeClient({ region });
  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    temperature: 0.2,
    messages: [{ role: 'user', content: prompt }],
  };

  const cmd = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: Buffer.from(JSON.stringify(payload), 'utf8'),
  });

  const res = await client.send(cmd);
  const raw = Buffer.from(res.body).toString('utf8');
  const parsed = JSON.parse(raw);
  return extractAssistantText(parsed);
}

/**
 * @param {{ html: string, sectionTitle: string, citationStyle: string, sourcesForSection: Array<{ citation_text?: string, notes?: string }> }} opts
 * @returns {Promise<{ suggestions: { category: string, body: string }[], skipped?: boolean }>}
 */
async function runSectionReview(opts) {
  const html = opts.html != null ? String(opts.html) : '';
  const draft = draftPlainFromHtml(html);
  if (draft.length < MIN_DRAFT_PLAIN_CHARS) {
    return { suggestions: [], skipped: true, shortDraft: true };
  }

  const sources = opts.sourcesForSection || [];
  const sourcesBlock =
    sources.length === 0
      ? '(No sources linked to this section yet.)'
      : sources
          .map((s, i) => {
            const cite = s.citation_text != null ? String(s.citation_text).trim() : '';
            const notes = s.notes != null ? String(s.notes).trim() : '';
            let line = `${i + 1}. ${cite || '(empty citation)'}`;
            if (notes) line += `\n   Notes: ${notes}`;
            return line;
          })
          .join('\n');

  const prompt = buildPrompt({
    sectionTitle: opts.sectionTitle,
    citationStyle: opts.citationStyle,
    sourcesBlock,
    draftPlain: truncate(draft, MAX_DRAFT_CHARS),
  });

  const assistantText = await invokeClaudeReview(prompt);
  const suggestions = parseSuggestionsFromModelText(assistantText);
  return { suggestions };
}

module.exports = {
  isBedrockConfigured,
  resolveBedrockModelId,
  trimBedrockEnv,
  runSectionReview,
  draftPlainFromHtml,
  MIN_DRAFT_PLAIN_CHARS,
};

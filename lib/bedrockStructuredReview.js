const {
  invokeClaudeMessages,
  draftPlainFromHtml,
  isBedrockConfigured,
  MIN_DRAFT_PLAIN_CHARS,
} = require('./bedrockReview');

const MAX_DRAFT_CHARS = 12000;
const MAX_ITEMS = 100;

function truncate(s, max) {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n[…truncated for review]`;
}

function extractAssistantJsonArray(text) {
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
      try {
        arr = JSON.parse(t.slice(i, j + 1));
      } catch (e2) {
        console.error('[Bedrock] Fallback JSON parse failed:', e2.message);
        throw new Error('There was a problem generating feedback and suggestions, please retry later.');
      }
    } else {
      throw new Error('There was a problem generating feedback and suggestions, please retry later.');
    }
  }
  if (!Array.isArray(arr)) throw new Error('There was a problem generating feedback and suggestions, please retry later.');
  return arr;
}

/**
 * @param {string} plain - full plain text (must match client Quill getText for anchors)
 * @param {object} row
 */
function normalizeItem(plain, row) {
  if (!row || typeof row !== 'object') return null;
  const id = row.id != null ? String(row.id).trim().slice(0, 64) : '';
  const category = row.category != null ? String(row.category).trim().toLowerCase() : '';
  const anchorText = row.anchorText != null ? String(row.anchorText) : '';
  const contextBefore = row.contextBefore != null ? String(row.contextBefore) : '';
  const contextAfter = row.contextAfter != null ? String(row.contextAfter) : '';
  const suggestion = row.suggestion != null ? String(row.suggestion) : '';
  const rationale = row.rationale != null ? String(row.rationale).trim() : '';
  let isActionable = false;
  if (row.isActionable === true || row.isActionable === 1) isActionable = true;
  else if (typeof row.isActionable === 'string')
    isActionable = row.isActionable.trim().toLowerCase() === 'true';
  else if (row.isActionable === false || row.isActionable === 0) isActionable = false;

  if (!id || !category || !anchorText) return null;
  if (!plain.includes(anchorText)) {
    return null;
  }

  return {
    id,
    category,
    anchorText,
    contextBefore,
    contextAfter,
    suggestion,
    rationale,
    isActionable,
  };
}

function buildPrompt({ draftPlain, sectionTitle }) {
  const title = String(sectionTitle || 'Section').trim() || 'Section';
  return `You are a writing feedback assistant. Analyze the text and return structured feedback as a JSON array only.

Section title: ${title}

Document text (verbatim — anchors must be copied EXACTLY from this string):
"""
${draftPlain}
"""

Return a JSON array (max ${MAX_ITEMS} items). Each object MUST have:
- id: unique string, e.g. "fb-001"
- category: one of spelling, grammar, formatting, logic, evidence, clarity
- anchorText: EXACT substring from the document above (verbatim). Short but unique when possible.
- contextBefore: ~30 characters immediately before anchorText in the document (or shorter if at start)
- contextAfter: ~30 characters immediately after anchorText (or shorter if at end)
- suggestion: replacement text, or "" if advisory only
- rationale: brief explanation for the UI
- isActionable: true if suggestion is a concrete replacement, false if advisory only

Rules:
- anchorText MUST appear verbatim in the document text above.
- Do not invent text that is not in the document for anchorText.
- Return [] if nothing to improve.
- Return valid JSON only. No markdown fences. No commentary outside the array.

Respond ONLY with the JSON array.`;
}

/**
 * @param {{ html?: string, plainText?: string, sectionTitle: string }} opts
 * Prefer plainText from the client (Quill getText) so anchors match the editor exactly.
 * @returns {Promise<{ items: object[], skipped?: boolean, shortDraft?: boolean }>}
 */
async function runStructuredSectionReview(opts) {
  let plain =
    opts.plainText != null && String(opts.plainText).length > 0
      ? String(opts.plainText)
      : draftPlainFromHtml(opts.html != null ? String(opts.html) : '');
  if (plain.length < MIN_DRAFT_PLAIN_CHARS) {
    return { items: [], skipped: true, shortDraft: true };
  }
  const draftPlain = truncate(plain, MAX_DRAFT_CHARS);
  const prompt = buildPrompt({
    draftPlain,
    sectionTitle: opts.sectionTitle,
  });
  const assistantText = await invokeClaudeMessages(prompt, { maxTokens: 8192, temperature: 0.2 });
  const rawArr = extractAssistantJsonArray(assistantText);
  const items = [];
  for (const row of rawArr) {
    const it = normalizeItem(draftPlain, row);
    if (it) items.push(it);
    if (items.length >= MAX_ITEMS) break;
  }
  return { items };
}

module.exports = {
  runStructuredSectionReview,
};

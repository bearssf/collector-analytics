const crypto = require('crypto');
const { buildPlainTextForProject } = require('./documentExport');
const { invokeClaudeMessages } = require('./bedrockReview');
const { isBedrockConfigured } = require('./bedrockReview');
const {
  COMPONENT_EVAL_ORDER,
  TILE_ID_TO_RUBRIC,
  PASS1_PROMPTS,
  scoringPromptForComponent,
} = require('./researchAnatomyConstants');

const CHUNK_SIZE = 7000;
const CHUNK_OVERLAP = 500;

/** Minimum word count for a forged review (matches product rule). */
const MIN_REVIEW_WORDS = 100;

function countWords(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function versionIdFromBundle(bundle) {
  const parts = (bundle.sections || [])
    .map((s) => `${s.id}:${s.draft_revision}`)
    .join('|');
  return crypto.createHash('sha256').update(parts).digest('hex').slice(0, 32);
}

/**
 * Section-aware plain document with markdown-style headings (from export layout).
 */
function buildSectionAwareDocument(bundle) {
  const raw = buildPlainTextForProject(bundle.project.name, bundle.sections || []);
  const lines = raw.split('\n');
  if (!lines.length) return '';
  const out = [];
  const projectTitle = String(lines[0] || 'Project').trim();
  out.push(`# ${projectTitle}\n`);
  let i = 1;
  while (i < lines.length && !String(lines[i]).trim()) i += 1;
  while (i < lines.length) {
    const secTitle = String(lines[i] || 'Section').trim();
    i += 1;
    while (i < lines.length && !String(lines[i]).trim()) i += 1;
    const contentLines = [];
    while (i < lines.length && String(lines[i]).trim()) {
      contentLines.push(lines[i]);
      i += 1;
    }
    out.push(`\n## ${secTitle}\n\n${contentLines.join('\n')}\n`);
    while (i < lines.length && !String(lines[i]).trim()) i += 1;
  }
  return out.join('').trim();
}

/**
 * Split document into overlapping chunks; prefers splitting at ## headings when possible.
 */
function chunkDocument(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (t.length <= CHUNK_SIZE) return [{ label: '1/1', text: t }];

  const chunks = [];
  let start = 0;
  let part = 1;
  while (start < t.length) {
    let end = Math.min(start + CHUNK_SIZE, t.length);
    if (end < t.length) {
      const slice = t.slice(start, end);
      const h2 = slice.lastIndexOf('\n## ');
      if (h2 > CHUNK_SIZE * 0.35) {
        end = start + h2;
      } else {
        const nl = slice.lastIndexOf('\n\n');
        if (nl > CHUNK_SIZE * 0.4) end = start + nl;
      }
    }
    const piece = t.slice(start, end).trim();
    if (piece) {
      chunks.push({ label: `${part}/${Math.ceil(t.length / CHUNK_SIZE)}`, text: piece });
      part += 1;
    }
    if (end >= t.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return chunks;
}

function extractJsonObject(raw) {
  const s = String(raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const tryParse = (x) => {
    try {
      return JSON.parse(x);
    } catch {
      return null;
    }
  };
  if (fence) {
    const p = tryParse(fence[1].trim());
    if (p) return p;
  }
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) {
    const p = tryParse(s.slice(i, j + 1));
    if (p) return p;
  }
  return null;
}

function buildPass1Prompt(chunkText, chunkLabel) {
  const header = `You are analyzing part of an academic manuscript (chunk ${chunkLabel}).\n\nTEXT:\n---\n${chunkText}\n---\n\n`;
  const tail = [
    'Return ONLY valid JSON (no markdown) with exactly these keys. Each value is an array of objects with "excerpt" and "location" (short location note). Use [] if no relevant text.',
    '',
    'Keys: ' + COMPONENT_EVAL_ORDER.map((k) => JSON.stringify(k)).join(', '),
    '',
    'For each key, follow this guidance when locating passages:',
  ];
  COMPONENT_EVAL_ORDER.forEach((c) => {
    tail.push(`- ${c}: ${PASS1_PROMPTS[c]}`);
  });
  return header + tail.join('\n');
}

function mergePass1Results(chunkResults) {
  const merged = {};
  COMPONENT_EVAL_ORDER.forEach((c) => {
    merged[c] = [];
  });
  chunkResults.forEach((obj) => {
    if (!obj || typeof obj !== 'object') return;
    COMPONENT_EVAL_ORDER.forEach((c) => {
      const arr = obj[c];
      if (Array.isArray(arr)) {
        arr.forEach((item) => {
          if (item && typeof item === 'object' && item.excerpt) {
            merged[c].push({
              excerpt: String(item.excerpt).trim(),
              location: item.location != null ? String(item.location).trim() : '',
            });
          }
        });
      }
    });
  });
  return merged;
}

function passageBlockForComponent(merged, componentName) {
  const arr = merged[componentName] || [];
  if (!arr.length) {
    return '(No passages were identified in the manuscript for this component.)';
  }
  return arr
    .map((x, i) => `[${i + 1}] (${x.location || 'location n/a'})\n${x.excerpt}`)
    .join('\n\n');
}

/**
 * @returns {Promise<Record<string, { score: string, evidence: string, feedback: string }>>}
 */
async function runPass2Scores(merged) {
  const out = {};
  for (const componentName of COMPONENT_EVAL_ORDER) {
    const block = passageBlockForComponent(merged, componentName);
    const prompt = scoringPromptForComponent(componentName, block);
    const raw = await invokeClaudeMessages(prompt, { maxTokens: 2048, temperature: 0 });
    const parsed = extractJsonObject(raw);
    if (parsed && typeof parsed === 'object' && (parsed.score != null || parsed.evidence != null)) {
      out[componentName] = {
        score: String(parsed.score != null ? parsed.score : '').trim(),
        evidence: String(parsed.evidence != null ? parsed.evidence : '').trim(),
        feedback: String(parsed.feedback != null ? parsed.feedback : '').trim(),
      };
    } else {
      out[componentName] = {
        score: 'N/A',
        evidence: '',
        feedback: 'Could not parse model response for this component.',
      };
    }
  }
  return out;
}

function tileResultsFromScores(pass2Scores) {
  const byTile = {};
  Object.keys(TILE_ID_TO_RUBRIC).forEach((tileId) => {
    const comp = TILE_ID_TO_RUBRIC[tileId];
    const row = pass2Scores[comp];
    byTile[tileId] = row
      ? {
          component: comp,
          score: row.score,
          evidence: row.evidence ? [row.evidence] : [],
          feedback: row.feedback,
          location: '',
        }
      : null;
  });
  return byTile;
}

/**
 * Full pipeline: chunk → pass1 per chunk → merge → pass2 per component → structured results for UI + DB.
 */
async function runResearchAnatomyEvaluation(fullText) {
  if (!isBedrockConfigured()) {
    throw new Error('AI review is not configured (Bedrock).');
  }
  const chunks = chunkDocument(fullText);
  if (!chunks.length) {
    throw new Error('No text to evaluate.');
  }

  const pass1ChunkResults = [];
  for (const ch of chunks) {
    const prompt = buildPass1Prompt(ch.text, ch.label);
    const raw = await invokeClaudeMessages(prompt, { maxTokens: 8192, temperature: 0 });
    const parsed = extractJsonObject(raw);
    if (parsed && typeof parsed === 'object') {
      pass1ChunkResults.push(parsed);
    } else {
      pass1ChunkResults.push({});
    }
  }

  const merged = mergePass1Results(pass1ChunkResults);
  const pass2Scores = await runPass2Scores(merged);
  const byTile = tileResultsFromScores(pass2Scores);

  return {
    mergedPass1: merged,
    pass2ByComponent: pass2Scores,
    byTile,
    tableRows: COMPONENT_EVAL_ORDER.map((c) => ({
      component: c,
      score: (pass2Scores[c] && pass2Scores[c].score) || '',
    })),
  };
}

module.exports = {
  versionIdFromBundle,
  buildSectionAwareDocument,
  chunkDocument,
  runResearchAnatomyEvaluation,
  tileResultsFromScores,
  COMPONENT_EVAL_ORDER,
  TILE_ID_TO_RUBRIC,
  countWords,
  MIN_REVIEW_WORDS,
};

/**
 * Related reading: Semantic Scholar search from project title + source snippets; Bedrock fallback for search queries.
 */

const { searchPapers } = require('./semanticScholar');
const { isBedrockConfigured, invokeClaudeMessages } = require('./bedrockReview');

/**
 * Run Semantic Scholar searches for each query (serialized + ≥1s gap via searchPapers).
 * Dedupes by paperId; caps total rows for the rail.
 */
async function fetchPapersFromQueries(queries, opts = {}) {
  const maxQueries = Math.min(4, Math.max(1, opts.maxQueries != null ? Number(opts.maxQueries) : 3));
  const limitPerQuery = Math.min(5, Math.max(1, opts.limitPerQuery != null ? Number(opts.limitPerQuery) : 4));
  const maxTotal = Math.min(20, Math.max(1, opts.maxTotal != null ? Number(opts.maxTotal) : 12));
  const list = (queries || [])
    .map((q) => String(q || '').trim())
    .filter(Boolean)
    .slice(0, maxQueries);
  const seen = new Set();
  const out = [];
  for (const q of list) {
    try {
      const r = await searchPapers(q, { limit: limitPerQuery });
      for (const p of r.papers || []) {
        if (p && p.paperId && !seen.has(p.paperId)) {
          seen.add(p.paperId);
          out.push(p);
          if (out.length >= maxTotal) return out;
        }
      }
    } catch {
      /* try next query */
    }
  }
  return out;
}

function buildSearchQuery(project, sources) {
  const title = String(
    (project && (project.publishing_title || project.publishingTitle)) || (project && project.name) || ''
  ).trim();
  const citeSnippets = (sources || [])
    .slice(0, 5)
    .map((s) => String((s && s.citation_text) || '').replace(/\s+/g, ' ').trim().slice(0, 140))
    .filter(Boolean);
  let q = title;
  if (citeSnippets.length) {
    q = q ? `${q} ${citeSnippets.join(' ')}` : citeSnippets.join(' ');
  }
  q = q.trim().slice(0, 480);
  return q || null;
}

function parseJsonLoose(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('No JSON object in model response');
  return JSON.parse(t.slice(i, j + 1));
}

async function bedrockSearchQueryFallback(project, sources) {
  const title = String((project && (project.publishing_title || project.name)) || '').trim() || '(untitled project)';
  const snippets = (sources || [])
    .slice(0, 8)
    .map((s, idx) => {
      const c = String((s && s.citation_text) || '').trim().slice(0, 220);
      return c ? `${idx + 1}. ${c}` : null;
    })
    .filter(Boolean);

  const prompt = `You help graduate students discover related academic literature.

Project title: "${title}"

Reference lines from the user's source list (may be partial):
${snippets.length ? snippets.join('\n') : '(no sources yet)'}

Return ONLY valid JSON (no markdown, no commentary):
{"queries":["short English search phrase 1","phrase 2","phrase 3"],"tip":"One sentence explaining how to use these in Semantic Scholar or Google Scholar."}

Rules:
- "queries" must be 2–4 concise search queries (topics, methods, keywords)—not made-up paper titles.
- Do not invent DOIs or pretend specific papers exist.`;

  const raw = await invokeClaudeMessages(prompt, { maxTokens: 600, temperature: 0.35 });
  const parsed = parseJsonLoose(raw);
  const queries = Array.isArray(parsed.queries)
    ? parsed.queries.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6)
    : [];
  const tip = parsed.tip != null ? String(parsed.tip).trim() : '';
  return { suggestedQueries: queries, readingTip: tip };
}

/**
 * @param {{ project: object, sources: object[] }} input
 * @returns {Promise<object>}
 */
async function getRelatedReadingSuggestions({ project, sources }) {
  const query = buildSearchQuery(project, sources);
  if (!query) {
    return {
      ok: false,
      code: 'MISSING_CONTEXT',
      message: 'Add a project title (or publishing title in settings) or at least one source to search for related papers.',
    };
  }

  let s2Papers = [];
  let s2Total = 0;
  let s2Error = null;
  try {
    const r = await searchPapers(query, { limit: 5 });
    s2Papers = r.papers || [];
    s2Total = r.total != null ? r.total : s2Papers.length;
  } catch (e) {
    s2Error = e.message || String(e);
  }

  if (s2Papers.length > 0) {
    return {
      ok: true,
      source: 'semantic_scholar',
      query,
      total: s2Total,
      papers: s2Papers,
      paperDiscovery: 'primary',
    };
  }

  if (isBedrockConfigured()) {
    try {
      const fb = await bedrockSearchQueryFallback(project, sources || []);
      const multiPapers = await fetchPapersFromQueries(fb.suggestedQueries, {
        maxQueries: 3,
        limitPerQuery: 4,
        maxTotal: 12,
      });
      if (multiPapers.length > 0) {
        return {
          ok: true,
          source: 'semantic_scholar',
          query,
          fallback: true,
          total: multiPapers.length,
          papers: multiPapers,
          paperDiscovery: 'multi_query',
          semanticScholarError: null,
          suggestedQueries: fb.suggestedQueries,
          readingTip: fb.readingTip,
        };
      }
      return {
        ok: true,
        source: 'bedrock',
        query,
        fallback: true,
        semanticScholarError: s2Error || null,
        suggestedQueries: fb.suggestedQueries,
        readingTip: fb.readingTip,
        papers: [],
      };
    } catch (e) {
      return {
        ok: true,
        source: 'bedrock_error',
        query,
        fallback: true,
        semanticScholarError: s2Error,
        bedrockError: e.message || String(e),
        papers: [],
        suggestedQueries: [],
        readingTip: '',
      };
    }
  }

  return {
    ok: true,
    source: 'unavailable',
    query,
    semanticScholarError: s2Error,
    message:
      s2Error ||
      'No matching papers from Semantic Scholar. Configure AWS Bedrock for AI-generated search ideas, or try a different project title.',
    papers: [],
  };
}

module.exports = {
  buildSearchQuery,
  getRelatedReadingSuggestions,
  fetchPapersFromQueries,
};

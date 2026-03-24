/**
 * Semantic Scholar Graph API — paper search with process-wide spacing (≤1 req/s org policy; we use ~1.1s gaps).
 * https://api.semanticscholar.org/api-docs/
 */

const S2_BASE = 'https://api.semanticscholar.org/graph/v1';
/** Minimum ms after each S2 call completes before the next may start (~1 req/s org policy). */
const MIN_GAP_MS = 1050;
/** Backoff when S2 returns 429 (inside a single logical search; still serialized globally). */
const RETRY_429_BASE_MS = 2500;
const MAX_429_RETRIES = 3;
/** Per-request HTTP timeout so hung sockets cannot block the global S2 queue forever. */
const FETCH_TIMEOUT_MS = 30000;

let s2Chain = Promise.resolve();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withS2RateLimit(fn) {
  const op = s2Chain.then(async () => {
    try {
      return await fn();
    } finally {
      /* next waiter runs after this promise settles */
    }
  });
  s2Chain = op.then(
    () => sleep(MIN_GAP_MS),
    () => sleep(MIN_GAP_MS)
  );
  return op;
}

function truncate(s, max) {
  const t = String(s || '').trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trim() + '…';
}

function formatAuthors(authors) {
  if (!Array.isArray(authors)) return '';
  const names = authors.map((a) => (a && a.name ? String(a.name) : '')).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length <= 2) return names.join(', ');
  return names.slice(0, 2).join(', ') + ' et al.';
}

function normalizePaper(p) {
  if (!p || !p.paperId) return null;
  return {
    paperId: p.paperId,
    title: p.title != null ? String(p.title) : '',
    year: p.year != null ? Number(p.year) : null,
    authors: formatAuthors(p.authors),
    abstract: truncate(p.abstract, 420),
    url: `https://www.semanticscholar.org/paper/${encodeURIComponent(p.paperId)}`,
  };
}

/**
 * @param {string} query
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<{ papers: object[], total: number }>}
 */
async function searchPapers(query, opts = {}) {
  const limit = Math.min(10, Math.max(1, opts.limit != null ? Number(opts.limit) : 5));
  const q = String(query || '').trim();
  if (!q) return { papers: [], total: 0 };

  return withS2RateLimit(async () => {
    const params = new URLSearchParams({
      query: q,
      limit: String(limit),
      fields: 'paperId,title,year,authors,abstract',
    });
    const url = `${S2_BASE}/paper/search?${params.toString()}`;
    const headers = { Accept: 'application/json' };
    const key = process.env.SEMANTIC_SCHOLAR_API_KEY;
    if (key != null && String(key).trim() !== '') {
      headers['x-api-key'] = String(key).trim();
    }

    const runFetch = async () => {
      try {
        return await fetch(url, {
          headers,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (e) {
        const name = e && e.name;
        if (name === 'AbortError' || name === 'TimeoutError') {
          throw new Error(
            `Semantic Scholar request timed out after ${FETCH_TIMEOUT_MS / 1000}s (network or API slow)`
          );
        }
        throw e;
      }
    };

    let res = await runFetch();
    let attempt429 = 0;
    while (res.status === 429 && attempt429 < MAX_429_RETRIES) {
      attempt429 += 1;
      const backoff = Math.min(20000, RETRY_429_BASE_MS * Math.pow(2, attempt429 - 1));
      await sleep(backoff);
      res = await runFetch();
    }
    if (!res.ok) {
      if (res.status === 429) {
        throw new Error(
          'Semantic Scholar rate limit (429). Wait a minute and try again, or set SEMANTIC_SCHOLAR_API_KEY for higher limits.'
        );
      }
      const errText = await res.text().catch(() => '');
      throw new Error(`Semantic Scholar returned ${res.status}${errText ? `: ${errText.slice(0, 200)}` : ''}`);
    }
    const json = await res.json();
    const data = Array.isArray(json.data) ? json.data : [];
    const papers = data.map(normalizePaper).filter(Boolean);
    return {
      papers,
      total: typeof json.total === 'number' ? json.total : papers.length,
    };
  });
}

module.exports = {
  searchPapers,
};

const https = require('https');

const BASE_URL = 'https://api.semanticscholar.org/graph/v1';
const REQUESTED_FIELDS = 'title,authors,year,url,abstract,citationCount';
const MAX_RESULTS = 20;
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Combine an array of keyword strings into a single query suitable for the
 * Semantic Scholar relevance-search endpoint.  Hyphens are replaced with
 * spaces (the API docs warn against them) and duplicate terms are removed.
 */
function buildQuery(keywords) {
  const seen = new Set();
  const parts = [];
  for (const kw of keywords) {
    const cleaned = String(kw)
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) continue;
    const lower = cleaned.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    parts.push(cleaned);
  }
  return parts.join(' ');
}

function truncateAbstract(text, max) {
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(' ', max);
  return text.slice(0, cut > 0 ? cut : max) + '…';
}

/**
 * GET https://api.semanticscholar.org/graph/v1/paper/search
 *
 * Returns a promise that resolves with the parsed JSON body.
 * Uses only the built-in `https` module — no external dependencies.
 */
function httpGet(url, apiKey) {
  return new Promise(function (resolve, reject) {
    const headers = { Accept: 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;

    const req = https.get(url, { headers, timeout: REQUEST_TIMEOUT_MS }, function (res) {
      const chunks = [];
      res.on('data', function (d) { chunks.push(d); });
      res.on('end', function () {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 429) {
          return reject(new Error('Semantic Scholar rate limit exceeded. Try again shortly.'));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('Semantic Scholar API responded with status ' + res.statusCode + ': ' + body.slice(0, 300)));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Failed to parse Semantic Scholar response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(); reject(new Error('Semantic Scholar request timed out')); });
  });
}

/**
 * Search Semantic Scholar for papers matching the given keywords.
 *
 * @param {string[]} keywords  – array of search terms (titles, author names, topics)
 * @param {object}   [opts]
 * @param {number}   [opts.limit=20]   – max results (capped at 100 by the API)
 * @param {string}   [opts.apiKey]     – optional x-api-key for higher rate limits
 * @param {string}   [opts.year]       – optional year filter, e.g. "2020-2024"
 * @param {string}   [opts.fieldsOfStudy] – optional comma-separated fields of study
 * @returns {Promise<object[]>}  array of paper objects
 */
async function searchPapers(keywords, opts) {
  opts = opts || {};
  const query = buildQuery(keywords);
  if (!query) return [];

  const limit = Math.min(opts.limit || MAX_RESULTS, 100);

  const params = new URLSearchParams({
    query,
    fields: REQUESTED_FIELDS,
    limit: String(limit),
  });
  if (opts.year) params.set('year', opts.year);
  if (opts.fieldsOfStudy) params.set('fieldsOfStudy', opts.fieldsOfStudy);

  const url = BASE_URL + '/paper/search?' + params.toString();
  const json = await httpGet(url, opts.apiKey);

  if (!json || !Array.isArray(json.data)) return [];

  return json.data.map(function (p) {
    return {
      paperId: p.paperId,
      title: p.title || '',
      authors: Array.isArray(p.authors)
        ? p.authors.map(function (a) { return a.name; })
        : [],
      year: p.year || null,
      url: p.url || null,
      abstract: truncateAbstract(p.abstract, 200),
      citationCount: p.citationCount != null ? p.citationCount : 0,
    };
  });
}

module.exports = { searchPapers, buildQuery };

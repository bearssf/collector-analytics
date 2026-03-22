# Product backlog (post–core solid)

Reference list for deferred and in-flight work. **Do not put API keys in this file** — use environment variables (e.g. `SEMANTIC_SCHOLAR_API_KEY`).

## Phases (vision alignment)

| # | Item | Notes |
|---|------|--------|
| 6 | Feedback persistence | DB + API for suggestions (category, text, open / applied / ignored, optional anchor). Bedrock and scoring consume this. |
| 7 | AWS Bedrock | Server route, debounced per-paragraph review + Crucible context → suggestions via Phase 6 API. |
| 8 | Score strip | Right rail top: Weak / Moderate / Improving / Strong from stored counts. |
| 9 | Section-change guard | Before switching sections: citation / completeness checks in the rail (soft warning or confirm). |
| 10 | Progress awareness (center) | Word count, section status, last reviewed — middle column once shell exists. |

## Polish & features

1. **Delete project** — Portfolio: irreversible delete with explicit confirmation (implemented: `DELETE /api/projects/:id` + dashboard UI).
2. **Sidebar active state** — Only highlight the project row when in that project’s workspace (`navActive === 'workspace'` + `currentProjectId`); non-workspace pages pass `currentProjectId: null`).
3. **Anvil default font** — From project citation style (e.g. Times New Roman 12pt; IEEE 10pt).
4. **Export styling** — Font matches citation style; text always black in exports.
5. **Insert image in Anvil** — Beyond paste: explicit insert action.
6. **Export copy** — Removed whole-project hint and whole-project export links from Anvil bar; export block below save row.
7. **Crucible: Select all** — Apply a source to all sections at once. *(Done: All / None bulk actions on section checkboxes.)*
8. **Crucible: citation count badge** — Per-source in-text usage count; optional modal with cited snippets. *(Done: estimated count from draft bodies vs Anvil-style strings; modal with excerpts.)*
9. **Crucible: source sort** — Default alphabetical; toggle with date added. *(Done: dropdown + session persistence per project.)*
10. **Anvil paste** — Normalize pasted text color to white and font to style; keep other formatting.
11. **Anvil rail spacing** — Extra gap between feedback pane and citations (~1/8″).
12. **Sources: DOI** — Optional field; link in tile when present (opens in same tab). *(Done: `sources.doi`, Crucible add/edit + card link, Anvil rail link.)*
13. **Related articles** — Semantic Scholar first (respect **1 req/s** global limit; queue or throttle app-wide); Bedrock fallback when over limit. Key: header `x-api-key`. Docs: [product API](https://www.semanticscholar.org/product/api#api-key-form), [relevance search](https://api.semanticscholar.org/api-docs/#tag/Paper-Data/operation/get_graph_paper_relevance_search). *(Done: `GET /api/projects/:id/related-reading`, Crucible “Get suggestions”, `lib/semanticScholar.js` + `lib/relatedArticles.js`; see [semantic-scholar.md](./semantic-scholar.md).)*

## Semantic Scholar integration notes

- Rate limit: **one successful request per second** cumulative across endpoints; implement a client-side limit **below** 1/s if possible.
- Configure **`SEMANTIC_SCHOLAR_API_KEY`** in `.env` / host secrets only.

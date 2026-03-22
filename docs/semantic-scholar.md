# Semantic Scholar (related reading on The Crucible)

The Crucible **Related reading** action calls **`GET /api/projects/:projectId/related-reading`**, which:

1. Builds a **single** search string from the project’s **name** (or **publishing title** when set) plus short snippets from up to five sources.
2. Calls the **Semantic Scholar Graph API** paper search (`/graph/v1/paper/search`) with a **process-wide** minimum gap of **~1.1s** between completed requests so the app stays under the public **1 request/second** guideline.
3. If no papers are returned or the request fails, and **AWS Bedrock** is configured, the server asks the model for **search queries** (not invented paper metadata) that the user can open as Semantic Scholar search links.

## Configuration

| Variable | Purpose |
|----------|---------|
| `SEMANTIC_SCHOLAR_API_KEY` | Optional. Sent as `x-api-key` if set. Semantic Scholar documents a public key on their site; you can also obtain your own. |

See also [product-backlog.md](./product-backlog.md) (Semantic Scholar notes).

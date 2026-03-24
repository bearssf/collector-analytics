# The Anvil — workspace

Route: **`/app/project/:projectId/anvil`** — **anchor-based structured AI feedback** (see [ai-feedback-system-spec.md](./ai-feedback-system-spec.md)).

- **API:** `POST /api/projects/:projectId/sections/:sectionId/review-structured` — returns `{ items }` from Bedrock; **does not** write to `anvil_suggestions`.
- **Data:** Uses the same `project_sections.body` as The Crucible (same drafts).

## Behavior

1. **First review:** After you pause typing, the client waits **`ANVIL_INITIAL_IDLE_MS`** (default `1800`; legacy **`ANVIL2_INITIAL_IDLE_MS`** still read) then calls Bedrock.
2. **Fingerprint:** After a successful review (or after **Apply**), the client records a short fingerprint on `#anvil-root` (`data-fp-chars` = plain-text length) and resets the incremental edit counter. Apply uses Quill `silent` edits so it does **not** trigger another review.
3. **Later reviews:** Driven by **character edits** (`ANVIL_INCREMENTAL_CHARS` / legacy `ANVIL2_*`), not idle time. A minimum interval (`22s` client-side) applies between calls.

## Environment (Render / `.env`)

| Variable | Meaning | Default |
|----------|---------|---------|
| `ANVIL_INITIAL_IDLE_MS` | Milliseconds to wait after typing stops before the **first** Bedrock call | `1800` |
| `ANVIL_INCREMENTAL_CHARS` | Net character change after the first review before another call | `40` |

Legacy names **`ANVIL2_INITIAL_IDLE_MS`** and **`ANVIL2_INCREMENTAL_CHARS`** are still supported.

Bookmarks to **`/anvil2`** redirect to **`/anvil`** (301).

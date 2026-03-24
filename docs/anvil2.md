# The Anvil (beta) — `anvil2`

Parallel workspace at **`/app/project/:projectId/anvil2`** for experimenting with **anchor-based structured AI feedback** without changing the classic Anvil.

- **Spec:** [ai-feedback-system-spec.md](./ai-feedback-system-spec.md)
- **API:** `POST /api/projects/:projectId/sections/:sectionId/review-structured` — returns `{ items }` from Bedrock; **does not** write to `anvil_suggestions`.
- **Data:** Uses the same `project_sections.body` as the classic Anvil (same drafts).

## Behavior (beta)

1. **First review:** After you pause typing, the client waits **`ANVIL2_INITIAL_IDLE_MS`** (default `1800`) then calls Bedrock. The right rail shows loading; results replace any empty state.
2. **Fingerprint:** After a successful review (or after **Apply**), the client records a short fingerprint on `#anvil2-root` (`data-fp-chars` = plain-text length) and resets the incremental edit counter. Apply uses Quill `silent` edits so it does **not** trigger another review.
3. **Later reviews:** Further Bedrock calls are driven by **character edits** (`ANVIL2_INCREMENTAL_CHARS`, default `40`), not by idle time. A minimum interval (`22s` client-side) still applies between any two calls to limit cost.
4. **Incremental UI:** Follow-up requests show a small **“Analyzing new text…”** banner above the editor only; existing suggestion cards stay. New items are **prepended** (newest at the top). IDs already present are skipped.
5. **Stale anchors:** If a suggestion no longer matches the draft, that row is **removed** (no “conflicted” tile).

## Environment (Render / `.env`)

| Variable | Meaning | Default |
|----------|---------|---------|
| `ANVIL2_INITIAL_IDLE_MS` | Milliseconds to wait after typing stops before the **first** Bedrock call | `1800` |
| `ANVIL2_INCREMENTAL_CHARS` | Net character change (insert + delete, per Quill delta) after the first review before another call | `40` |

To remove the experiment: delete the `anvil2` route and related files; keep or drop `review-structured` and `bedrockStructuredReview.js` as needed.

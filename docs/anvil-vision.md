# The Anvil — product vision

**Status:** Vision / roadmap. The live app today ships a **per-section plain-text draft** with autosave (`project_sections.body`). This document captures the intended **full writing workspace** so design and implementation can align incrementally.

---

## Role in the workflow

- The Anvil is the **writing** portion of the application, reachable from the left menu.
- It is where **thinking becomes writing**: not only a text editor, but a capability that helps the user **explore what they are writing** and stay **aware of progress**.

---

## Layout (three-stage project view)

On the Anvil page, target a **three-stage layout**:

| Region | Purpose |
|--------|---------|
| **Left** | Navigation (existing app sidebar / section navigation within the project). |
| **Center** | **Writing stage** — the main document editor. |
| **Right** | **Feedback & citation canvas**, split vertically: **top half** — feedback and suggestions; **bottom half** — citations and sources. |

*(Today, the app uses a shared **insight** column for short hints; the vision replaces/extends that on the Anvil route with the structured right-hand canvas above.)*

---

## Center: document editor

The middle section should behave as a **document editor** with common expectations:

- Text formatting, fonts, grammar and spell check, bullets, margins, line spacing, copy/paste.
- **Save** explicitly and/or **auto-save** (autosave exists today for plain text; rich content will need a storage model decision).
- **Export** to Word, plain text, and other common formats.

---

## Right canvas: feedback & suggestions (top)

### Document score (top of panel)

Score how many issues are **identified vs unresolved**. Categories: **logic**, **evidence**, **citations**, **APA/formatting**.

Suggested banding (from product notes):

| Condition | Label |
|-----------|--------|
| More unresolved than resolved in a category | **Weak** |
| Unresolved ≈ resolved | **Moderate** |
| Recent user update, but still **> 25%** feedback/suggestions outstanding | **Improving** |
| No unaddressed feedback/suggestions | **Strong** |

### AI review (AWS Bedrock)

- After **each paragraph** is written, run a review using **AWS Bedrock**, model **Claude Sonnet 4** (per product spec; exact model id may track AWS naming).
- Review surfaces in the **suggestion/feedback** area (top of right canvas): sound logic, evidence where needed (using the user’s **Crucible** notes/sources), clarity, fit with the developing narrative.
- User **resolves** feedback by: applying a suggestion, using an **ignore** control, or equivalent — counted as **resolved**.

### Section completion

- Before moving to a **new section**, scan the current section for **proper citation** (cross-check user notes/sources from Crucible); surface misses in the right canvas.

---

## Right canvas: citations (bottom)

- List sources **attributed to the current section** (attribution originates from the **Crucible**).
- Display as **reference-formatted** entries in scrollable boxes.
- While writing, user can **select a source** to insert an **in-text citation** in the project’s chosen style (**APA, MLA, Chicago, Turabian, IEEE** — aligned with project setup).

---

## Project lifecycle: export

- Users can **upload a document** during **project creation** (current or planned constraint).
- At **project close**, users should be able to **download** the work as **Word** or another common format (not only at creation).

---

## Implementation notes (for engineering)

- **Crucible ↔ Anvil:** shared project citation style, section-linked sources, and `source_sections` (or successor) are prerequisites for attribution and insert-citation flows.
- **Bedrock:** requires AWS account, IAM, model access, and secure server-side calls (no long-lived keys in the browser).
- **Rich editor:** choose storage (HTML, Markdown, blocks) and migration from plain `body` if needed.
- **Right column:** may start as an Anvil-specific layout vs the generic `app-insight-panel` partial.

---

*Last captured from product notes; revise as decisions are made.*

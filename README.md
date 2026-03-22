# AcademiqForge

Single-page home with centered logo, email/password sign-in, and registration backed by **Azure SQL / Microsoft SQL Server**. Intended to deploy on [Render](https://render.com) (Node) with the repository: **[bearssf/AcademiqForge](https://github.com/bearssf/AcademiqForge)**.

## Local setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and a strong `SESSION_SECRET`.
3. Run:
   ```bash
   npm start
   ```
4. Open **http://localhost:3000**.

Store database credentials only in environment variables or your host’s secret store—never commit them to git.

## Stripe (subscriptions)

Used for **Upgrade to member** on **Account** and **`subscriptions`** rows (`status`, Stripe IDs, `current_period_end`).

1. In the [Stripe Dashboard](https://dashboard.stripe.com), create a **Product** and recurring **Prices** (e.g. monthly + yearly). Copy each Price ID (`price_...`).
2. Add API keys and webhook secret to your environment (see `.env.example`):
   - **`STRIPE_SECRET_KEY`** — Secret key (`sk_test_...` or `sk_live_...`).
   - **`STRIPE_PUBLISHABLE_KEY`** — Publishable key only (`pk_test_...` / `pk_live_...`, **not** the secret `sk_...`). When set (with the variables below), **Account** sends users to **`/billing/subscribe`** so they pay **on your site** via Stripe [Payment Element](https://stripe.com/docs/payments/payment-element) (card data still stays with Stripe). If omitted or invalid, **Account** uses hosted **Stripe Checkout** at **`/billing/checkout`** (redirect to `stripe.com`). The value must start with **`pk_`** (quotes around the value in Render are OK). Aliases also read: **`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`**, **`VITE_STRIPE_PUBLISHABLE_KEY`**, **`STRIPE_PUBLIC_KEY`**.
   - **Pricing (pick one style):**
     - **Two options on Account:** **`STRIPE_PRICE_MONTHLY`** and **`STRIPE_PRICE_YEARLY`** — both required; users choose Monthly or Yearly.
     - **Single option:** **`STRIPE_PRICE_ID`** only — one “Upgrade to member” button (backward compatible).
   - **`PUBLIC_BASE_URL`** — Public origin of this app **with no trailing slash**, e.g. `https://your-app.onrender.com`. Used for return URLs after payment and for Checkout when the publishable key is not set.
3. **Promotion codes (membership discounts):** Create **Coupons** and **Promotion codes** in the Stripe Dashboard. Hosted Checkout shows a promo field automatically; on-site subscribe at **`/billing/subscribe`** includes **Apply** for a code. **Registration** (`/register`) can optionally send new users to subscribe after signup. See [docs/stripe-promotion-codes.md](./docs/stripe-promotion-codes.md).

4. **Webhooks:** Add endpoint **`POST /webhooks/stripe`**. For production, use your real `PUBLIC_BASE_URL` + `/webhooks/stripe`. Subscribe to at least:
   - `checkout.session.completed` (hosted Checkout only)
   - `customer.subscription.created` (on-site subscribe flow — syncs incomplete → active)
   - `customer.subscription.updated`
   - `customer.subscription.deleted`  
   Copy the **Signing secret** into **`STRIPE_WEBHOOK_SECRET`**.
5. **Local testing:** Install [Stripe CLI](https://stripe.com/docs/stripe-cli), run `stripe listen --forward-to localhost:3000/webhooks/stripe`, and paste the CLI webhook secret into **`STRIPE_WEBHOOK_SECRET`** for that session.
6. **Customer Portal (manage subscription):** In the [Stripe Dashboard → Customer portal](https://dashboard.stripe.com/settings/billing/portal), **activate** the portal and choose allowed actions (e.g. cancel subscription, update payment method, view invoices). After a member has a Stripe customer ID (stored in **`subscriptions.stripe_customer_id`**), **Account** shows **Manage billing**, which opens **`GET /billing/portal`** and returns them to **`/app/account?billing=portal_return`**.

**Troubleshooting on-site billing:** After deploy, check Render **Logs** on boot: you should see `Stripe: on-site billing enabled` when **`STRIPE_PUBLISHABLE_KEY`** is recognized. If you see `hosted Checkout only`, the publishable key was not loaded (wrong name, wrong service, or value not starting with `pk_`). On **Account**, use **View page source** and look for `<!-- billing: subscribe-on-site -->` vs `checkout-redirect`.

Successful payment sets `subscriptions.status` to **`active`** (unlocks The Foundry). Canceled / unpaid subscriptions map to **`canceled`** (or **`past_due`** when applicable).

## Render

1. Create a **Web Service** connected to this repo, runtime **Node**, build `npm ci`, start `npm start`.
2. Set the same environment variables as in `.env.example`. Use `NODE_ENV=production` so session cookies use `Secure` behind HTTPS.
3. **Azure SQL networking (required):**
   - In **Azure Portal** → your **SQL server** (logical server, not only the database) → **Networking**:
     - Set **Public network access** to **Enabled** (Render connects over the public internet unless you use a complex private setup).
     - Under **Firewall rules**, add the **IPv4 ranges** from your Render web service: **Render Dashboard** → open the service → **Outbound** tab. For each CIDR (e.g. `74.220.48.0/24`), add a rule with **Start IP** = first address and **End IP** = last address in that range.
   - The toggle **“Allow Azure services and resources to access this server”** only helps *other Azure* services, **not** Render— you still need explicit firewall rules for Render’s outbound IPs.
   - If the deploy log shows `Failed to connect ... in 15000ms` / timeout, that is almost always **firewall or public access**, not a wrong password (wrong passwords usually fail with a login error quickly).

4. Optional: use this repo’s `render.yaml` as a [Blueprint](https://render.com/docs/infrastructure-as-code) and fill in secret values in the dashboard.
5. **Sessions (recommended in production):** Add a **Redis** instance (Render Redis or any `redis://` / `rediss://` URL) and set **`REDIS_URL`** on the web service. Without it, the app uses in-memory sessions (logins can reset on deploy or with more than one instance).

## Data model & REST API

On startup the app creates (if missing): **`subscriptions`** (Stripe IDs, `current_period_end`, **`cancel_at_period_end`**, trial / status), **`projects`** (optional **`purpose_other`** when purpose is Other), **`project_sections`** (including optional **`body`** draft text per section, **`progress_percent`** for section weights on custom “Other” templates), **`sources`**, **`source_sections`**. Templates for new projects live in `data/project-templates.json` (non-deprecated keys are listed in the Forge UI).

**Session:** Sign in with the same browser session cookie. From JavaScript, call APIs with `fetch(url, { credentials: 'same-origin' })`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/me` | Profile fields, subscription row, computed `appAccess` |
| PATCH | `/api/me` | Update profile: `title`, `firstName`, `lastName`, `university`, `researchFocus`, `preferredSearchEngine` (email not changeable here) |
| POST | `/api/me/password` | `currentPassword`, `newPassword`, `confirmPassword` |
| GET | `/api/templates` | Available `templateKey` values + labels |
| GET | `/api/projects` | List projects for the signed-in user |
| POST | `/api/projects` | Body: `name`, `purpose`, `citationStyle`, `templateKey`; optional `purposeOther` (when purpose is Other); for `templateKey` **`other`**, `otherSectionTitle` / `otherSectionPercent` arrays (1–15 rows, **100%** total). |
| GET | `/api/projects/:id` | Project + sections + `sourceCount` |
| PATCH | `/api/projects/:id` | `name`, `purpose`, `citationStyle`, `purposeOther`; `otherSections` or `otherSectionsJson` for **`other`** template (section `id`, `title`, `progressPercent`); plus `status`, publishing\* fields. **`template_key`** is not changeable. |
| PATCH | `/api/projects/:id/sections/:sectionId` | `status`, `progressPercent`, `title`, `body` (draft: **HTML** from the Anvil rich editor, or legacy plain text; `NVARCHAR(MAX)`) |
| GET | `/api/projects/:id/export?format=txt` or `?format=docx` | Download **whole project** as plain text or Word; uses **saved** section bodies from the database. |
| POST | `/api/projects/:id/sections/:sectionId/export-docx` | Body `{ "html", "title" }` — build **.docx** for **this section** from current editor HTML (e.g. Anvil). Returns binary. |
| GET | `/api/projects/:id/sections/:sectionId/suggestions` | Anvil feedback rows for the section (`status`: `open` \| `applied` \| `ignored`; categories: `logic`, `evidence`, `citations`, `format`) |
| POST | `/api/projects/:id/sections/:sectionId/suggestions` | Single: `{ "category", "body", "anchorJson"? }`. Batch: `{ "suggestions": [ { "category", "body", "anchorJson"? }, ... ] }`. Returns `{ suggestions: [...] }`. |
| PATCH | `/api/projects/:id/suggestions/:suggestionId` | `{ "status": "applied" \| "ignored" }` — resolves an open suggestion. |
| POST | `/api/projects/:id/sections/:sectionId/review` | Body optional `{ "html" }` (defaults to saved section body). Calls **Amazon Bedrock** (Claude on Bedrock) and appends suggestions. Requires `AWS_REGION`, IAM credentials, and **`BEDROCK_INFERENCE_PROFILE_ARN` or `BEDROCK_MODEL_ID`** (many Claude models need an inference profile — see [docs/aws-bedrock.md](docs/aws-bedrock.md)). Returns `{ suggestions, inserted, skipped, bedrockConfigured }`. |
| GET | `/api/projects/:id/sources` | Sources with `sectionIds` |
| POST | `/api/projects/:id/sources` | `citationText`, `notes`, optional `sectionIds[]` |
| PATCH | `/api/sources/:id` | Update source and/or replace `sectionIds` |
| DELETE | `/api/sources/:id` | Remove source |
| POST | `/api/billing/subscription-intent` | Signed-in only. JSON body `{ "interval": "month" \| "year" }` when both prices are set. Returns `{ clientSecret }` for Stripe.js (on-site subscribe page). |
| POST | `/api/billing/subscription/cancel-at-period-end` | Active or past-due member with a Stripe subscription: sets `cancel_at_period_end` via Stripe; DB updated from the returned subscription. |
| POST | `/api/billing/subscription/resume` | Clears `cancel_at_period_end` (resume auto-renewal). Same eligibility as cancel-at-period-end. |
| POST | `/api/billing/subscription/plan` | Dual price mode only. Body `{ "interval": "month" \| "year" }` — `subscriptions.update` with proration; DB synced. Yearly → monthly only within **30 days** of `current_period_end`. |
| POST | `/api/billing/subscription/plan/preview` | Same eligibility as plan change. Body `{ "interval": "month" \| "year" }`. Returns Stripe **upcoming invoice** summary (`amountDue`, `amountDueFormatted`, `currency`, `total`, `totalFormatted`) — estimate only. |
| POST | `/api/billing/setup-intent` | Creates a Stripe SetupIntent; returns `{ clientSecret, setupIntentId }` for **Update payment method** (`STRIPE_PUBLISHABLE_KEY` required). |
| POST | `/api/billing/setup-intent/complete` | Body `{ "setupIntentId" }` — sets default payment method on the customer and subscription after a succeeded SetupIntent. |

**Purposes:** Academic Assignment, Academic Publication, Conference, Dissertation/Thesis, Other. **Citation styles:** APA, MLA, Chicago, Turabian, IEEE.

**Foundry access:** `appAccess.foundryUnlocked` is true only when `subscriptions.status = 'active'` (paid via Stripe webhook or `DEV_SUBSCRIPTION_PAID`). Trial rows use `status = 'trialing'` with `trial_end`. Set `DEV_SUBSCRIPTION_PAID=true` locally to simulate paid UI without Stripe.

## Features

- **Billing:** **Account** → subscribe via **`/billing/subscribe`** or **`/billing/checkout`**; **update payment method** on **`/billing/payment-method`** (SetupIntent + Payment Element when **`STRIPE_PUBLISHABLE_KEY`** is set); **auto-renew**; **monthly/yearly plan change** with **proration estimate** (dual prices; yearly → monthly only near renewal); **`GET /billing/portal`** for Stripe portal (invoices, etc.). **`POST /webhooks/stripe`** updates `subscriptions` (see **Stripe** section above).
- **The Crucible** (`/app/project/:id/crucible`): list, add, edit, and delete sources; link each source to outline sections via the REST API (`fetch` with `credentials: 'same-origin'`).
- **The Anvil** (`/app/project/:id/anvil`): **Quill** rich-text drafts (HTML in `project_sections.body`); plain-text drafts are migrated to paragraphs on load. **Center progress** (words, section status, last AI review); autosave; **section-switch guard**; **split rail** — score strip, feedback (Bedrock, Apply/Ignore), citations; **export** — [Anvil vision](docs/anvil-vision.md). **AWS Bedrock:** [docs/aws-bedrock.md](docs/aws-bedrock.md).
- **Framework** (`/app/project/:id/framework`): placeholder (“coming soon”) until outline/evidence UX is defined.
- **Home:** Marketing landing + sign-in; **Workspace** (`/app/dashboard`) when signed in.
- **Header (signed out):** Email and password, Sign in, and **Create an account** below.
- **Header (signed in):** **Welcome, [first name]** and Sign out (login UI hidden).
- **Account** (`/app/account`): Edit profile (same fields as registration; email read-only) and change password (**Show/Hide** on each password field); subscription and billing (see **Billing**). After hosted Checkout success (`?subscription=success`), the URL is cleaned up, copy explains webhook delay, and the page **polls** `/api/me` until membership is active (with a **refresh status** control).
- **Workspace shell** (`body.app-body--workspace-shell` on dashboard, project workspace, and on-site billing pages with an insight column): the **left sidebar** and **right insight** column stay in view; **only the center canvas** scrolls when content is tall (e.g. Anvil, Crucible). The Account page uses a two-column grid and scrolls with the window.
- **Registration:** Title (Mr., Mrs., Ms., Miss, Mx., Dr.), first/last name, email, password + confirmation; optional university (datalist of US institutions + free text), research focus, preferred search engine (preset list including “Other/University Specific”).
- Passwords hashed with **bcrypt**. On first connection, the app ensures a `users` table and profile columns exist in your database.

## Billing maintenance track (on-site)

Work to keep **subscription management on AcademiqForge** (API + your UI), similar to on-site subscribe vs hosted Checkout. Parts:

1. **Subscription summary on Account** — **Status**, **Plan** (Monthly/Yearly when env price IDs match the stored `subscriptions.plan` prefix), **Next renewal** / **Trial ends** / period dates from the DB (`lib/billingAccountDisplay.js`). *(Shipped.)*
2. **Cancel at period end / resume** — `POST /api/billing/subscription/cancel-at-period-end` and `/resume`; **`subscriptions.cancel_at_period_end`** synced from Stripe webhooks and subscription objects. *(Shipped.)*
3. **Invoice list** — not shown on Account; use **Manage billing** (Stripe Customer Portal) for invoices. *(By design.)*
4. **Update payment method** — SetupIntent + Payment Element on **`/billing/payment-method`**; **`POST /api/billing/setup-intent`** + **`/complete`**; 3DS return **`GET /billing/payment-method/return`**. *(Shipped.)*
5. **Plan change (month ↔ year, proration)** — `POST /api/billing/subscription/plan` + **`/plan/preview`** (upcoming invoice via `lib/billingPlanPreview.js`); `subscriptions.update` with `create_prorations` (`lib/billingPlanChange.js`); Account shows **estimated amount due** when switching monthly → yearly; **yearly → monthly** only within **30 days** of period end. *(Shipped.)*

## The Anvil (vision)

The shipped Anvil is a **section draft editor with autosave**. The full **writing workspace** vision — three-stage layout (nav | editor | feedback + citations), rich document editing, **AWS Bedrock**-assisted review (e.g. Claude), scoring, Crucible-linked citations, and export — is documented in **[`docs/anvil-vision.md`](docs/anvil-vision.md)**.

## Backlog

- **The Anvil:** Implement the [Anvil vision](docs/anvil-vision.md) incrementally (rich editor, right-hand feedback/citation canvas, Bedrock review, scoring, export) — see doc for scope and engineering notes.
- **Account / billing:** **Manage billing** uses Stripe [Customer Portal](https://stripe.com/docs/customer-management) (`GET /billing/portal`) for invoices and other Stripe-hosted actions. On-site: subscription summary, auto-renew, payment method, and plan change (dual prices) per **Billing maintenance track**.
- **User management:** **Profile edit** and **password change** are on **Account** (`PATCH /api/me`, `POST /api/me/password`). **Email** change / verification — not started (would require a verified flow and Stripe sync if billing email must match).

## Repository

```bash
git remote add origin https://github.com/bearssf/AcademiqForge.git
```

Push your branch after configuring remotes and authentication with GitHub.

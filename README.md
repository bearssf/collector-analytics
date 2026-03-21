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

Used for **Upgrade to member** on **Account** (`/billing/checkout`) and **`subscriptions`** rows (`status`, Stripe IDs, `current_period_end`).

1. In the [Stripe Dashboard](https://dashboard.stripe.com), create a **Product** and **recurring Price** (monthly or yearly). Copy the Price ID (`price_...`).
2. Add API keys and webhook secret to your environment (see `.env.example`):
   - **`STRIPE_SECRET_KEY`** — Secret key (`sk_test_...` or `sk_live_...`).
   - **`STRIPE_PRICE_ID`** — The recurring price ID checkout should charge.
   - **`PUBLIC_BASE_URL`** — Public origin of this app **with no trailing slash**, e.g. `https://your-app.onrender.com`. Used for Checkout success/cancel URLs.
3. **Webhooks:** Add endpoint **`POST /webhooks/stripe`**. For production, use your real `PUBLIC_BASE_URL` + `/webhooks/stripe`. Subscribe to at least:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`  
   Copy the **Signing secret** into **`STRIPE_WEBHOOK_SECRET`**.
4. **Local testing:** Install [Stripe CLI](https://stripe.com/docs/stripe-cli), run `stripe listen --forward-to localhost:3000/webhooks/stripe`, and paste the CLI webhook secret into **`STRIPE_WEBHOOK_SECRET`** for that session.

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

## Data model & REST API

On startup the app creates (if missing): **`subscriptions`** (trial / future Stripe fields), **`projects`**, **`project_sections`** (including optional **`body`** draft text per section), **`sources`**, **`source_sections`**. Templates for new projects live in `data/project-templates.json`.

**Session:** Sign in with the same browser session cookie. From JavaScript, call APIs with `fetch(url, { credentials: 'same-origin' })`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/me` | Current user, subscription row, computed `appAccess` |
| GET | `/api/templates` | Available `templateKey` values + labels |
| GET | `/api/projects` | List projects for the signed-in user |
| POST | `/api/projects` | Body: `name`, `purpose`, `citationStyle`, `templateKey` — creates project + sections |
| GET | `/api/projects/:id` | Project + sections + `sourceCount` |
| PATCH | `/api/projects/:id` | Partial update (name, status, publishing\* fields) |
| PATCH | `/api/projects/:id/sections/:sectionId` | `status`, `progressPercent`, `body` (draft text, `NVARCHAR(MAX)`) |
| GET | `/api/projects/:id/sources` | Sources with `sectionIds` |
| POST | `/api/projects/:id/sources` | `citationText`, `notes`, optional `sectionIds[]` |
| PATCH | `/api/sources/:id` | Update source and/or replace `sectionIds` |
| DELETE | `/api/sources/:id` | Remove source |

**Purposes:** Dissertation, Academic Publication, Thesis, Essay, Report, Conference Document, Other. **Citation styles:** APA, MLA, Chicago, Turabian, IEEE.

**Foundry access:** `appAccess.foundryUnlocked` is true only when `subscriptions.status = 'active'` (paid via Stripe webhook or `DEV_SUBSCRIPTION_PAID`). Trial rows use `status = 'trialing'` with `trial_end`. Set `DEV_SUBSCRIPTION_PAID=true` locally to simulate paid UI without Stripe.

## Features

- **Billing:** **Account** → **Upgrade to member** opens Stripe Checkout (`/billing/checkout`); **`POST /webhooks/stripe`** updates `subscriptions` from Stripe events (see **Stripe** section above).
- **The Crucible** (`/app/project/:id/crucible`): list, add, edit, and delete sources; link each source to outline sections via the REST API (`fetch` with `credentials: 'same-origin'`).
- **The Anvil** (`/app/project/:id/anvil`): per-section draft editor with autosave; drafts persist in `project_sections.body`.
- **Framework** (`/app/project/:id/framework`): placeholder (“coming soon”) until outline/evidence UX is defined.
- **Home:** Marketing landing + sign-in; **Workspace** (`/app/dashboard`) when signed in.
- **Header (signed out):** Email and password, Sign in, and **Create an account** below.
- **Header (signed in):** **Welcome, [first name]** and Sign out (login UI hidden).
- **Registration:** Title (Mr., Mrs., Ms., Miss, Mx., Dr.), first/last name, email, password + confirmation; optional university (datalist of US institutions + free text), research focus, preferred search engine (preset list including “Other/University Specific”).
- Passwords hashed with **bcrypt**. On first connection, the app ensures a `users` table and profile columns exist in your database.

## Repository

```bash
git remote add origin https://github.com/bearssf/AcademiqForge.git
```

Push your branch after configuring remotes and authentication with GitHub.

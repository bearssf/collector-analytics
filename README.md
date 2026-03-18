# CollectorAnalytics

Home page with centered logo and user login/registration backed by SQL Server.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and set your database credentials: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`.
3. Run the server:
   ```bash
   npm start
   ```
4. Open **http://localhost:3000** in your browser.

## Features

- **Home:** Centered CollectorAnalytics logo; login form (email, password, sign in) and “Create an account” link in the upper right.
- **Logged in:** “Subscribe” or “Members” link (depending on subscription), “Welcome, [First Name]”, and sign out.
- **Registration:** First name, last name, email, password (all required). After signup, user is logged in and redirected to the home page.
- **Subscriptions:** Members can subscribe at $9.99/month or $99.99/year (Stripe) to access the members-only area.
- **Members area:** `/members` — only accessible with an active subscription.

Passwords are hashed with bcrypt. Subscription state is stored in the `subscriptions` table and kept in sync via Stripe webhooks.

### Stripe setup (subscriptions)

1. Create a [Stripe](https://stripe.com) account and get your **Secret key** (Dashboard → Developers → API keys).
2. Create two **Products** with recurring **Prices**: one $9.99/month, one $99.99/year. Copy each Price ID (starts with `price_`).
3. In `.env` set: `STRIPE_SECRET_KEY`, `STRIPE_MONTHLY_PRICE_ID`, `STRIPE_YEARLY_PRICE_ID`.
4. For production: add a **Webhook** endpoint (e.g. `https://your-app.onrender.com/webhooks/stripe`) listening for `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Set `STRIPE_WEBHOOK_SECRET` to the signing secret. Set `BASE_URL` to your app URL for checkout redirects.

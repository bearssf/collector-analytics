# Membership discount codes (Stripe)

Discounts use **Stripe Coupons** and **Promotion codes** (created in the [Stripe Dashboard](https://dashboard.stripe.com/coupons)).

## Setup

1. **Products → Coupons** — Create a coupon (percent off, amount off, duration, applicable products if needed).
2. **Promotion codes** — Add a customer-facing code (e.g. `LAUNCH25`) linked to that coupon. Set usage limits and expiry as needed.

No extra environment variables are required; valid codes are resolved live via the Stripe API.

## Where codes work

| Flow | Behavior |
|------|------------|
| **Hosted Checkout** (`/billing/checkout` when publishable key is not used) | Stripe Checkout shows a **Promotion code** field (`allow_promotion_codes: true`). |
| **On-site Payment Element** (`/billing/subscribe`) | User enters a code in **Promotion code** and clicks **Apply** before paying. The server validates the code against Stripe and attaches it to the new subscription. |
| **Prefill / campaigns** | Link users to `/billing/subscribe?promo=YOURCODE` (and `&interval=year` if needed) to prefill the field. |
| **Create account** | On **`/register`**, users can choose **Subscribe as a member now** (with monthly/yearly when dual prices exist) and an optional promotion code, then continue to Checkout or the on-site subscribe page after the account is created. |

## Operations notes

- Codes must be **active** in Stripe and match **case-insensitively** (Stripe’s API behavior).
- Applying a different code or clearing and re-applying cancels **incomplete** checkout subscriptions for that customer so you don’t stack abandoned subs.
- Restrictions (first-time order, minimum amount, etc.) are enforced by **Stripe** on the coupon/promotion code settings.

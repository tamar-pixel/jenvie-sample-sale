# Sample-Sale Platform

A timed sample-sale drop tool: sellers upload one-of-one pieces, shoppers claim and pay
through Stripe, and inventory marks "sold" in real time. Built to run your own sale first,
with multi-seller + Stripe Connect take-rate wired in and gated behind config.

- **Shopper page:** `/s/:slug` (e.g. `/s/jenvie`)
- **Seller dashboard:** `/admin/:slug`
- Node/Express + Postgres + Stripe. Deploys to Railway.

---

## Run it locally (no accounts needed)

```bash
npm install
cp .env.example .env      # leave DATABASE_URL and Stripe keys blank for now
npm start
```

Open http://localhost:3000 — it seeds a "J'envie" sale automatically. With no database it
uses a JSON dev-store (`data/store.json`); with no Stripe keys the upload/inventory work but
checkout is disabled. Good enough to click around the seller + shopper flows.

---

## Deploy to Railway (the real thing)

1. **Push this folder to a GitHub repo.**
2. On [railway.app](https://railway.app): **New Project → Deploy from GitHub repo** → pick it.
3. **Add a database:** in the project, **New → Database → PostgreSQL**. Railway sets
   `DATABASE_URL` automatically — the app creates its tables on first boot.
4. **Set variables** (project → Variables):
   - `PUBLIC_URL` = your Railway URL (e.g. `https://yoursale.up.railway.app`)
   - `STRIPE_SECRET_KEY` = from https://dashboard.stripe.com/apikeys (test key first)
   - `PLATFORM_FEE_BPS` = `0` for your own sale (keep 100%)
5. **Stripe webhook:** in Stripe → Developers → Webhooks → Add endpoint
   `https://YOUR-URL/api/webhook`, event `checkout.session.completed`. Copy the signing
   secret into `STRIPE_WEBHOOK_SECRET`.
6. Redeploy. Visit `/admin/jenvie` to load pieces, `/s/jenvie` to shop.

### Custom domain
Railway → Settings → Domains → add `sale.jenvie.com` and point the CNAME at Railway.

---

## Image storage (important for production)

Locally, photos save to `public/uploads`. **Railway wipes the disk on each deploy**, so for
production set an S3-compatible bucket (Cloudflare R2 is cheapest) via the `S3_*` variables and
swap the `saveImage()` body in `server.js` to upload the buffer to the bucket. TODO marked in code.

---

## Turning on the take-rate for other brands (later)

The Connect logic is already in `server.js` and gated:

1. Set `PLATFORM_FEE_BPS` (e.g. `1000` = 10%).
2. Each brand clicks **Connect Stripe** in their dashboard → Stripe Express onboarding
   collects their bank + identity → their `stripe_account_id` is saved.
3. From then on, their sales route the payment to them with your fee peeled off automatically
   (`application_fee_amount` + `transfer_data.destination`). Your own sale (no connected
   account) is unaffected and stays 100% yours.

---

## What's a stub / next up

- Image storage → move from local disk to R2/S3.
- Background removal & on-model → call an image API (e.g. remove.bg / Replicate) from a new
  `/api/edit` route; the front-end editor from the prototype drops in here.
- Reservation holds (10-min timer) → add a `reserved_until` column; MVP marks sold on payment.
- Seller auth → add a login before opening this beyond you.

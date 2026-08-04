/*
 * Sample-sale platform — Express server.
 * Endpoints:
 *   GET  /                         -> redirect to the default sale
 *   GET  /s/:slug                  -> public timed drop page (shop.html)
 *   GET  /admin/:slug              -> seller dashboard (admin.html)
 *   GET  /api/sales/:slug          -> { sale, seller, items }
 *   POST /api/sales/:slug/items    -> create item (multipart: photo, back?; fields)
 *   POST /api/checkout             -> create Stripe Checkout Session -> { url }
 *   POST /api/webhook              -> Stripe webhook (marks items sold, records order)
 *   POST /api/connect/onboard      -> Connect onboarding link for a seller -> { url }
 *   GET  /api/orders/:slug         -> seller's orders (door list)
 */
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const stripe = require('./lib/stripe');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS || '0', 10);

/* ---------- Stripe webhook must see the RAW body, so mount it before json() ---------- */
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(400).send('Stripe not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const itemIds = (s.metadata.item_ids || '').split(',').filter(Boolean);
    const sold = await db.markItemsSold(itemIds);
    await db.createOrder({
      sale_id: s.metadata.sale_id,
      item_ids: sold,
      email: s.customer_details?.email || s.customer_email,
      fulfillment: s.metadata.fulfillment || 'pickup',
      amount_cents: s.amount_total,
      stripe_session: s.id,
    });
    console.log(`Order ${s.id}: sold ${sold.length} item(s)`);
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- image storage (local disk MVP; swap for R2/S3 in prod) ---------- */
const UP_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UP_DIR, { recursive: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
function saveImage(file) {
  if (!file) return null;
  const ext = (file.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const name = db.newId('img') + '.' + ext;
  fs.writeFileSync(path.join(UP_DIR, name), file.buffer);
  return `/uploads/${name}`;
  // Production: upload file.buffer to S3/R2 and return the public URL instead.
}

/* ---------- pages ---------- */
app.get('/', (_req, res) => res.redirect('/s/jenvie'));
app.get('/s/:slug', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'shop.html')));
app.get('/admin/:slug', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

/* ---------- read sale + items ---------- */
app.get('/api/sales/:slug', async (req, res) => {
  const sale = await db.getSaleBySlug(req.params.slug);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  const seller = await db.getSeller(sale.seller_id);
  const items = await db.listItems(sale.id);
  res.json({ sale, seller: { id: seller.id, name: seller.name, connected: !!seller.stripe_account_id }, items });
});

/* ---------- create item ---------- */
app.post('/api/sales/:slug/items', upload.fields([{ name: 'photo' }, { name: 'back' }]), async (req, res) => {
  const sale = await db.getSaleBySlug(req.params.slug);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  const b = req.body || {};
  const item = await db.createItem({
    sale_id: sale.id,
    name: b.name || 'Sample piece',
    price_cents: Math.round(parseFloat(b.price || '25') * 100),
    fabric: b.fabric, size: b.size, color_name: b.color_name, color_hex: b.color_hex,
    image_url: saveImage(req.files?.photo?.[0]),
    back_url: saveImage(req.files?.back?.[0]),
  });
  res.json({ item });
});

/* ---------- checkout ---------- */
app.post('/api/checkout', async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured yet' });
  const { slug, itemIds = [], fulfillment = 'pickup', email } = req.body;
  const sale = await db.getSaleBySlug(slug);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  const seller = await db.getSeller(sale.seller_id);
  const items = (await db.getItemsByIds(itemIds)).filter(i => i.status === 'live');
  if (!items.length) return res.status(409).json({ error: 'Those pieces are no longer available' });

  const line_items = items.map(i => ({
    quantity: 1,
    price_data: {
      currency: 'usd',
      unit_amount: i.price_cents,
      product_data: {
        name: i.name,
        description: [i.color_name, i.fabric, i.size].filter(Boolean).join(' · '),
        images: i.image_url ? [PUBLIC_URL + i.image_url] : [],
      },
    },
  }));
  if (fulfillment === 'ship') {
    line_items.push({ quantity: 1, price_data: { currency: 'usd', unit_amount: 1200, product_data: { name: 'Shipping' } } });
  }

  const subtotal = items.reduce((s, i) => s + i.price_cents, 0);
  const session_args = {
    mode: 'payment',
    line_items,
    customer_email: email || undefined,
    success_url: `${PUBLIC_URL}/s/${slug}?paid=1`,
    cancel_url: `${PUBLIC_URL}/s/${slug}`,
    metadata: { sale_id: sale.id, item_ids: items.map(i => i.id).join(','), fulfillment },
  };

  // Connect take-rate: only when this seller has connected their own Stripe account
  // AND a platform fee is configured. For your own sale (no connected acct), you keep 100%.
  if (FEE_BPS > 0 && seller.stripe_account_id) {
    const fee = Math.round(subtotal * FEE_BPS / 10000);
    session_args.payment_intent_data = {
      application_fee_amount: fee,
      transfer_data: { destination: seller.stripe_account_id },
    };
  }

  try {
    const session = await stripe.checkout.sessions.create(session_args);
    res.json({ url: session.url });
  } catch (e) {
    console.error('Checkout error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Connect onboarding (for other brands) ---------- */
app.post('/api/connect/onboard', async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured yet' });
  const seller = await db.getSeller(req.body.sellerId);
  if (!seller) return res.status(404).json({ error: 'Seller not found' });
  let acct = seller.stripe_account_id;
  if (!acct) {
    const account = await stripe.accounts.create({ type: 'express', metadata: { seller_id: seller.id } });
    acct = account.id;
    await db.setSellerStripe(seller.id, acct);
  }
  const link = await stripe.accountLinks.create({
    account: acct,
    refresh_url: `${PUBLIC_URL}/admin/${seller.slug}`,
    return_url: `${PUBLIC_URL}/admin/${seller.slug}?connected=1`,
    type: 'account_onboarding',
  });
  res.json({ url: link.url });
});

/* ---------- orders (door list) ---------- */
app.get('/api/orders/:slug', async (req, res) => {
  const sale = await db.getSaleBySlug(req.params.slug);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  res.json({ orders: await db.listOrders(sale.id) });
});

db.init()
  .then(() => app.listen(PORT, () => console.log(`Sample-sale server on ${PUBLIC_URL} (fee ${FEE_BPS}bps, db ${process.env.DATABASE_URL ? 'postgres' : 'json-dev'})`)))
  .catch(err => { console.error('Startup failed:', err); process.exit(1); });

/*
 * Data layer. Two interchangeable backends behind one interface:
 *   - Postgres (used when DATABASE_URL is set — i.e. on Railway)
 *   - JSON dev store at data/store.json (used locally with no database)
 *
 * Tables / shapes:
 *   sellers: { id, name, slug, stripe_account_id }
 *   sales:   { id, seller_id, slug, title, ends_at }
 *   items:   { id, sale_id, name, price_cents, fabric, size, color_name, color_hex,
 *              image_url, back_url, status ('live'|'sold') }
 *   orders:  { id, sale_id, item_ids(json), email, fulfillment, amount_cents,
 *              stripe_session, created_at }
 */
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');

const USE_PG = !!process.env.DATABASE_URL;
let pool = null;

/* ---------------- helpers ---------------- */
function newId(prefix) { return prefix + '_' + nanoid(10); }

/* ---------------- JSON backend ---------------- */
const DATA_FILE = path.join(__dirname, 'data', 'store.json');
function jsonLoad() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { sellers: [], sales: [], items: [], orders: [] }; }
}
function jsonSave(db) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

/* ---------------- init + seed ---------------- */
async function init() {
  if (USE_PG) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sellers (
        id TEXT PRIMARY KEY, name TEXT, slug TEXT UNIQUE, stripe_account_id TEXT);
      CREATE TABLE IF NOT EXISTS sales (
        id TEXT PRIMARY KEY, seller_id TEXT, slug TEXT UNIQUE, title TEXT, ends_at TIMESTAMPTZ);
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, sale_id TEXT, name TEXT, price_cents INT, fabric TEXT,
        size TEXT, color_name TEXT, color_hex TEXT, image_url TEXT, back_url TEXT,
        status TEXT DEFAULT 'live', created_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, sale_id TEXT, item_ids JSONB, email TEXT, fulfillment TEXT,
        amount_cents INT, stripe_session TEXT, created_at TIMESTAMPTZ DEFAULT now());
    `);
  }
  await seedDefault();
}

// Seed J'envie as seller #1 with an open sale, if empty.
async function seedDefault() {
  const existing = await getSaleBySlug('jenvie');
  if (existing) return;
  const seller = { id: newId('sel'), name: "J'envie", slug: 'jenvie', stripe_account_id: null };
  const ends = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  const sale = { id: newId('sale'), seller_id: seller.id, slug: 'jenvie', title: 'The $25 Sample Sale', ends_at: ends };
  await _insertSeller(seller);
  await _insertSale(sale);
}

/* ---------------- sellers ---------------- */
async function _insertSeller(s) {
  if (USE_PG) await pool.query(
    'INSERT INTO sellers(id,name,slug,stripe_account_id) VALUES($1,$2,$3,$4)',
    [s.id, s.name, s.slug, s.stripe_account_id]);
  else { const db = jsonLoad(); db.sellers.push(s); jsonSave(db); }
  return s;
}
async function getSeller(id) {
  if (USE_PG) return (await pool.query('SELECT * FROM sellers WHERE id=$1', [id])).rows[0] || null;
  return jsonLoad().sellers.find(s => s.id === id) || null;
}
async function setSellerStripe(id, acct) {
  if (USE_PG) await pool.query('UPDATE sellers SET stripe_account_id=$1 WHERE id=$2', [acct, id]);
  else { const db = jsonLoad(); const s = db.sellers.find(x => x.id === id); if (s) s.stripe_account_id = acct; jsonSave(db); }
}

/* ---------------- sales ---------------- */
async function _insertSale(s) {
  if (USE_PG) await pool.query(
    'INSERT INTO sales(id,seller_id,slug,title,ends_at) VALUES($1,$2,$3,$4,$5)',
    [s.id, s.seller_id, s.slug, s.title, s.ends_at]);
  else { const db = jsonLoad(); db.sales.push(s); jsonSave(db); }
  return s;
}
async function getSaleBySlug(slug) {
  if (USE_PG) return (await pool.query('SELECT * FROM sales WHERE slug=$1', [slug])).rows[0] || null;
  return jsonLoad().sales.find(s => s.slug === slug) || null;
}

/* ---------------- items ---------------- */
async function createItem(it) {
  const row = {
    id: newId('item'), sale_id: it.sale_id, name: it.name, price_cents: it.price_cents,
    fabric: it.fabric || null, size: it.size || null, color_name: it.color_name || null,
    color_hex: it.color_hex || null, image_url: it.image_url || null, back_url: it.back_url || null,
    status: 'live',
  };
  if (USE_PG) await pool.query(
    `INSERT INTO items(id,sale_id,name,price_cents,fabric,size,color_name,color_hex,image_url,back_url,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'live')`,
    [row.id, row.sale_id, row.name, row.price_cents, row.fabric, row.size, row.color_name, row.color_hex, row.image_url, row.back_url]);
  else { const db = jsonLoad(); db.items.push(row); jsonSave(db); }
  return row;
}
async function listItems(saleId) {
  if (USE_PG) return (await pool.query('SELECT * FROM items WHERE sale_id=$1 ORDER BY created_at', [saleId])).rows;
  return jsonLoad().items.filter(i => i.sale_id === saleId);
}
async function getItemsByIds(ids) {
  if (!ids.length) return [];
  if (USE_PG) return (await pool.query('SELECT * FROM items WHERE id = ANY($1)', [ids])).rows;
  return jsonLoad().items.filter(i => ids.includes(i.id));
}
// Atomically claim: only marks items that are still 'live'. Returns the ids actually sold.
async function markItemsSold(ids) {
  if (!ids.length) return [];
  if (USE_PG) {
    const r = await pool.query(
      "UPDATE items SET status='sold' WHERE id = ANY($1) AND status='live' RETURNING id", [ids]);
    return r.rows.map(x => x.id);
  }
  const db = jsonLoad(); const sold = [];
  db.items.forEach(i => { if (ids.includes(i.id) && i.status === 'live') { i.status = 'sold'; sold.push(i.id); } });
  jsonSave(db); return sold;
}

/* ---------------- orders ---------------- */
async function createOrder(o) {
  const row = { id: newId('ord'), sale_id: o.sale_id, item_ids: o.item_ids, email: o.email || null,
    fulfillment: o.fulfillment, amount_cents: o.amount_cents, stripe_session: o.stripe_session,
    created_at: new Date().toISOString() };
  if (USE_PG) await pool.query(
    `INSERT INTO orders(id,sale_id,item_ids,email,fulfillment,amount_cents,stripe_session)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [row.id, row.sale_id, JSON.stringify(row.item_ids), row.email, row.fulfillment, row.amount_cents, row.stripe_session]);
  else { const db = jsonLoad(); db.orders.push(row); jsonSave(db); }
  return row;
}
async function listOrders(saleId) {
  if (USE_PG) return (await pool.query('SELECT * FROM orders WHERE sale_id=$1 ORDER BY created_at DESC', [saleId])).rows;
  return jsonLoad().orders.filter(o => o.sale_id === saleId);
}

module.exports = {
  init, getSaleBySlug, getSeller, setSellerStripe,
  createItem, listItems, getItemsByIds, markItemsSold,
  createOrder, listOrders, newId,
};

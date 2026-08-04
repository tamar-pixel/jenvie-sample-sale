// Thin Stripe client wrapper. Returns null when no key is set so the app still
// boots for local UI work without Stripe configured.
const Stripe = require('stripe');

const key = process.env.STRIPE_SECRET_KEY;
const stripe = key ? new Stripe(key, { apiVersion: '2024-06-20' }) : null;

module.exports = stripe;

/**
 * LeviCube Backend Server
 * Stack: Node.js + Express + Stripe + SendGrid + MongoDB
 */

require('dotenv').config();
const express   = require('express');
const mongoose  = require('mongoose');
const Stripe    = require('stripe');
const sgMail    = require('@sendgrid/mail');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const sgEnabled = process.env.SENDGRID_API_KEY?.startsWith('SG.');
if (sgEnabled) sgMail.setApiKey(process.env.SENDGRID_API_KEY);
else console.log('⚠ SendGrid disabled');

// ── Schemas ───────────────────────────────────────────────────────
const Order = mongoose.model('Order', new mongoose.Schema({
  orderNumber:   { type: String, unique: true, required: true },
  stripeSession: String,
  status:        { type: String, default: 'pending' },
  name:          { type: String, required: true },
  email:         { type: String, required: true },
  phone:         String,
  address:       String,
  city:          String,
  zip:           String,
  country:       { type: String, default: 'AT' },
  quantity:      { type: Number, default: 1 },
  discountCode:  String,
  discountPct:   { type: Number, default: 0 },
  total:         Number,
  paymentMethod: String,
  ipAddress:     String,
}, { timestamps: true }));

const Coupon = mongoose.model('Coupon', new mongoose.Schema({
  code:        { type: String, unique: true },
  discountPct: Number,
  maxUses:     { type: Number, default: 100 },
  usedCount:   { type: Number, default: 0 },
  active:      { type: Boolean, default: true },
  expiresAt:   Date,
}));

const Newsletter = mongoose.model('Newsletter', new mongoose.Schema({
  email:  { type: String, unique: true },
  source: { type: String, default: 'website' },
}, { timestamps: true }));

const Review = mongoose.model('Review', new mongoose.Schema({
  name:     String,
  stars:    { type: Number, min: 1, max: 5 },
  text:     String,
  verified: { type: Boolean, default: false },
}, { timestamps: true }));

// ── DB Init ───────────────────────────────────────────────────────
async function initDB() {
  await mongoose.connect(process.env.DATABASE_URL);
  console.log('✓ MongoDB connected');
  for (const [code, pct] of [['ASCEND10',10],['VOID20',20],['LAUNCH15',15]]) {
    await Coupon.findOneAndUpdate({ code }, { code, discountPct: pct }, { upsert: true });
  }
  console.log('✓ Coupons ready');
}

// ── Middleware ────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/api/', rateLimit({ windowMs: 15*60*1000, max: 100 }));

// ── Helpers ───────────────────────────────────────────────────────
const genOrder = () => 'LC-' + Math.random().toString(36).substring(2,8).toUpperCase();
const calcTotal = (qty, pct) => +((149*qty*(1-pct/100))+12).toFixed(2);

// ── Routes ────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok', time: new Date() }));

app.post('/api/validate-coupon', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'No code' });
  const c = await Coupon.findOne({ code: code.toUpperCase(), active: true,
    $expr: { $lt: ['$usedCount','$maxUses'] } });
  if (!c) return res.status(404).json({ error: 'Invalid code' });
  res.json({ valid: true, code: c.code, discountPct: c.discountPct });
});

app.post('/api/create-checkout-session', async (req, res) => {
  const { name, email, address, city, zip, country, quantity, couponCode } = req.body;
  if (!name || !email || !address || !city || !zip)
    return res.status(400).json({ error: 'Missing fields' });

  let discountPct = 0;
  if (couponCode) {
    const c = await Coupon.findOne({ code: couponCode.toUpperCase(), active: true });
    if (c) discountPct = c.discountPct;
  }

  const qty = Math.max(1, Math.min(10, parseInt(quantity)||1));
  const orderNumber = genOrder();

  try {
    const discounts = [];
    if (discountPct > 0) {
      const sc = await stripe.coupons.create({
        amount_off: Math.round(14900*qty*discountPct/100),
        currency: 'eur', duration: 'once'
      });
      discounts.push({ coupon: sc.id });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        { price_data: { currency:'eur', product_data:{ name:'LeviCube Gen-1' }, unit_amount:14900 }, quantity:qty },
        { price_data: { currency:'eur', product_data:{ name:'Express Versand' }, unit_amount:1200 }, quantity:1 },
      ],
      discounts,
      customer_email: email,
      success_url: `${process.env.FRONTEND_URL}?order=${orderNumber}&session={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.FRONTEND_URL}?cancelled=1`,
      metadata: { orderNumber, name, couponCode: couponCode||'' },
      locale: 'de',
    });

    await Order.create({ orderNumber, stripeSession:session.id, name, email,
      address, city, zip, country:country||'AT', quantity:qty,
      discountCode:couponCode||null, discountPct,
      total:calcTotal(qty,discountPct), ipAddress:req.ip });

    res.json({ url: session.url, orderNumber });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: 'Stripe error' });
  }
});

app.post('/webhook', async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET||''
    );
  } catch(e) { return res.status(400).send('Webhook error'); }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const { orderNumber, couponCode } = s.metadata;
    await Order.findOneAndUpdate({ orderNumber }, { status:'paid',
      paymentMethod: s.payment_method_types?.[0]||'card' });
    if (couponCode) await Coupon.findOneAndUpdate({ code:couponCode }, { $inc:{usedCount:1} });
    if (sgEnabled) await sendConfirmationEmail(orderNumber, s.customer_email||s.customer_details?.email, s.amount_total/100);
    console.log(`✓ Order ${orderNumber} paid`);
  }
  res.json({ received: true });
});

app.get('/api/order/:num', async (req, res) => {
  const o = await Order.findOne({ orderNumber:req.params.num }).select('-__v');
  if (!o) return res.status(404).json({ error: 'Not found' });
  res.json(o);
});

app.post('/api/newsletter', async (req, res) => {
  const { email, source } = req.body;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email||''))
    return res.status(400).json({ error: 'Invalid email' });
  await Newsletter.findOneAndUpdate({ email }, { email, source }, { upsert: true });
  res.json({ success: true });
});

app.get('/api/reviews', async (_, res) => {
  res.json(await Review.find().sort({ createdAt:-1 }).limit(20));
});

app.post('/api/reviews', async (req, res) => {
  const { name, stars, text } = req.body;
  if (!name||!stars||!text) return res.status(400).json({ error: 'Missing fields' });
  res.status(201).json(await Review.create({ name, stars:parseInt(stars), text }));
});

app.post('/api/return-request', async (req, res) => {
  const { orderNumber, email, reason } = req.body;
  if (!orderNumber||!email) return res.status(400).json({ error: 'Missing fields' });
  const o = await Order.findOne({ orderNumber, email });
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (sgEnabled) await sendReturnEmail(email, orderNumber, reason);
  res.json({ success: true });
});

// ── Emails ────────────────────────────────────────────────────────
async function sendConfirmationEmail(orderNumber, email, total) {
  if (!email) return;
  await sgMail.send({
    to: email,
    from: { email: process.env.FROM_EMAIL, name: 'LeviCube' },
    subject: `✓ Bestellbestätigung #${orderNumber} — LeviCube`,
    html: `<div style="max-width:580px;margin:0 auto;background:#0a0a0b;color:#e5e2e3;font-family:sans-serif;padding:40px 24px">
      <h1 style="color:#00dbe9;text-align:center;margin:0 0 32px">LeviCube</h1>
      <div style="background:#1a1a1c;border:1px solid rgba(0,240,255,.2);border-radius:16px;padding:32px;text-align:center">
        <div style="font-size:44px;margin-bottom:12px">✓</div>
        <h2 style="color:#dbfcff;margin:0 0 12px">Ascension confirmed.</h2>
        <p style="color:#b9cacb;margin:0">Bestellung <strong style="color:#00dbe9">#${orderNumber}</strong><br/>
        Gesamtbetrag: <strong style="color:#00f0ff">€${total.toFixed(2)}</strong></p>
      </div>
      <p style="color:#849495;text-align:center;margin-top:24px;font-size:13px">
        Lieferung in 2–3 Werktagen · <a href="mailto:support@levicube.at" style="color:#00dbe9">support@levicube.at</a>
      </p>
    </div>`,
  });
}

async function sendReturnEmail(email, orderNumber, reason) {
  await sgMail.send({
    to: email,
    from: { email: process.env.FROM_EMAIL, name: 'LeviCube' },
    subject: `Rücksendung #${orderNumber}`,
    text: `Rücksendung für ${orderNumber} (${reason||'k.A.'}) erhalten. DHL-Etikett folgt in 24h.`,
  });
}

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
initDB()
  .then(() => app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`)))
  .catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
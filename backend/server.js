/**
 * LeviCube Backend Server
 * Stack: Node.js + Express + Stripe + SendGrid + PostgreSQL
 *
 * SETUP:
 *   npm install express pg stripe @sendgrid/mail cors helmet dotenv express-rate-limit
 *
 * DEPLOY OPTIONS:
 *   - Railway.app  (free tier, Postgres included)
 *   - Render.com   (free tier, Postgres included)
 *   - Vercel       (serverless, use Vercel Postgres)
 *
 * ENV VARIABLES (.env file):
 *   DATABASE_URL=postgresql://user:pass@host:5432/levicube
 *   STRIPE_SECRET_KEY=sk_live_...
 *   STRIPE_WEBHOOK_SECRET=whsec_...
 *   SENDGRID_API_KEY=SG....
 *   FROM_EMAIL=orders@levicube.at
 *   FRONTEND_URL=https://levicube.at
 *   PORT=3001
 */

require('dotenv').config();
const express     = require('express');
const { Pool }    = require('pg');
const Stripe      = require('stripe');
const sgMail      = require('@sendgrid/mail');
const cors        = require('cors');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ── Database ─────────────────────────────────────────────────────
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id              SERIAL PRIMARY KEY,
      order_number    VARCHAR(20) UNIQUE NOT NULL,
      stripe_session  VARCHAR(200),
      status          VARCHAR(30) DEFAULT 'pending',
      -- Customer
      name            VARCHAR(200) NOT NULL,
      email           VARCHAR(200) NOT NULL,
      phone           VARCHAR(50),
      -- Shipping
      address         VARCHAR(300) NOT NULL,
      city            VARCHAR(100) NOT NULL,
      zip             VARCHAR(20)  NOT NULL,
      country         VARCHAR(10)  DEFAULT 'AT',
      -- Order
      quantity        INT          DEFAULT 1,
      unit_price      NUMERIC(10,2) DEFAULT 149.00,
      discount_code   VARCHAR(50),
      discount_pct    NUMERIC(5,2)  DEFAULT 0,
      shipping_cost   NUMERIC(10,2) DEFAULT 12.00,
      total           NUMERIC(10,2) NOT NULL,
      -- Meta
      payment_method  VARCHAR(30),
      ip_address      VARCHAR(60),
      user_agent      TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS coupons (
      code          VARCHAR(50) PRIMARY KEY,
      discount_pct  NUMERIC(5,2) NOT NULL,
      max_uses      INT DEFAULT 100,
      used_count    INT DEFAULT 0,
      active        BOOLEAN DEFAULT TRUE,
      expires_at    TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS newsletter (
      id         SERIAL PRIMARY KEY,
      email      VARCHAR(200) UNIQUE NOT NULL,
      source     VARCHAR(50),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(100) NOT NULL,
      stars      INT CHECK (stars BETWEEN 1 AND 5),
      text       TEXT NOT NULL,
      verified   BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Seed coupons
    INSERT INTO coupons (code, discount_pct) VALUES
      ('ASCEND10', 10),
      ('VOID20',   20),
      ('LAUNCH15', 15)
    ON CONFLICT DO NOTHING;
  `);
  console.log('✓ Database initialised');
}

// ── Middleware ────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// Stripe webhooks need raw body
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// ── Helpers ───────────────────────────────────────────────────────
function generateOrderNumber() {
  return 'LC-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

function calcTotal(qty, discountPct) {
  const sub = 149 * qty;
  const discount = sub * (discountPct / 100);
  return +(sub - discount + 12).toFixed(2);
}

// ── ROUTES ────────────────────────────────────────────────────────

/** GET /api/health */
app.get('/api/health', (_, res) => res.json({ status: 'ok', time: new Date() }));

/** POST /api/validate-coupon */
app.post('/api/validate-coupon', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'No code provided' });
  try {
    const r = await db.query(
      `SELECT * FROM coupons WHERE code = $1 AND active = TRUE
       AND (expires_at IS NULL OR expires_at > NOW())
       AND used_count < max_uses`,
      [code.toUpperCase()]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Invalid or expired code' });
    const coupon = r.rows[0];
    res.json({ valid: true, code: coupon.code, discountPct: parseFloat(coupon.discount_pct) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/create-checkout-session
 * Creates a Stripe Checkout session and returns the URL.
 */
app.post('/api/create-checkout-session', async (req, res) => {
  const { name, email, address, city, zip, country, quantity, couponCode } = req.body;

  // Validate required fields
  if (!name || !email || !address || !city || !zip) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  let discountPct = 0;
  if (couponCode) {
    const c = await db.query(
      `SELECT discount_pct FROM coupons WHERE code = $1 AND active = TRUE AND (expires_at IS NULL OR expires_at > NOW()) AND used_count < max_uses`,
      [couponCode.toUpperCase()]
    );
    if (c.rows.length) discountPct = parseFloat(c.rows[0].discount_pct);
  }

  const qty         = Math.max(1, Math.min(10, parseInt(quantity) || 1));
  const unitPrice   = 14900; // cents
  const shippingCents = 1200;
  const discountCents = Math.round(unitPrice * qty * discountPct / 100);
  const orderNumber = generateOrderNumber();

  try {
    // Build Stripe line items
    const lineItems = [{
      price_data: {
        currency: 'eur',
        product_data: {
          name: 'LeviCube Gen-1 — Aetheric Void Edition',
          description: 'Magnetisch schwebender RGB-Cube | Limited Edition',
          images: ['https://levicube.at/og-image.jpg'],
        },
        unit_amount: unitPrice,
      },
      quantity: qty,
    }, {
      price_data: {
        currency: 'eur',
        product_data: { name: 'Express Versand' },
        unit_amount: shippingCents,
      },
      quantity: 1,
    }];

    const discounts = [];
    if (discountCents > 0) {
      // Create a one-time Stripe coupon
      const stripeCoupon = await stripe.coupons.create({
        amount_off: discountCents,
        currency: 'eur',
        duration: 'once',
        name: couponCode,
      });
      discounts.push({ coupon: stripeCoupon.id });
    }

    const session = await stripe.checkout.sessions.create({
      mode:                 'payment',
      payment_method_types: ['card', 'paypal', 'sepa_debit'],
      line_items:           lineItems,
      discounts,
      customer_email:       email,
      success_url:          `${process.env.FRONTEND_URL}/success?order=${orderNumber}&session={CHECKOUT_SESSION_ID}`,
      cancel_url:           `${process.env.FRONTEND_URL}/checkout?cancelled=1`,
      metadata:             { orderNumber, name, address, city, zip, country: country || 'AT', quantity: qty, couponCode: couponCode || '' },
      shipping_address_collection: { allowed_countries: ['AT','DE','CH','FR','IT','NL','BE','PL','ES','GB','US'] },
      phone_number_collection: { enabled: true },
      locale: 'de',
    });

    // Save pending order to DB
    const total = calcTotal(qty, discountPct);
    await db.query(
      `INSERT INTO orders (order_number, stripe_session, status, name, email, address, city, zip, country, quantity, discount_code, discount_pct, total, ip_address, user_agent)
       VALUES ($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [orderNumber, session.id, name, email, address, city, zip, country || 'AT', qty,
       couponCode || null, discountPct, total,
       req.ip, req.headers['user-agent']]
    );

    res.json({ url: session.url, orderNumber });
  } catch (e) {
    console.error('Stripe error:', e);
    res.status(500).json({ error: 'Payment session creation failed' });
  }
});

/**
 * POST /webhook
 * Stripe webhook — handles payment confirmation.
 */
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Webhook signature failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session  = event.data.object;
    const { orderNumber, name, couponCode } = session.metadata;
    const email    = session.customer_email || session.customer_details?.email;
    const phone    = session.customer_details?.phone;
    const shipping = session.shipping_details?.address;

    // Update order status
    await db.query(
      `UPDATE orders SET status='paid', payment_method=$1, updated_at=NOW(),
       phone=$2, address=$3, city=$4, zip=$5, country=$6
       WHERE order_number=$7`,
      [session.payment_method_types?.[0] || 'card',
       phone,
       shipping?.line1 || '',
       shipping?.city  || '',
       shipping?.postal_code || '',
       shipping?.country || 'AT',
       orderNumber]
    );

    // Mark coupon as used
    if (couponCode) {
      await db.query(`UPDATE coupons SET used_count = used_count + 1 WHERE code = $1`, [couponCode]);
    }

    // Send confirmation email
    await sendOrderConfirmation({ orderNumber, name, email, session });
    console.log(`✓ Order ${orderNumber} paid & email sent`);
  }

  res.json({ received: true });
});

/** GET /api/order/:orderNumber */
app.get('/api/order/:orderNumber', async (req, res) => {
  const { orderNumber } = req.params;
  const r = await db.query(
    `SELECT order_number, status, name, email, quantity, total, created_at FROM orders WHERE order_number=$1`,
    [orderNumber]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Order not found' });
  res.json(r.rows[0]);
});

/** POST /api/newsletter */
app.post('/api/newsletter', async (req, res) => {
  const { email, source } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  try {
    await db.query(
      `INSERT INTO newsletter (email, source) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [email, source || 'website']
    );
    await sendNewsletterWelcome(email);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/reviews */
app.get('/api/reviews', async (_, res) => {
  const r = await db.query(`SELECT id,name,stars,text,created_at FROM reviews ORDER BY created_at DESC LIMIT 20`);
  res.json(r.rows);
});

/** POST /api/reviews */
app.post('/api/reviews', async (req, res) => {
  const { name, stars, text } = req.body;
  if (!name || !stars || !text) return res.status(400).json({ error: 'Missing fields' });
  const r = await db.query(
    `INSERT INTO reviews (name, stars, text) VALUES ($1,$2,$3) RETURNING id,name,stars,text,created_at`,
    [name, parseInt(stars), text]
  );
  res.status(201).json(r.rows[0]);
});

/** POST /api/return-request */
app.post('/api/return-request', async (req, res) => {
  const { orderNumber, email, reason } = req.body;
  if (!orderNumber || !email) return res.status(400).json({ error: 'Missing fields' });
  try {
    const order = await db.query(`SELECT * FROM orders WHERE order_number=$1 AND email=$2`, [orderNumber, email]);
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });
    await sendReturnConfirmation(email, orderNumber, reason);
    res.json({ success: true, message: 'Return initiated. Label sent by email.' });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Email Templates ───────────────────────────────────────────────

async function sendOrderConfirmation({ orderNumber, name, email, session }) {
  const total = (session.amount_total / 100).toFixed(2);
  const html = `
<!DOCTYPE html>
<html lang="de">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;background:#0a0a0b;font-family:'Helvetica Neue',sans-serif;color:#e5e2e3">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px">
    <!-- Header -->
    <div style="text-align:center;margin-bottom:40px">
      <h1 style="color:#00dbe9;font-size:28px;letter-spacing:-0.5px;margin:0">LeviCube</h1>
      <p style="color:#849495;font-size:12px;letter-spacing:3px;text-transform:uppercase;margin:8px 0 0">Engineered in the Void</p>
    </div>
    <!-- Hero -->
    <div style="background:linear-gradient(135deg,#1a1a1c,#0e0e0f);border:1px solid rgba(0,240,255,.15);border-radius:16px;padding:40px;text-align:center;margin-bottom:30px">
      <div style="width:64px;height:64px;background:rgba(0,240,255,.1);border:1px solid rgba(0,240,255,.3);border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:20px">
        <span style="font-size:28px">✓</span>
      </div>
      <h2 style="color:#dbfcff;font-size:24px;margin:0 0 12px">Ascension confirmed.</h2>
      <p style="color:#b9cacb;margin:0;line-height:1.6">Bestellung <strong style="color:#00dbe9">#${orderNumber}</strong> wurde erfolgreich aufgegeben.<br/>Dein LeviCube ist auf dem Weg zu dir.</p>
    </div>
    <!-- Details -->
    <div style="background:#201f20;border:1px solid rgba(59,73,75,.3);border-radius:12px;padding:24px;margin-bottom:24px">
      <h3 style="color:#dbfcff;margin:0 0 16px;font-size:14px;text-transform:uppercase;letter-spacing:2px">Bestelldetails</h3>
      <table style="width:100%;border-collapse:collapse">
        <tr style="border-bottom:1px solid rgba(59,73,75,.3)">
          <td style="padding:12px 0;color:#b9cacb;font-size:14px">Produkt</td>
          <td style="padding:12px 0;color:#e5e2e3;text-align:right;font-size:14px">LeviCube Gen-1</td>
        </tr>
        <tr style="border-bottom:1px solid rgba(59,73,75,.3)">
          <td style="padding:12px 0;color:#b9cacb;font-size:14px">Bestellnummer</td>
          <td style="padding:12px 0;color:#00dbe9;text-align:right;font-size:14px;font-weight:bold">${orderNumber}</td>
        </tr>
        <tr>
          <td style="padding:12px 0;color:#b9cacb;font-size:14px">Gesamtbetrag</td>
          <td style="padding:12px 0;color:#00f0ff;text-align:right;font-size:18px;font-weight:bold">€${total}</td>
        </tr>
      </table>
    </div>
    <!-- Shipping -->
    <div style="background:#201f20;border:1px solid rgba(59,73,75,.3);border-radius:12px;padding:24px;margin-bottom:24px">
      <h3 style="color:#dbfcff;margin:0 0 12px;font-size:14px;text-transform:uppercase;letter-spacing:2px">Lieferung</h3>
      <p style="color:#b9cacb;margin:0;font-size:14px;line-height:1.8">
        Geschätzte Lieferzeit: <strong style="color:#e5e2e3">2–3 Werktage</strong><br/>
        Du erhältst eine Tracking-E-Mail sobald dein Paket versendet wurde.
      </p>
    </div>
    <!-- What's next -->
    <div style="background:rgba(0,240,255,.05);border:1px solid rgba(0,240,255,.15);border-radius:12px;padding:24px;margin-bottom:30px">
      <h3 style="color:#00dbe9;margin:0 0 12px;font-size:14px;text-transform:uppercase;letter-spacing:2px">Was kommt als nächstes?</h3>
      <ul style="color:#b9cacb;font-size:14px;line-height:2;margin:0;padding-left:20px">
        <li>Bestellbestätigung wird archiviert ✓</li>
        <li>Produktion & Qualitätskontrolle (~24h)</li>
        <li>Versand mit DHL Express + Tracking</li>
        <li>Lieferung an deine Adresse</li>
      </ul>
    </div>
    <!-- CTA -->
    <div style="text-align:center;margin-bottom:40px">
      <a href="${process.env.FRONTEND_URL}/support" style="display:inline-block;background:linear-gradient(135deg,#dbfcff,#00f0ff);color:#002022;font-weight:bold;padding:14px 32px;border-radius:12px;text-decoration:none;font-size:15px">
        Support & Installation Guide →
      </a>
    </div>
    <!-- Footer -->
    <div style="text-align:center;border-top:1px solid rgba(59,73,75,.3);padding-top:24px">
      <p style="color:#849495;font-size:12px;line-height:1.8;margin:0">
        LeviCube GmbH · Technologiegasse 1 · 1010 Wien · Österreich<br/>
        <a href="mailto:support@levicube.at" style="color:#00dbe9;text-decoration:none">support@levicube.at</a> · 
        <a href="${process.env.FRONTEND_URL}/privacy" style="color:#849495;text-decoration:none">Datenschutz</a> · 
        <a href="${process.env.FRONTEND_URL}/terms" style="color:#849495;text-decoration:none">AGB</a>
      </p>
    </div>
  </div>
</body>
</html>`;

  await sgMail.send({
    to:      email,
    from:    { email: process.env.FROM_EMAIL, name: 'LeviCube' },
    subject: `✓ Bestellbestätigung #${orderNumber} — LeviCube`,
    html,
    text: `Bestellung ${orderNumber} bestätigt. Total: €${total}. Support: support@levicube.at`,
  });
}

async function sendNewsletterWelcome(email) {
  await sgMail.send({
    to:      email,
    from:    { email: process.env.FROM_EMAIL, name: 'LeviCube' },
    subject: 'Willkommen in der Void — LeviCube Updates',
    html:    `<p style="font-family:sans-serif;color:#333">Du wirst als Erstes über neue Releases, exklusive Angebote und Launch-Neuigkeiten informiert. <br/><a href="${process.env.FRONTEND_URL}">levicube.at</a></p>`,
  });
}

async function sendReturnConfirmation(email, orderNumber, reason) {
  await sgMail.send({
    to:      email,
    from:    { email: process.env.FROM_EMAIL, name: 'LeviCube Returns' },
    subject: `Rücksendung #${orderNumber} — LeviCube`,
    html:    `<p style="font-family:sans-serif">Wir haben deine Rücksendeanfrage für Bestellung <strong>${orderNumber}</strong> erhalten (Grund: ${reason || 'k.A.'}).<br/>Ein kostenloses DHL-Rücksendeetikett wird dir binnen 24h per E-Mail zugesandt.</p>`,
  });
}

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 LeviCube API running on port ${PORT}`));
});

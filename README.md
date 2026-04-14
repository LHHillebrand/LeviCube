# LeviCube — Shop

Magnetisch schwebender RGB-Cube. Vollständige E-Commerce-Website mit Stripe-Zahlung, SendGrid E-Mails und PostgreSQL-Datenbank.

## Projektstruktur

```
levicube/
├── index.html          ← Frontend (komplette Website)
├── backend/
│   ├── server.js       ← Node.js API Server
│   ├── package.json    ← Dependencies
│   └── .env.example    ← Vorlage für Umgebungsvariablen
├── .gitignore
└── README.md
```

## Tech Stack

- **Frontend**: HTML/CSS/JS + Tailwind CDN
- **Backend**: Node.js + Express
- **Datenbank**: PostgreSQL
- **Zahlung**: Stripe (Karte, PayPal, SEPA)
- **E-Mail**: SendGrid
- **Frontend-Hosting**: Vercel / Netlify
- **Backend-Hosting**: Railway.app

---

## Deployment Guide

### Schritt 1 — GitHub

1. [github.com](https://github.com) → einloggen → oben rechts **„+"** → **„New repository"**
2. Name: `levicube`, Sichtbarkeit: **Private**, ohne README erstellen → **„Create repository"**
3. Terminal öffnen im Projektordner:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/LHHillebrand/levicube.git
git push -u origin main
```

---

### Schritt 2 — Stripe Account

1. [stripe.com](https://stripe.com) → Account erstellen (kostenlos)
2. Dashboard → oben rechts auf **„Test mode"** achten (für Tests)
3. **API Keys**: Dashboard → Developers → API keys
   - `Publishable key`: pk_test_... (nicht benötigt im Backend)
   - `Secret key`: sk_test_... → **kopieren** → kommt in `.env`
4. **Webhook erstellen**: Developers → Webhooks → „Add endpoint"
   - URL: `https://DEINE-RAILWAY-URL.railway.app/webhook`
   - Events auswählen: `checkout.session.completed`
   - Nach Erstellen: **Signing secret** (whsec_...) → **kopieren** → kommt in `.env`

---

### Schritt 3 — SendGrid Account

1. [sendgrid.com](https://sendgrid.com) → Account erstellen (kostenlos, 100 E-Mails/Tag)
2. Settings → **API Keys** → „Create API Key" → Full Access → **kopieren** → kommt in `.env`
3. Settings → **Sender Authentication** → Single Sender Verification
   - E-Mail eingeben z.B. `orders@levicube.at` (oder deine echte E-Mail)
   - Bestätigungsmail öffnen und bestätigen

---

### Schritt 4 — Backend auf Railway deployen

1. [railway.app](https://railway.app) → mit GitHub einloggen
2. **„New Project"** → **„Deploy from GitHub repo"** → `levicube` auswählen
3. Railway fragt nach dem Root Directory → **`backend`** eingeben → Deploy
4. Im Projekt: **„+ New"** → **„Database"** → **„PostgreSQL"** hinzufügen
5. PostgreSQL anklicken → **„Connect"** Tab → `DATABASE_URL` **kopieren**
6. Zurück zum Service → **„Variables"** Tab → alle Variablen eintragen:

```
DATABASE_URL        = (von Railway PostgreSQL kopiert)
STRIPE_SECRET_KEY   = sk_test_...
STRIPE_WEBHOOK_SECRET = whsec_...
SENDGRID_API_KEY    = SG....
FROM_EMAIL          = orders@levicube.at
FRONTEND_URL        = https://levicube.vercel.app
PORT                = 3001
```

7. Nach dem Deploy: Railway gibt dir eine URL wie `levicube-backend.railway.app` → **kopieren**

---

### Schritt 5 — Frontend auf Vercel deployen

1. [vercel.com](https://vercel.com) → mit GitHub einloggen
2. **„Add New Project"** → `levicube` Repository importieren
3. Framework: **„Other"** (kein Framework)
4. Root Directory: **`/`** (leer lassen)
5. **„Deploy"** klicken
6. Nach dem Deploy: Vercel gibt dir eine URL wie `levicube.vercel.app`

7. **Wichtig**: `index.html` öffnen → ganz oben im JavaScript die API-URL anpassen:
```javascript
const API = 'https://levicube-backend.railway.app';
```
→ Datei speichern → `git add . && git commit -m "fix: API URL" && git push`
→ Vercel deployed automatisch neu

---

### Schritt 6 — Stripe Webhook URL aktualisieren

1. Stripe Dashboard → Developers → Webhooks → dein Webhook
2. URL auf `https://levicube-backend.railway.app/webhook` aktualisieren (falls noch nicht)

---

### Schritt 7 — Testen

1. Website öffnen: `https://levicube.vercel.app`
2. Produkt in Warenkorb → Checkout
3. Stripe Testkartennummer verwenden:
   - Karte: **`4242 4242 4242 4242`**
   - Datum: irgendein zukünftiges Datum (z.B. `12/28`)
   - CVC: irgendwelche 3 Zahlen (z.B. `123`)
4. Nach der Zahlung: Bestätigungs-E-Mail prüfen
5. Railway → PostgreSQL → Data Tab → Tabelle `orders` prüfen

---

### Stripe Live-Modus aktivieren (wenn du echte Zahlungen annehmen willst)

1. Stripe Dashboard → oben rechts **„Activate your account"** → Identität bestätigen (Personalausweis, Bankverbindung)
2. Nach Aktivierung: Test-Keys durch **Live-Keys** ersetzen in Railway Variables:
   - `STRIPE_SECRET_KEY` = `sk_live_...`
   - `STRIPE_WEBHOOK_SECRET` = neuen Webhook mit Live-Keys erstellen

---

## Lokale Entwicklung

```bash
# Backend lokal starten
cd backend
npm install
cp .env.example .env
# .env mit echten Werten füllen
node server.js

# Frontend: einfach index.html im Browser öffnen
# oder mit Live Server Extension in VS Code
```

## Gutscheincodes (bereits hinterlegt)

| Code | Rabatt |
|------|--------|
| `ASCEND10` | 10% |
| `VOID20` | 20% |
| `LAUNCH15` | 15% |

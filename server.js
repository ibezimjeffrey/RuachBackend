// server.js
require('dotenv').config();

/* =========================
   IMPORTS
   ========================= */
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');

/* =========================
   FIREBASE INIT
   ========================= */
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

/* =========================
   CONFIG
   ========================= */
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const FEE_ACCOUNT_RECIPIENT_CODE = process.env.FEE_ACCOUNT_RECIPIENT_CODE;
const API_KEY = process.env.API_KEY;
const PORT = process.env.PORT || 3000;

if (!PAYSTACK_SECRET_KEY) {
  console.error('❌ PAYSTACK_SECRET_KEY missing');
  process.exit(1);
}

if (!FEE_ACCOUNT_RECIPIENT_CODE) {
  console.error('❌ FEE_ACCOUNT_RECIPIENT_CODE missing');
  process.exit(1);
}

/* =========================
   APP INIT
   ========================= */
const app = express();

/* =========================
   PAYSTACK HELPER
   ========================= */
async function paystackPost(path, body, headers = {}) {
  const res = await axios.post(
    `https://api.paystack.co${path}`,
    body,
    {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
        ...headers,
      },
    }
  );
  return res.data;
}

/* =========================
   PAYSTACK WEBHOOK (MUST BE FIRST)
   ========================= */
app.post(
  '/paystack-webhook',
  bodyParser.raw({ type: '*/*' }),
  async (req, res) => {
    try {
      console.log('🔥 PAYSTACK WEBHOOK HIT');

      const signature = req.headers['x-paystack-signature'];
      const hash = crypto
        .createHmac('sha512', PAYSTACK_SECRET_KEY)
        .update(req.body)
        .digest('hex');

      if (hash !== signature) {
        console.error('❌ Invalid Paystack signature');
        return res.sendStatus(401);
      }

      const payload = JSON.parse(req.body.toString());
      const { event, data } = payload;

      console.log('➡️ Event:', event);

      /* =========================
         DEPOSIT SUCCESS
         ========================= */
      if (event === 'charge.success') {
        const email = data.customer.email;
        const amountPaid = data.amount; // kobo
        const reference = data.reference;

        const userSnap = await db
          .collection('users')
          .where('email', '==', email)
          .limit(1)
          .get();

        if (userSnap.empty) {
          console.error('❌ User not found for deposit');
          return res.sendStatus(200);
        }

        const userId = userSnap.docs[0].id;

    const FEE_PERCENT = 7.5; // 7.5%
const feeAmount = Math.round(amountPaid * (FEE_PERCENT / 100)); // divide by 100

        const walletAmount = amountPaid - feeAmount;

        const balanceRef = db.collection('Balance').doc(userId);
        const balanceSnap = await balanceRef.get();
        const currentBalance = balanceSnap.exists
          ? balanceSnap.data().Amount || 0
          : 0;

        await balanceRef.set(
          { Amount: currentBalance + walletAmount },
          { merge: true }
        );

        await db.collection('transactions').add({
          userId,
          type: 'credit',
          amount: walletAmount,
          reason: 'Wallet deposit',
          reference,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        if (feeAmount > 0) {
          await paystackPost(
            '/transfer',
            {
              source: 'balance',
              amount: feeAmount,
              recipient: FEE_ACCOUNT_RECIPIENT_CODE,
              reason: `Platform fee from ${email}`,
            },
            { 'Idempotency-Key': `fee-${reference}` }
          );
        }

        console.log('✅ Deposit processed successfully');
        return res.sendStatus(200);
      }

      /* =========================
         WITHDRAW SUCCESS
         ========================= */
      if (event === 'transfer.success') {
        await db
          .collection('transactions')
          .where('reference', '==', data.reference)
          .limit(1)
          .get()
          .then(snap => {
            if (!snap.empty) {
              snap.docs[0].ref.update({ status: 'success' });
            }
          });

        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    } catch (err) {
      console.error('❌ Webhook error:', err);
      return res.sendStatus(500);
    }
  }
);

/* =========================
   JSON MIDDLEWARE (AFTER WEBHOOK)
   ========================= */
app.use(express.json());

/* =========================
   API KEY GUARD
   ========================= */
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/* =========================
   WITHDRAW ENDPOINT
   ========================= */
app.post('/withdraw', requireApiKey, async (req, res) => {
  try {
    const { userId, amount, accountNumber, bankCode, name } = req.body;

    if (!userId || !amount || !accountNumber || !bankCode || !name) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const balanceRef = db.collection('Balance').doc(userId);
    const balanceSnap = await balanceRef.get();

    if (!balanceSnap.exists) {
      return res.status(404).json({ error: 'Balance not found' });
    }

    const balance = balanceSnap.data().Amount;

    if (amount > balance) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    await balanceRef.update({ Amount: balance - amount });

    const recipientRes = await paystackPost('/transferrecipient', {
      type: 'nuban',
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: 'NGN',
    });

    const transferRes = await paystackPost('/transfer', {
      source: 'balance',
      amount,
      recipient: recipientRes.data.recipient_code,
      reason: `Withdrawal for ${userId}`,
    });

    await db.collection('transactions').add({
      userId,
      type: 'debit',
      amount,
      reason: 'Wallet withdrawal',
      reference: transferRes.data.reference,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});

app.get('/paystack-webhook', (req, res) => {
  res.send('Webhook route is active. Waiting for POST from Paystack.');
});



/* =========================
   HEALTH CHECKS
   ========================= */
app.get('/', (_, res) => res.send('Server running'));
app.get('/ping', (_, res) => res.json({ ok: true }));

/* =========================
   START SERVER
   ========================= */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

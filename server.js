// server.js
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');



// ---------------- Firebase Setup ----------------
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ---------------- Config ----------------
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const API_KEY = process.env.API_KEY;
const PORT = process.env.PORT || 3000;

if (!PAYSTACK_SECRET_KEY) {
  console.error('Set PAYSTACK_SECRET_KEY in .env');
  process.exit(1);
}

// ---------------- Express Setup ----------------
const app = express();
app.use(express.json());

// API key check
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!API_KEY) return next(); // dev mode
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ---------------- Helper: Paystack ----------------
async function paystackPost(path, body, extraHeaders = {}) {
  const url = `https://api.paystack.co${path}`;
  const res = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    timeout: 20000,
  });
  return res.data;
}

// ---------------- Withdraw Endpoint ----------------
app.post('/withdraw', requireApiKey, async (req, res) => {
  try {
    const { userId, amount, accountNumber, bankCode, name } = req.body;

    // validate request
    if (!userId || !amount || !accountNumber || !bankCode || !name) {
      return res.status(400).json({ error: 'userId, amount, accountNumber, bankCode, and name are required' });
    }
    if (amount <= 0) return res.status(400).json({ error: 'amount must be > 0' });

    // check balance
    const userRef = db.collection('Balance').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ error: 'user not found' });

    const user = userDoc.data();
    if (amount > user.amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // deduct balance
    await userRef.update({ Amount: user.Amount - (amount/10) });

    // create transaction
    const tx = {
      id: uuidv4(),
      userId,
      amount,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    await db.collection('transactions').doc(tx.id).set(tx);

    // find or create recipient
    const recipSnap = await db.collection('recipients')
      .where('userId', '==', userId)
      .where('accountNumber', '==', accountNumber)
      .where('bankCode', '==', bankCode)
      .limit(1)
      .get();

    let recipient = recipSnap.empty ? null : recipSnap.docs[0].data();

    if (!recipient) {
      const recipientBody = {
        type: 'nuban',
        name,
        account_number: accountNumber,
        bank_code: bankCode,
        currency: 'NGN',
      };
      const recipResp = await paystackPost('/transferrecipient', recipientBody);

      if (!recipResp.status) {
        await userRef.update({ amount: user.amount }); // rollback
        await db.collection('transactions').doc(tx.id).update({ status: 'failed' });
        return res.status(400).json({ error: 'could not create recipient', details: recipResp });
      }

      recipient = {
        userId,
        accountNumber,
        bankCode,
        recipient_code: recipResp.data.recipient_code,
      };
      await db.collection('recipients').add(recipient);
    }

    // initiate transfer
    const transferBody = {
      source: 'balance',
      amount,
      recipient: recipient.recipient_code,
      reason: `Withdrawal for ${userId}`,
    };
    const transferResp = await paystackPost('/transfer', transferBody, { 'Idempotency-Key': tx.id });

    if (!transferResp.status) {
      await userRef.update({ amount: user.amount }); // rollback
      await db.collection('transactions').doc(tx.id).update({ status: 'failed' });
      return res.status(400).json({ error: 'transfer initiation failed', details: transferResp });
    }

    // success
    await db.collection('transactions').doc(tx.id).update({
      status: 'initiated',
      recipient_code: recipient.recipient_code,
      transfer_code: transferResp.data.transfer_code,
      reference: transferResp.data.reference,
      paystack: transferResp.data,
    });

    return res.json({ success: true, transaction: { ...tx, status: 'initiated' } });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message || err);
    return res.status(500).json({
      error: 'server error',
      details: err.response ? err.response.data : err.message,
    });
  }
});

// ---------------- Paystack Webhook ----------------
app.post('/paystack-webhook', bodyParser.raw({ type: '*/*' }), async (req, res) => {
  try {
    const sig = req.headers['x-paystack-signature'];
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
    if (hash !== sig) return res.status(401).send('Invalid signature');

    const payload = JSON.parse(req.body.toString());
    const { event, data } = payload;

    const txSnap = await db.collection('transactions')
      .where('reference', '==', data.reference || null)
      .limit(1)
      .get();

    if (txSnap.empty) return res.status(200).send('ok');

    const txDoc = txSnap.docs[0];

    if (event === 'transfer.success') {
      await txDoc.ref.update({ status: 'success', meta: { webhook: payload } });
    }

    if (event === 'transfer.failed' || event === 'transfer.reversed') {
      const tx = txDoc.data();
      const userRef = db.collection('balance').doc(tx.userId);
      const userDoc = await userRef.get();
      const user = userDoc.data();

      await userRef.update({ Amount: (user.amount || 0) + tx.amount });
      await txDoc.ref.update({ status: 'failed', meta: { webhook: payload } });
    }

    res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook error', err);
    res.status(500).send('server error');
  }
});

app.get('/', (req, res) => res.send('Server is running!'));

app.get('/test', (req, res) => {
  res.json({ msg: 'Test route working' });
});

app.get('/ping', (req, res) => {
  res.json({ msg: 'Ping working!' });
});

app.post('/withdraw', (req, res) => {
  console.log('Withdraw hit!', req.body); // log what RN sends
  res.json({ msg: 'Withdraw route reached!', body: req.body });
});




// ---------------- Start Server ----------------
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
// server.js
require("dotenv").config();

/* =========================
   IMPORTS
========================= */
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const admin = require("firebase-admin");

/* =========================
   FIREBASE INIT
========================= */
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");

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
const WITHDRAW_FEE_PERCENT = 7.5;

const PORT = process.env.PORT || 3000;

if (!PAYSTACK_SECRET_KEY || !FEE_ACCOUNT_RECIPIENT_CODE) {
  console.error("❌ Missing Paystack config");
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
  const res = await axios.post(`https://api.paystack.co${path}`, body, {
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...headers,
    },
    timeout: 15000,
  });
  return res.data;
}

/* =========================
   PAYSTACK WEBHOOK (FIRST)
========================= */
app.post(
  "/paystack-webhook",
  bodyParser.raw({ type: "*/*" }),
  async (req, res) => {
    const signature = req.headers["x-paystack-signature"];
    const hash = crypto
      .createHmac("sha512", PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest("hex");

    if (hash !== signature) {
      console.error("❌ Invalid webhook signature");
      return res.sendStatus(401);
    }

    res.sendStatus(200);

    try {
      const payload = JSON.parse(req.body.toString());
      const { event, data } = payload;

      if (event === "transfer.success") {
        const snap = await db
          .collection("transactions")
          .where("reference", "==", data.reference)
          .limit(1)
          .get();

        if (!snap.empty) {
          await snap.docs[0].ref.update({
            status: "success",
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    } catch (err) {
      console.error("❌ Webhook error:", err);
    }
  },
);

/* =========================
   JSON MIDDLEWARE
========================= */
app.use(express.json());

/* =========================
   API KEY GUARD
========================= */
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/* =========================
   WITHDRAW ENDPOINT
========================= */
app.post("/withdraw", requireApiKey, async (req, res) => {
  try {
    const { userId, amount, accountNumber, bankCode, name } = req.body;

    if (!userId || !amount || !accountNumber || !bankCode || !name) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const balanceRef = db.collection("Balance").doc(userId);

    // ✅ Create recipient
    const recipientRes = await paystackPost("/transferrecipient", {
      type: "nuban",
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: "NGN",
    });

    // ✅ User withdrawal transfer
    const transferRes = await paystackPost("/transfer", {
      source: "balance",
      amount,
      recipient: recipientRes.data.recipient_code,
      reason: `Withdrawal for ${userId}`,
    });

    await db.collection("transactions").add({
      userId,
      type: "debit",
      amount,
      reference: transferRes.data.reference,
      feeReference: `withdraw-fee-${transferRes.data.reference}`,
      status: "pending",
      reason: "Wallet withdrawal",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Withdrawal error:", err.message);
    res.status(400).json({ error: err.message || "Withdrawal failed" });
  }
});

app.post("/charges", requireApiKey, async (req, res) => {
  try {
    const { userId, amount, name } = req.body;

    if (!userId || !amount || !name) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const NairaFee = amount * 100;

    // ✅ Fee transfer
    if (NairaFee > 0) {
      try {
        await paystackPost(
          "/transfer",
          {
            source: "balance",
            amount: NairaFee,
            recipient: FEE_ACCOUNT_RECIPIENT_CODE,
            reason: `Payment fee from ${userId}`,
          },
          { "X-Fee-Reference": `fee-${userId}-${Date.now()}` },
        );
      } catch (err) {
        console.error("❌ Fee transfer failed:", err.message);
      }
    }

    await db.collection("transactions").add({
      userId,
      type: "Charges",
      amount,
      fee: NairaFee,

      status: "pending",
      reason: "Charges",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Payment error:", err.message);
    res.status(400).json({ error: err.message || "Payment failed" });
  }
});

/* =========================
   HEALTH CHECKS
========================= */
app.get("/", (_, res) => res.send("Server running"));
app.get("/ping", (_, res) => res.json({ ok: true }));

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

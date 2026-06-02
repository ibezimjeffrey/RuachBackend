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
const nodemailer = require('nodemailer');

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
   EXCLUSIVE MAIL CONFIG
========================= */
/* =========================
   EXCLUSIVE MAIL CONFIG (URL STRING METHOD)
========================= */
// Format: smtps://username:password@host:port
const connectionString = 'smtps://verification%40step-technologies.com:JEFFIBEZIM12345@mail.step-technologies.com:465';

const campusHubMailer = nodemailer.createTransport(connectionString, {
  tls: {
    rejectUnauthorized: false // Prevents local certificate drops
  }
});

// Run verification
console.log("🔄 Testing connection string SMTP Mail Server...");
campusHubMailer.verify(function (error, success) {
  if (error) {
    console.log("❌ Isolated SMTP Mail Server Error:", error);
  } else {
    console.log("✅ Isolated SMTP Mail Server is ready to send messages!");
  }
});
/* =========================
   APP INIT
========================= */
const app = express();
app.use(express.json());
/* =========================
   HUGGINGFACE AI CONFIG
========================= */
const HF_TOKEN = process.env.HF_TOKEN; // ✅ put token in .env

/* =========================
   AI MODERATION FUNCTION
========================= */
async function validateJobPost(title,text) {
  try {
    const URL = "https://router.huggingface.co/v1/chat/completions";

    const response = await axios.post(
      URL,
      {
        model: "Qwen/Qwen2.5-72B-Instruct",
        messages: [
          {
            role: "system",
            content:
              `You are a strict but fair moderator for a university campus freelance marketplace.

Your job is to classify a post as one of the following:
- JOB_OK
- SPAM
- DATING
- SCAM

This platform is ONLY for legitimate freelance, part-time, skill-based, or campus-related job opportunities for students.

Be flexible but careful. Many students are informal in writing, but scams and unrelated content must be rejected.

Evaluate BOTH the job TITLE and DESCRIPTION together. 
Check if:
- The title matches the description.
- The job clearly describes real work or a real service.
- Payment terms are reasonable and realistic.
- The request is skill-based (design, tutoring, coding, event help, photography, delivery, research assistance, etc.).
- It is safe and appropriate for students.

Mark as SCAM if:
- It promises unrealistic pay for little work.
- It asks for upfront payments.
- It involves crypto/investment schemes.
- It requests sensitive personal info.
- It is vague but promises guaranteed income.

Mark as DATING if:
- It seeks romantic companionship, hookups, sugar relationships, or personal relationships disguised as jobs.

Mark as SPAM if:
- It promotes unrelated services.
- It contains repetitive promotional content.
- It is clearly advertising something unrelated to student freelance work.

Mark as JOB_OK if:
- It is a genuine, clearly described freelance or campus job opportunity.
- The title and description logically match.
- The task is understandable and realistic.

Allow simple but legitimate service requests (e.g., food preparation, printing, delivery, tutoring) even if written casually, as long as they clearly imply a service being requested.
However, reject posts that are only personal statements without any indication of hiring or requesting a service.

Be strict but reasonable.
Reply ONLY with a JSON object in this exact format:
{"label":"LABEL_HERE","reason":"Short clear explanation referencing the title-description relationship and why it was classified this way."}
`,
          },
          {
            role: "user",
            content: `Analyze this post: " The job title is ${title} and the job description is ${text}"`,
          },
        ],
        max_tokens: 100,
        temperature: 0.1,
      },
      {
        headers: {
          Authorization: `Bearer ${HF_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    const aiResponse = response.data.choices[0].message.content;

    // Remove markdown code blocks if present
    const cleanJson = aiResponse.replace(/```json|```/g, "").trim();
   
    return JSON.parse(cleanJson);
  } catch (err) {
   
    return { error: "AI_FAILED" };
  }
}

/* =========================
   TEST AI ENDPOINT
========================= */
app.post("/AI", async (req, res) => {
  const { title,text } = req.body;
 
  if (!text) {
    return res.status(400).json({ error: "No text provided" });
  }

  const result = await validateJobPost(title,text);

  if (result.error) {
    return res.status(500).json(result);
  }

  res.json({
    allowed: result.label === "JOB_OK",
    label: result.label,
    reason: result.reason,
  });
});

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
      reason: `Withdrawal for ${name}`,
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
   ESCROW AUTO-RELEASE JOB
========================= */
const checkEscrows = async () => {
  const now = new Date();
  try {
    const escrowsSnapshot = await db.collection('Escrows')
      .where('status', '==', 'in_progress')
      .where('isReleased', '==', false)
      .get();

    escrowsSnapshot.forEach(async (docSnap) => {
      const escrow = docSnap.data();

      // Check if autoReleaseAt has passed
      if (escrow.autoReleaseAt <= now.getTime()) {
        const freelancerRef = db.collection('Balance').doc(escrow.freelancerId);
        const freelancerSnap = await freelancerRef.get();
        const freelancerBalance = freelancerSnap.exists ? freelancerSnap.data().Amount : 0;

        // Credit freelancer
        await freelancerRef.set({
          Amount: freelancerBalance + escrow.amount
        });

        // Mark escrow as released
        await docSnap.ref.update({
          status: 'released',
          isReleased: true
        });

        // Add to transaction history
        await db.collection('TransactionHistory').add({
          userId: escrow.freelancerId,
          type: 'credit',
          amount: escrow.amount,
          reason: `Auto-release for post ${escrow.postId}`,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`✅ Auto-released escrow ${escrow._id}`);
      }
    });
  } catch (err) {
    console.error("❌ Error checking escrows:", err);
  }
};

app.post('/send-custom-verification', async (req, res) => {
  const { email } = req.body;

  try {
    // 1. Generate the secure Firebase verification link
    const actionCodeSettings = { url: 'http://localhost:3000' };
    const verificationLink = await admin.auth().generateEmailVerificationLink(email, actionCodeSettings);

    // 2. Your custom HTML template
    const htmlTemplate = `
    <div style="background-color: #f4f7f6; padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; min-height: 100%;">
    <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 550px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.04); border: 1px solid #eef2f1;">
      
      <tr>
        <td align="center" style="padding: 40px 40px 20px 40px;">
          <img src="https://www.step-technologies.com/static/media/STEP_WHITE.jpeg" alt="STEP Logo" style="max-width: 140px; height: auto; display: block;" />
        </td>
      </tr>

      <tr>
        <td style="padding: 0 40px;">
          <div style="height: 2px; width: 100%; background: linear-gradient(90deg, rgba(43,158,155,0.1) 0%, rgba(43,158,155,1) 50%, rgba(43,158,155,0.1) 100%);"></div>
        </td>
      </tr>

      <tr>
        <td style="padding: 40px 40px 30px 40px;">
          <h2 style="color: #111827; font-size: 24px; font-weight: 700; margin: 0 0 16px 0; text-align: center; letter-spacing: -0.5px;">
            Verify your email address
          </h2>
          <p style="color: #4b5563; font-size: 15px; line-height: 24px; margin: 0; text-align: center;">
            Welcome to STEP! We're thrilled to have you here. To finalize setting up your account and dive into the platform, please confirm your email by clicking the button below.
          </p>
        </td>
      </tr>

      <tr>
        <td align="center" style="padding: 0 40px 40px 40px;">
          <table border="0" cellpadding="0" cellspacing="0">
            <tr>
              <td align="center" style="border-radius: 8px; background-color: #2B9E9B; box-shadow: 0 4px 12px rgba(43, 158, 155, 0.25);">
                <a href="${verificationLink}" target="_blank" style="display: inline-block; padding: 14px 36px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px; letter-spacing: 0.3px;">
                  Verify Email Address
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <tr>
        <td style="padding: 0 40px 30px 40px;">
          <p style="color: #9ca3af; font-size: 12px; line-height: 18px; margin: 0; text-align: center;">
            If the button above doesn't work, copy and paste this link into your browser secure bar:
          </p>
          <p style="margin: 8px 0 0 0; text-align: center; word-break: break-all;">
            <a href="${verificationLink}" target="_blank" style="color: #2B9E9B; font-size: 12px; text-decoration: none;">
              ${verificationLink}
            </a>
          </p>
        </td>
      </tr>

      <tr>
        <td align="center" style="background-color: #fafbfc; padding: 24px 40px; border-top: 1px solid #f3f4f6;">
          <p style="color: #9ca3af; font-size: 12px; margin: 0;">
            © 2026 S.T.E.P. Technologies. All rights reserved.
          </p>
        </td>
      </tr>
    </table>

    <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 550px;">
      <tr>
        <td align="center" style="padding: 24px 0 0 0;">
          <p style="color: #9ca3af; font-size: 11px; margin: 0; line-height: 16px;">
            You received this email because an account was registered on STEP with this email address. 
            If you did not perform this action, you can safely ignore this automated message.
          </p>
        </td>
      </tr>
    </table>
  </div>
    `;

    // 3. Send the email via cPanel SMTP
// 3. Send the email via cPanel SMTP using the isolated mailer
await campusHubMailer.sendMail({
  from: '"S.T.E.P. Technologies" <verification@step-technologies.com>',
  to: email,
  subject: 'Verify your email for STEP',
  html: htmlTemplate
});

    res.status(200).send({ success: true, message: 'Custom email sent.' });
  } catch (error) {
    console.error(error);
    res.status(500).send({ success: false, error: error.message });
  }
});

// Run every 10 minutes
setInterval(checkEscrows, 10 * 60 * 1000);


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

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
const nodemailer = require("nodemailer");
const { Resend } = require("resend");
const { Expo } = require("expo-server-sdk");
const { GoogleGenAI } = require("@google/genai");

const expo = new Expo();

const net = require("net");

function testMailPort(port) {
  console.log(
    `🔍 Scanning outbound connection to mail.step-technologies.com on Port ${port}...`,
  );

  const socket = new net.Socket();

  // Set a short 4-second timeout for the scan
  socket.setTimeout(4000);

  socket.connect(port, "mail.step-technologies.com", () => {
    console.log(`✅ PORT ${port} IS ALLOWED on Render!`);
    socket.destroy(); // Clean up connection
  });

  socket.on("timeout", () => {
    console.log(`❌ PORT ${port} TIMED OUT (Blocked by Render firewall).`);
    socket.destroy();
  });

  socket.on("error", (err) => {
    console.log(`❌ PORT ${port} FAILED: ${err.message}`);
  });
}

// Scan all potential cPanel email ports on startup
setTimeout(() => {
  console.log("=== STARTING RENDER NETWORK PORT SCAN ===");
  testMailPort(465); // Secure SSL
  testMailPort(587); // STARTTLS
  testMailPort(25); // Default SMTP
  testMailPort(2525); // Common alternative bypass port
}, 3000);

/* =========================
   FIREBASE INIT
========================= */
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

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
const connectionString =
  "smtps://verification%40step-technologies.com:JEFFIBEZIM12345@mail.step-technologies.com:465";

const campusHubMailer = nodemailer.createTransport(connectionString, {
  tls: {
    rejectUnauthorized: false, // Prevents local certificate drops
  },
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
async function validateJobPost(title, text) {
  try {

    const SYSTEM_PROMPT = `
You are a strict but fair moderator for a university campus freelance marketplace.

Your job is to classify a post as one of the following:
- JOB_OK
- SPAM
- DATING
- SCAM

This platform is ONLY for legitimate freelance, part-time, skill-based, or campus-related job opportunities for students.

Evaluate BOTH the title and description together.

Rules:

JOB_OK
- Genuine freelance or campus-related work.
- Title matches description.
- Realistic payment.
- Clearly describes a service or task.

SCAM
- Unrealistic earnings.
- Requests upfront payment.
- Crypto/investment schemes.
- Requests sensitive information.
- Guaranteed income.
- Extremely vague offers.

DATING
- Romantic requests.
- Sugar relationships.
- Hookups.
- Companion requests disguised as jobs.

SPAM
- Promotions.
- Advertisements.
- Unrelated services.
- Repetitive marketing.

Allow casual student wording if it still clearly requests or offers a legitimate service.

Reject posts that are simply personal statements without requesting work.

Return ONLY valid JSON.

Example:
{"label":"JOB_OK","reason":"Short explanation"}
`;

   const response = await ai.models.generateContent({
  model: "gemini-2.5-flash",
  contents: `
Title: ${title}

Description:
${text}
`,
  config: {
  systemInstruction: SYSTEM_PROMPT,
  temperature: 0,
  responseMimeType: "application/json",
  thinkingConfig: {
    thinkingBudget: 0,
  },
  responseSchema: {
    type: "OBJECT",
    properties: {
      label: {
        type: "STRING",
        enum: ["JOB_OK", "SPAM", "SCAM", "DATING"],
      },
      reason: {
        type: "STRING",
      },
    },
    required: ["label", "reason"],
  },

},
});

const result = JSON.parse(response.text);

console.log("✅ AI Moderation Result:", result);

return result;


;

  } catch (err) {
    console.log(err);
    return { error: "AI_FAILED" };
  }

  
}

/* =========================
   TEST AI ENDPOINT
========================= */
app.post("/AI", async (req, res) => {
  const { title, text } = req.body;

  if (!text) {
    return res.status(400).json({ error: "No text provided" });
  }

  const result = await validateJobPost(title, text);

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
    const escrowsSnapshot = await db
      .collection("Escrows")
      .where("status", "==", "in_progress")
      .where("isReleased", "==", false)
      .get();

    escrowsSnapshot.forEach(async (docSnap) => {
      const escrow = docSnap.data();

      // Check if autoReleaseAt has passed
      if (escrow.autoReleaseAt <= now.getTime()) {
        const freelancerRef = db.collection("Balance").doc(escrow.freelancerId);
        const freelancerSnap = await freelancerRef.get();
        const freelancerBalance = freelancerSnap.exists
          ? freelancerSnap.data().Amount
          : 0;

        // Credit freelancer
        await freelancerRef.set({
          Amount: freelancerBalance + escrow.amount,
        });

        // Mark escrow as released
        await docSnap.ref.update({
          status: "released",
          isReleased: true,
        });

        // Add to transaction history
        await db.collection("TransactionHistory").add({
          userId: escrow.freelancerId,
          type: "credit",
          amount: escrow.amount,
          reason: `Auto-release for post ${escrow.jobpost}`,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`✅ Auto-released escrow ${escrow._id}`);
      }
    });
  } catch (err) {
    console.error("❌ Error checking escrows:", err);
  }
};

const resend = new Resend("re_TLrYDpqb_42HmCJc45XMkPKbjX1woLmqW");

const actionCodeSettings = {
  url: "https://www.step-technologies.com",
  handleCodeInApp: false,
};


app.post("/send-notification", async (req, res) => {

const usersSnapshot = await db.collection("users").get();

const tokens = [];

usersSnapshot.forEach((doc) => {
  const token = doc.data().expoPushToken;

  if (token) {
    tokens.push(token);
  }
});

const messages = tokens.map((token) => ({
  to: token,
  sound: "default",
  title: req.body.title,
  body: req.body.body,
  data: {
    "type": "job",
    jobId: req.body.jobId,
  },
}));


let chunks = expo.chunkPushNotifications(messages);

for (let chunk of chunks) {
    await expo.sendPushNotificationsAsync(chunk);
}

 return res.status(200).json({
      success: true,
      message: "Notification sent successfully",
    });
})





app.post("/send-message-notification", async (req, res) => {

const userDoc = await db
  .collection("users")
  .doc(req.body.receiverId)
  .get();

const token = userDoc.data().expoPushToken;


const messages = [
  {
    to: token,
    sound: "default",
    title: req.body.senderName,
    body: req.body.message,
    data: {
      "type": "chat",
      roomId: req.body.roomId,
    },
  },
];

let chunks = expo.chunkPushNotifications(messages);

for (let chunk of chunks) {
    await expo.sendPushNotificationsAsync(chunk);
}

 return res.status(200).json({
      success: true,
      message: "Notification sent successfully",
    });



});









  app.post("/send-hired-notification", async (req, res) => {

  const userDoc = await db
    .collection("users")
    .doc(req.body.receiverId)
    .get();

  const token = userDoc.data().expoPushToken;


  const messages = [
    {
      to: token,
      sound: "default",
      title: req.body.title,
      body: req.body.body,
      data: {
        "type": "hired",
        roomId: req.body.roomId,
      },
    },
  ];

  let chunks = expo.chunkPushNotifications(messages);

  for (let chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
  }

 return res.status(200).json({
      success: true,
      message: "Notification sent successfully",
    });

  });




 app.post("/send-paid-notification", async (req, res) => {

  const userDoc = await db
    .collection("users")
    .doc(req.body.receiverId)
    .get();

  const token = userDoc.data().expoPushToken;


  const messages = [
    {
      to: token,
      sound: "default",
      title: req.body.title,
      body: req.body.body,
      data: {
        "type": "paid",
        roomId: req.body.roomId,
      },
    },
  ];

  let chunks = expo.chunkPushNotifications(messages);

  for (let chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
  }

 return res.status(200).json({
      success: true,
      message: "Notification sent successfully",
    });

  });









app.post("/send-custom-verification", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email payload is missing" });
  }

  try {
    // 1. Request the verification link from Firebase Admin securely
    const verificationLink = await admin
      .auth()
      .generateEmailVerificationLink(email, actionCodeSettings);

    // 2. Your breathtaking Teal Aesthetic HTML Layout
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

    // 3. Fire the request over Port 443 (HTTPS Web Traffic - Never blocked by Render)
    const response = await resend.emails.send({
      from: "STEP <verification@step-technologies.com>",
      to: [email],
      subject: "Verify your email for STEP",
      html: htmlTemplate,
    });

    if (response.error) {
      console.error("❌ Resend Delivery Error:", response.error);
      return res.status(400).json({ error: response.error.message });
    }

    console.log("🚀 Verification Email Sent to", email);
    return res
      .status(200)
      .json({ message: "Verification link sent successfully!" });
  } catch (error) {
    console.error("❌ Firebase Link Generation Fail:", error);
    return res.status(500).json({ error: error.message });
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

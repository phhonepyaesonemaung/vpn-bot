require("dotenv").config();
const dns = require("dns");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const https = require("https");

dns.setDefaultResultOrder("ipv4first");

require("./db");

const { PLANS, getServer, listRegions } = require("./config");
const User = require("./models/User");
const Order = require("./models/Order");
const PendingOrder = require("./models/PendingOrder");
const TrialClaim = require("./models/TrialClaim");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const ADMIN_ID = String(process.env.ADMIN_ID);
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || `tg://user?id=${ADMIN_ID}`;
const REFERRAL_BONUS_DAYS = Number(process.env.REFERRAL_BONUS_DAYS || 3);
const TRIAL_GB = Number(process.env.TRIAL_GB || 5);
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 3);
const EXPIRY_REMINDER_DAYS = Number(process.env.EXPIRY_REMINDER_DAYS || 3);
const GB = 1024 * 1024 * 1024;
const agent = new https.Agent({ rejectUnauthorized: false });

let botUsername;
const referralState = {};

const mainKeyboard = {
  reply_markup: {
    keyboard: [
      ["Buy VPN", "Renew VPN"],
      ["My VPN", "Check GB"],
      ["Free Test Key", "Referral"],
      ["Support", "Outline Download Guide"],
      ["User Manual"]
    ],
    resize_keyboard: true
  }
};

const GUIDE = `Outline Download Guide

Android:
1. Install Outline from Google Play.
2. Copy your VPN key from this bot.
3. Open Outline, tap Add Server, paste the key, then connect.

iPhone / iPad:
1. Install Outline App from the App Store.
2. Copy your VPN key from this bot.
3. Open Outline, add the server, allow VPN configuration, then connect.

Windows:
Download Outline Client:
https://s3.amazonaws.com/outline-releases/client/windows/stable/Outline-Client.exe

macOS:
Install Outline App from the App Store:
https://itunes.apple.com/us/app/outline-app/id1356178125`;

const MANUAL = `User Manual

1. Buy VPN or request a free test key.
2. Copy the VPN key sent by the bot.
3. Open Outline and add the server key.
4. Use My VPN or Check GB to see your status.
5. Use Renew VPN before expiry to continue service.
6. Send Support if you need help.`;

bot.getMe().then((me) => {
  botUsername = me.username;
}).catch(() => {});

async function createKey(api, username, gb) {
  const res = await axios.post(`${api}/access-keys`,
    { name: username },
    { httpsAgent: agent });

  const keyId = res.data.id;

  await setDataLimit(api, keyId, gb);

  return { key: res.data.accessUrl, keyId };
}

async function setDataLimit(api, keyId, gb) {
  await axios.put(`${api}/access-keys/${keyId}/data-limit`, {
    limit: { bytes: Math.ceil(gb * GB) }
  }, { httpsAgent: agent });
}

async function getUsageBytes(server, keyId) {
  const res = await axios.get(`${server}/metrics/transfer`, { httpsAgent: agent });
  return Number(res.data?.bytesTransferredByUserId?.[keyId] || 0);
}

function formatGb(bytes) {
  return (bytes / GB).toFixed(2);
}

function formatDate(date) {
  if (!date) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: process.env.DASHBOARD_TIMEZONE || "Asia/Rangoon"
  }).format(date);
}

function daysLeft(expireAt) {
  return Math.max(0, Math.ceil((expireAt.getTime() - Date.now()) / 86400000));
}

function usernameFrom(msg) {
  return msg.from?.username ? `@${msg.from.username}` : String(msg.from?.id || msg.chat.id);
}

function addMonthsFrom(date, months) {
  const base = date && date > new Date() ? new Date(date) : new Date();
  base.setMonth(base.getMonth() + months);
  return base;
}

async function findActiveUser(telegramId) {
  return User.findOne({
    telegramId: String(telegramId),
    active: true,
    expireAt: { $gt: new Date() }
  }).sort({ expireAt: -1 });
}

async function findLatestUser(telegramId) {
  return User.findOne({ telegramId: String(telegramId) }).sort({ expireAt: -1, _id: -1 });
}

async function sendUsage(chatId) {
  const user = await findActiveUser(chatId);
  if (!user) {
    return bot.sendMessage(chatId, "No active VPN key yet. Use Buy VPN or Free Test Key.", mainKeyboard);
  }

  const limitGb = Number(user.dataLimitGb || PLANS[user.plan]?.gb || 0);
  if (!limitGb) {
    return bot.sendMessage(chatId, "This key has no data limit saved. Please contact support.", mainKeyboard);
  }

  try {
    const usedBytes = await getUsageBytes(user.server, user.keyId);
    const remainingBytes = Math.max(0, limitGb * GB - usedBytes);

    return bot.sendMessage(chatId,
`VPN Data Status

Plan: ${user.plan} (${limitGb} GB)
Used: ${formatGb(usedBytes)} GB
Remaining: ${formatGb(remainingBytes)} GB
Expires: ${formatDate(user.expireAt)}
Days left: ${daysLeft(user.expireAt)}`, mainKeyboard);
  } catch {
    return bot.sendMessage(chatId, "I could not check GB right now. Please try again later.", mainKeyboard);
  }
}

async function sendMyVpn(chatId) {
  const user = await findLatestUser(chatId);
  if (!user) {
    return bot.sendMessage(chatId, "You do not have a VPN key yet. Use Buy VPN or Free Test Key.", mainKeyboard);
  }

  const active = user.active && user.expireAt > new Date();
  const status = active ? "Active" : "Expired";

  return bot.sendMessage(chatId,
`My VPN

Status: ${status}
Region: ${user.region}
Plan: ${user.plan}
Data limit: ${user.dataLimitGb || PLANS[user.plan]?.gb || "-"} GB
Expire date: ${formatDate(user.expireAt)}
Days left: ${active ? daysLeft(user.expireAt) : 0}

VPN Key:
${user.key}`, mainKeyboard);
}

async function sendReferral(chatId) {
  if (!botUsername) {
    try {
      const me = await bot.getMe();
      botUsername = me.username;
    } catch {}
  }

  if (!botUsername) {
    return bot.sendMessage(chatId, "Referral link is not available right now. Please try again later.", mainKeyboard);
  }

  const link = `https://t.me/${botUsername}?start=ref_${chatId}`;
  return bot.sendMessage(chatId,
`Referral Program

Share this link:
${link}

When your friend buys VPN, you get ${REFERRAL_BONUS_DAYS} bonus days.`);
}

async function sendSupport(chatId) {
  return bot.sendMessage(chatId,
`Support

Contact: ${SUPPORT_CONTACT}

Send your Telegram ID if you need help:
${chatId}`, mainKeyboard);
}

async function startOrder(msg, type) {
  const chatId = String(msg.chat.id);
  const regions = await listRegions();

  if (regions.length === 0) {
    return bot.sendMessage(chatId, "No VPN servers are available right now.");
  }

  if (type === "renew") {
    const user = await findLatestUser(chatId);
    if (!user) {
      return bot.sendMessage(chatId, "No existing VPN key found. Please use Buy VPN first.", mainKeyboard);
    }
  }

  const prefix = type === "renew" ? "renew_region" : "region";
  return bot.sendMessage(chatId, type === "renew" ? "Select renewal region" : "Select region", {
    reply_markup: {
      inline_keyboard: regions.map(region => [{
        text: region.label,
        callback_data: `${prefix}_${region.code}`
      }])
    }
  });
}

async function createPendingOrder(chatId, username, type, region, plan) {
  const order = await PendingOrder.create({
    telegramId: chatId,
    username,
    type,
    region,
    plan,
    amount: PLANS[plan].price,
    status: "awaiting_payment",
    referredBy: referralState[chatId]
  });

  return order;
}

async function sendPaymentInstructions(chatId, order) {
  return bot.sendMessage(chatId,
`${order.type === "renew" ? "Renew VPN" : "Buy VPN"}

Region: ${order.region}
Plan: ${order.plan} GB
Amount: ${order.amount} Ks

KPay/AyaPay: ${process.env.KPAY}

After payment, send the screenshot here.
Order ID: ${order._id}`, mainKeyboard);
}

async function notifyAdminOrder(order, fileId, fileKind) {
  const caption = `Payment Pending

Order: ${order._id}
Type: ${order.type}
User: ${order.username || order.telegramId}
Telegram ID: ${order.telegramId}
Region: ${order.region}
Plan: ${order.plan} GB
Amount: ${order.amount} Ks`;

  const options = {
    caption,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Approve", callback_data: `approve_order_${order._id}` },
          { text: "Reject", callback_data: `reject_order_${order._id}` }
        ],
        [{ text: "Better Screenshot", callback_data: `resubmit_order_${order._id}` }]
      ]
    }
  };

  if (fileKind === "document") {
    return bot.sendDocument(ADMIN_ID, fileId, options);
  }

  return bot.sendPhoto(ADMIN_ID, fileId, options);
}

async function applyReferralBonus(order) {
  if (!order.referredBy || order.referredBy === order.telegramId) return;

  const referrer = await findActiveUser(order.referredBy);
  if (!referrer) return;

  referrer.expireAt = new Date(referrer.expireAt.getTime() + REFERRAL_BONUS_DAYS * 86400000);
  await referrer.save();

  await bot.sendMessage(referrer.telegramId,
`Referral bonus added.

Bonus: ${REFERRAL_BONUS_DAYS} days
New expiry: ${formatDate(referrer.expireAt)}`);
}

async function approveOrder(orderId) {
  const order = await PendingOrder.findById(orderId);
  if (!order || order.status === "approved") return null;

  const plan = PLANS[order.plan];
  if (!plan) throw new Error("Unknown plan");

  let user;
  let keyMessage;

  if (order.type === "renew") {
    user = await findLatestUser(order.telegramId);

    if (user && user.active && user.expireAt > new Date() && user.keyId && user.server) {
      const usedGb = await getUsageBytes(user.server, user.keyId).catch(() => 0) / GB;
      user.active = true;
      user.plan = order.plan;
      user.region = order.region;
      user.dataLimitGb = Number(user.dataLimitGb || 0) + plan.gb;
      user.expireAt = addMonthsFrom(user.expireAt, 1);
      user.reminderSentAt = null;
      await setDataLimit(user.server, user.keyId, Math.max(user.dataLimitGb, usedGb + plan.gb));
      await user.save();
      keyMessage = `VPN renewed successfully.

Plan: ${order.plan} GB
New expiry: ${formatDate(user.expireAt)}

Your VPN key is unchanged:
${user.key}`;
    } else {
      order.type = "new";
    }
  }

  if (order.type === "new") {
    const api = await getServer(order.region);
    const { key, keyId } = await createKey(api, order.telegramId, plan.gb);
    const expireAt = addMonthsFrom(new Date(), 1);

    user = await User.create({
      telegramId: order.telegramId,
      region: order.region,
      plan: order.plan,
      key,
      keyId,
      server: api,
      dataLimitGb: plan.gb,
      expireAt,
      active: true,
      referredBy: order.referredBy
    });

    keyMessage = `VPN Key

Region: ${order.region}
Plan: ${order.plan} GB
Expires: ${formatDate(expireAt)}

${key}

Use User Manual if you need setup help.`;
  }

  await Order.create({
    telegramId: order.telegramId,
    amount: order.amount,
    region: order.region,
    plan: order.plan,
    type: order.type,
    pendingOrderId: String(order._id)
  });

  order.status = "approved";
  order.reviewedAt = new Date();
  await order.save();

  await applyReferralBonus(order);
  await bot.sendMessage(order.telegramId, keyMessage, mainKeyboard);

  return order;
}

async function createTrialKey(chatId, region, from) {
  try {
    await TrialClaim.create({ telegramId: String(chatId) });
  } catch {
    return bot.sendMessage(chatId, "Free test key is available only once per customer.", mainKeyboard);
  }

  try {
    const api = await getServer(region);
    const username = from?.username ? `trial_@${from.username}` : `trial_${chatId}`;
    const { key, keyId } = await createKey(api, username, TRIAL_GB);
    const expireAt = new Date(Date.now() + TRIAL_DAYS * 86400000);

    await User.create({
      telegramId: String(chatId),
      region,
      plan: "trial",
      key,
      keyId,
      server: api,
      dataLimitGb: TRIAL_GB,
      expireAt,
      active: true,
      isTrial: true,
      trialStartedAt: new Date(),
      referredBy: referralState[chatId]
    });

    return bot.sendMessage(chatId,
`Free Test VPN Key

Data: ${TRIAL_GB} GB
Expires: ${formatDate(expireAt)}

${key}

Use User Manual if you need setup help.`, mainKeyboard);
  } catch (err) {
    await TrialClaim.deleteOne({ telegramId: String(chatId) });
    return bot.sendMessage(chatId, "Could not create test key right now. Please try again later.", mainKeyboard);
  }
}

bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const chatId = String(msg.chat.id);
  const payload = match?.[1];
  if (payload?.startsWith("ref_")) {
    const referrer = payload.replace("ref_", "");
    if (referrer && referrer !== chatId) {
      referralState[chatId] = referrer;
    }
  }

  bot.sendMessage(chatId, "Welcome. Choose an option from the menu.", mainKeyboard);
});

bot.onText(/^(Buy VPN|\/buy)$/i, async (msg) => {
  await startOrder(msg, "new");
});

bot.onText(/^(Renew VPN|\/renew)$/i, async (msg) => {
  await startOrder(msg, "renew");
});

bot.onText(/^(My VPN|\/myvpn)$/i, async (msg) => {
  await sendMyVpn(String(msg.chat.id));
});

bot.onText(/^(Check GB|\/gb)$/i, async (msg) => {
  await sendUsage(String(msg.chat.id));
});

bot.onText(/^(Referral|\/referral)$/i, async (msg) => {
  await sendReferral(String(msg.chat.id));
});

bot.onText(/^(Support|\/support)$/i, async (msg) => {
  await sendSupport(String(msg.chat.id));
});

bot.onText(/^(Outline Download Guide|\/guide)$/i, (msg) => {
  bot.sendMessage(msg.chat.id, GUIDE, mainKeyboard);
});

bot.onText(/^(User Manual|\/manual)$/i, (msg) => {
  bot.sendMessage(msg.chat.id, MANUAL, mainKeyboard);
});

bot.onText(/^(Free Test Key|\/trial)$/i, async (msg) => {
  const chatId = String(msg.chat.id);
  const regions = await listRegions();
  if (regions.length === 0) {
    return bot.sendMessage(chatId, "No VPN servers are available right now.");
  }

  bot.sendMessage(chatId, "Select region for free test key.", {
    reply_markup: {
      inline_keyboard: regions.map(region => [{
        text: region.label,
        callback_data: `trial_region_${region.code}`
      }])
    }
  });
});

bot.on("callback_query", async (q) => {
  const chatId = String(q.message.chat.id);
  const data = q.data;

  try {
    await bot.answerCallbackQuery(q.id);
  } catch {}

  if (data.startsWith("region_") || data.startsWith("renew_region_")) {
    const type = data.startsWith("renew_region_") ? "renew" : "new";
    const region = data.replace("renew_region_", "").replace("region_", "");

    return bot.sendMessage(chatId, "Select plan", {
      reply_markup: {
        inline_keyboard: Object.keys(PLANS).map(p => [{
          text: `${p} GB - ${PLANS[p].price} Ks`,
          callback_data: `plan_${type}_${region}_${p}`
        }])
      }
    });
  }

  if (data.startsWith("plan_")) {
    const [, type, region, plan] = data.split("_");
    const order = await createPendingOrder(chatId, usernameFrom(q), type, region, plan);
    return sendPaymentInstructions(chatId, order);
  }

  if (data.startsWith("trial_region_")) {
    const region = data.replace("trial_region_", "");
    return createTrialKey(chatId, region, q.from);
  }

  if (data.startsWith("approve_order_")) {
    const orderId = data.replace("approve_order_", "");
    const order = await approveOrder(orderId);
    return bot.sendMessage(ADMIN_ID, order ? `Approved order ${orderId}` : `Order ${orderId} was already handled.`);
  }

  if (data.startsWith("reject_order_")) {
    const orderId = data.replace("reject_order_", "");
    const order = await PendingOrder.findById(orderId);
    if (!order) return bot.sendMessage(ADMIN_ID, "Order not found.");

    order.status = "rejected";
    order.reviewedAt = new Date();
    await order.save();

    await bot.sendMessage(order.telegramId, "Payment was rejected. Please contact support if this is a mistake.", mainKeyboard);
    return bot.sendMessage(ADMIN_ID, `Rejected order ${orderId}`);
  }

  if (data.startsWith("resubmit_order_")) {
    const orderId = data.replace("resubmit_order_", "");
    const order = await PendingOrder.findById(orderId);
    if (!order) return bot.sendMessage(ADMIN_ID, "Order not found.");

    order.status = "needs_better_screenshot";
    await order.save();

    await bot.sendMessage(order.telegramId, "Please send a clearer payment screenshot for your order.", mainKeyboard);
    return bot.sendMessage(ADMIN_ID, `Asked for better screenshot on order ${orderId}`);
  }
});

async function attachPaymentScreenshot(msg, fileId, fileKind) {
  const chatId = String(msg.chat.id);
  const order = await PendingOrder
    .findOne({
      telegramId: chatId,
      status: { $in: ["awaiting_payment", "needs_better_screenshot"] }
    })
    .sort({ createdAt: -1 });

  if (!order) return false;

  order.screenshotFileId = fileId;
  order.screenshotKind = fileKind;
  order.status = "pending_admin";
  order.username = usernameFrom(msg);
  await order.save();

  await notifyAdminOrder(order, fileId, fileKind);
  await bot.sendMessage(chatId, "Payment received. Waiting for admin approval.", mainKeyboard);
  return true;
}

bot.on("photo", async (msg) => {
  const photo = msg.photo[msg.photo.length - 1];
  await attachPaymentScreenshot(msg, photo.file_id, "photo");
});

bot.on("document", async (msg) => {
  if (!msg.document?.mime_type?.startsWith("image/")) return;
  await attachPaymentScreenshot(msg, msg.document.file_id, "document");
});

setInterval(async () => {
  const now = new Date();
  const reminderUntil = new Date(now.getTime() + EXPIRY_REMINDER_DAYS * 86400000);

  const reminderUsers = await User.find({
    expireAt: { $gt: now, $lte: reminderUntil },
    active: true,
    $or: [
      { reminderSentAt: { $exists: false } },
      { reminderSentAt: null }
    ]
  });

  for (const user of reminderUsers) {
    try {
      await bot.sendMessage(user.telegramId,
`Your VPN key will expire soon.

Days left: ${daysLeft(user.expireAt)}
Use Renew VPN to continue service.`, mainKeyboard);
      user.reminderSentAt = new Date();
      await user.save();
    } catch {}
  }

  const expiredUsers = await User.find({
    expireAt: { $lt: now },
    active: true
  });

  for (const user of expiredUsers) {
    try {
      await axios.delete(`${user.server}/access-keys/${user.keyId}`, { httpsAgent: agent });
    } catch {}

    user.active = false;
    await user.save();

    try {
      await bot.sendMessage(user.telegramId, "VPN expired. Use Renew VPN to continue service.", mainKeyboard);
    } catch {}
  }
}, 3600000);

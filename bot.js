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
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "https://t.me/Htaminlake";
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
      ["VPN ဝယ်ရန်", "VPN သက်တမ်းတိုးရန်"],
      ["ကျွန်ုပ်၏ VPN", "GB စစ်ရန်"],
      ["အခမဲ့ စမ်းသုံးရန်", "မိတ်ဆက်လင့်ခ်"],
      ["ကူညီမှု", "Outline ဒေါင်းလုဒ်"],
      ["အသုံးပြုနည်း"]
    ],
    resize_keyboard: true
  }
};

const GUIDE = `Outline ဒေါင်းလုဒ်လုပ်နည်း

Android:
1. Google Play မှ Outline app ကို install လုပ်ပါ။
2. ဒီ bot ကပေးတဲ့ VPN key ကို copy လုပ်ပါ။
3. Outline app ကိုဖွင့်ပြီး Add Server ကိုနှိပ်ပါ။ Key ကို paste လုပ်ပြီး connect လုပ်ပါ။

iPhone / iPad:
1. App Store မှ Outline App ကို install လုပ်ပါ။
2. ဒီ bot ကပေးတဲ့ VPN key ကို copy လုပ်ပါ။
3. Outline ကိုဖွင့်ပြီး server ထည့်ပါ။ VPN configuration ကို allow လုပ်ပြီး connect လုပ်ပါ။

Windows:
Outline Client ကို ဒီ link ကနေ download လုပ်ပါ:
https://s3.amazonaws.com/outline-releases/client/windows/stable/Outline-Client.exe

macOS:
App Store မှ Outline App ကို install လုပ်ပါ:
https://itunes.apple.com/us/app/outline-app/id1356178125`;

const MANUAL = `အသုံးပြုနည်း

1. VPN ဝယ်ရန် သို့မဟုတ် အခမဲ့ စမ်းသုံးရန် ကိုနှိပ်ပါ။
2. Bot ကပေးတဲ့ VPN key ကို copy လုပ်ပါ။
3. Outline app ကိုဖွင့်ပြီး server key ထည့်ပါ။
4. အခြေအနေစစ်ရန် ကျွန်ုပ်၏ VPN သို့မဟုတ် GB စစ်ရန် ကိုနှိပ်ပါ။
5. သက်တမ်းမကုန်ခင် VPN သက်တမ်းတိုးရန် ကိုနှိပ်ပါ။
6. အကူအညီလိုရင် ကူညီမှု ကိုနှိပ်ပါ။`;

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
    return bot.sendMessage(chatId, "လက်ရှိအသုံးပြုနေတဲ့ VPN key မရှိသေးပါ။ VPN ဝယ်ရန် သို့မဟုတ် အခမဲ့ စမ်းသုံးရန် ကိုနှိပ်ပါ။", mainKeyboard);
  }

  const limitGb = Number(user.dataLimitGb || PLANS[user.plan]?.gb || 0);
  if (!limitGb) {
    return bot.sendMessage(chatId, "ဒီ key အတွက် data limit မသိမ်းထားပါ။ ကူညီမှု ကိုနှိပ်ပြီး ဆက်သွယ်ပါ။", mainKeyboard);
  }

  try {
    const usedBytes = await getUsageBytes(user.server, user.keyId);
    const remainingBytes = Math.max(0, limitGb * GB - usedBytes);

    return bot.sendMessage(chatId,
`VPN Data အခြေအနေ

Plan: ${user.plan} (${limitGb} GB)
သုံးပြီး: ${formatGb(usedBytes)} GB
ကျန်ရှိ: ${formatGb(remainingBytes)} GB
သက်တမ်းကုန်မည့်နေ့: ${formatDate(user.expireAt)}
ကျန်ရက်: ${daysLeft(user.expireAt)}`, mainKeyboard);
  } catch {
    return bot.sendMessage(chatId, "အခု GB မစစ်နိုင်သေးပါ။ ခဏနေရင် ထပ်စမ်းကြည့်ပါ။", mainKeyboard);
  }
}

async function sendMyVpn(chatId) {
  const user = await findLatestUser(chatId);
  if (!user) {
    return bot.sendMessage(chatId, "သင့်မှာ VPN key မရှိသေးပါ။ VPN ဝယ်ရန် သို့မဟုတ် အခမဲ့ စမ်းသုံးရန် ကိုနှိပ်ပါ။", mainKeyboard);
  }

  const active = user.active && user.expireAt > new Date();
  const status = active ? "အသုံးပြုနိုင်" : "သက်တမ်းကုန်";

  return bot.sendMessage(chatId,
`ကျွန်ုပ်၏ VPN

အခြေအနေ: ${status}
Region: ${user.region}
Plan: ${user.plan}
Data limit: ${user.dataLimitGb || PLANS[user.plan]?.gb || "-"} GB
သက်တမ်းကုန်မည့်နေ့: ${formatDate(user.expireAt)}
ကျန်ရက်: ${active ? daysLeft(user.expireAt) : 0}

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
    return bot.sendMessage(chatId, "မိတ်ဆက်လင့်ခ်ကို အခု မထုတ်ပေးနိုင်သေးပါ။ ခဏနေရင် ထပ်စမ်းကြည့်ပါ။", mainKeyboard);
  }

  const link = `https://t.me/${botUsername}?start=ref_${chatId}`;
  return bot.sendMessage(chatId,
`မိတ်ဆက်အစီအစဉ်

ဒီ link ကို မိတ်ဆွေတွေကို မျှဝေပါ:
${link}

သင့်မိတ်ဆွေ VPN ဝယ်ပြီးရင် သင့်အကောင့်မှာ ${REFERRAL_BONUS_DAYS} ရက် bonus ထပ်ပေးပါမယ်။`);
}

async function sendSupport(chatId) {
  return bot.sendMessage(chatId,
`ကူညီမှု

ဆက်သွယ်ရန်: ${SUPPORT_CONTACT}

အကူအညီလိုရင် ဒီ Telegram ID ကို ပို့ပေးပါ:
${chatId}`, mainKeyboard);
}

async function startOrder(msg, type) {
  const chatId = String(msg.chat.id);
  const regions = await listRegions();

  if (regions.length === 0) {
    return bot.sendMessage(chatId, "လက်ရှိ VPN server မရှိသေးပါ။");
  }

  if (type === "renew") {
    const user = await findLatestUser(chatId);
    if (!user) {
      return bot.sendMessage(chatId, "သက်တမ်းတိုးရန် VPN key မတွေ့ပါ။ အရင်ဆုံး VPN ဝယ်ရန် ကိုနှိပ်ပါ။", mainKeyboard);
    }
  }

  const prefix = type === "renew" ? "renew_region" : "region";
  return bot.sendMessage(chatId, type === "renew" ? "သက်တမ်းတိုးမည့် region ရွေးပါ" : "Region ရွေးပါ", {
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
`${order.type === "renew" ? "VPN သက်တမ်းတိုးရန်" : "VPN ဝယ်ရန်"}

Region: ${order.region}
Plan: ${order.plan} GB
ကျသင့်ငွေ: ${order.amount} Ks

KPay/AyaPay: ${process.env.KPAY}

ငွေပေးချေပြီးရင် screenshot ကို ဒီ chat ထဲ ပို့ပါ။
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
`မိတ်ဆက် bonus ထည့်ပြီးပါပြီ။

Bonus: ${REFERRAL_BONUS_DAYS} ရက်
သက်တမ်းအသစ်: ${formatDate(referrer.expireAt)}`);
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
      keyMessage = `VPN သက်တမ်းတိုးပြီးပါပြီ။

Plan: ${order.plan} GB
သက်တမ်းအသစ်: ${formatDate(user.expireAt)}

VPN key အဟောင်းကိုပဲ ဆက်သုံးနိုင်ပါတယ်:
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
သက်တမ်းကုန်မည့်နေ့: ${formatDate(expireAt)}

${key}

Setup အကူအညီလိုရင် အသုံးပြုနည်း ကိုနှိပ်ပါ။`;
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
    return bot.sendMessage(chatId, "အခမဲ့ စမ်းသုံး key ကို user တစ်ယောက်လျှင် တစ်ကြိမ်သာ ရနိုင်ပါတယ်။", mainKeyboard);
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
`အခမဲ့ စမ်းသုံး VPN Key

Data: ${TRIAL_GB} GB
သက်တမ်းကုန်မည့်နေ့: ${formatDate(expireAt)}

${key}

Setup အကူအညီလိုရင် အသုံးပြုနည်း ကိုနှိပ်ပါ။`, mainKeyboard);
  } catch (err) {
    await TrialClaim.deleteOne({ telegramId: String(chatId) });
    return bot.sendMessage(chatId, "အခု စမ်းသုံး key မထုတ်ပေးနိုင်သေးပါ။ ခဏနေရင် ထပ်စမ်းကြည့်ပါ။", mainKeyboard);
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

  bot.sendMessage(chatId, "မင်္ဂလာပါ။ Menu ထဲက လိုချင်တဲ့ အချက်ကို ရွေးပါ။", mainKeyboard);
});

bot.onText(/^(Buy VPN|VPN ဝယ်ရန်|\/buy)$/i, async (msg) => {
  await startOrder(msg, "new");
});

bot.onText(/^(Renew VPN|VPN သက်တမ်းတိုးရန်|\/renew)$/i, async (msg) => {
  await startOrder(msg, "renew");
});

bot.onText(/^(My VPN|ကျွန်ုပ်၏ VPN|\/myvpn)$/i, async (msg) => {
  await sendMyVpn(String(msg.chat.id));
});

bot.onText(/^(Check GB|GB စစ်ရန်|\/gb)$/i, async (msg) => {
  await sendUsage(String(msg.chat.id));
});

bot.onText(/^(Referral|မိတ်ဆက်လင့်ခ်|\/referral)$/i, async (msg) => {
  await sendReferral(String(msg.chat.id));
});

bot.onText(/^(Support|ကူညီမှု|\/support)$/i, async (msg) => {
  await sendSupport(String(msg.chat.id));
});

bot.onText(/^(Outline Download Guide|Outline ဒေါင်းလုဒ်|\/guide)$/i, (msg) => {
  bot.sendMessage(msg.chat.id, GUIDE, mainKeyboard);
});

bot.onText(/^(User Manual|အသုံးပြုနည်း|\/manual)$/i, (msg) => {
  bot.sendMessage(msg.chat.id, MANUAL, mainKeyboard);
});

bot.onText(/^(Free Test Key|အခမဲ့ စမ်းသုံးရန်|\/trial)$/i, async (msg) => {
  const chatId = String(msg.chat.id);
  const regions = await listRegions();
  if (regions.length === 0) {
    return bot.sendMessage(chatId, "လက်ရှိ VPN server မရှိသေးပါ။");
  }

  bot.sendMessage(chatId, "အခမဲ့ စမ်းသုံးရန် region ရွေးပါ။", {
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

    return bot.sendMessage(chatId, "Plan ရွေးပါ", {
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

    await bot.sendMessage(order.telegramId, "ငွေပေးချေမှုကို reject လုပ်ထားပါတယ်။ မှားယွင်းတယ်ထင်ရင် ကူညီမှု ကိုနှိပ်ပြီး ဆက်သွယ်ပါ။", mainKeyboard);
    return bot.sendMessage(ADMIN_ID, `Rejected order ${orderId}`);
  }

  if (data.startsWith("resubmit_order_")) {
    const orderId = data.replace("resubmit_order_", "");
    const order = await PendingOrder.findById(orderId);
    if (!order) return bot.sendMessage(ADMIN_ID, "Order not found.");

    order.status = "needs_better_screenshot";
    await order.save();

    await bot.sendMessage(order.telegramId, "Order အတွက် payment screenshot ကို ပိုရှင်းရှင်းလင်းလင်း ပြန်ပို့ပေးပါ။", mainKeyboard);
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
  await bot.sendMessage(chatId, "Payment screenshot လက်ခံရရှိပါပြီ။ Admin စစ်ဆေးပြီး အတည်ပြုပေးပါမယ်။", mainKeyboard);
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
`သင့် VPN key သက်တမ်း မကြာခင် ကုန်တော့မယ်။

ကျန်ရက်: ${daysLeft(user.expireAt)}
VPN ဆက်သုံးရန် VPN သက်တမ်းတိုးရန် ကိုနှိပ်ပါ။`, mainKeyboard);
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
      await bot.sendMessage(user.telegramId, "VPN သက်တမ်းကုန်သွားပါပြီ။ ဆက်သုံးရန် VPN သက်တမ်းတိုးရန် ကိုနှိပ်ပါ။", mainKeyboard);
    } catch {}
  }
}, 3600000);

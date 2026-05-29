require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const https = require("https");

require("./db");

const { PLANS, getServer, listRegions } = require("./config");
const User = require("./models/User");
const Order = require("./models/Order");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const ADMIN_ID = String(process.env.ADMIN_ID);
const agent = new https.Agent({ rejectUnauthorized: false });
const GB = 1024 * 1024 * 1024;
const TRIAL_GB = Number(process.env.TRIAL_GB || 5);
const EXPIRY_REMINDER_DAYS = Number(process.env.EXPIRY_REMINDER_DAYS || 3);

const userState = {};

const mainKeyboard = {
  reply_markup: {
    keyboard: [
      ["Buy VPN", "Check GB"],
      ["Free Test Key"],
      ["Outline Download Guide", "User Manual"]
    ],
    resize_keyboard: true
  }
};

const DOWNLOAD_GUIDE_MM = `Outline Download Guide

Android:
1. Google Play Store ကိုဖွင့်ပါ။
2. "Outline" လို့ရှာပြီး Outline app ကို install လုပ်ပါ။
3. VPN key ကို copy လုပ်ပြီး Outline app ထဲမှာ Add Server နှိပ်ပါ။

iPhone / iPad:
1. App Store ကိုဖွင့်ပါ။
2. "Outline App" ကို install လုပ်ပါ။
3. VPN key ကို copy လုပ်ပြီး Outline app ထဲမှာ Add Server နှိပ်ပါ။
4. VPN configuration ခွင့်ပြုရန် Allow ကိုနှိပ်ပါ။

Windows:
1. Official Outline Client ကို download လုပ်ပါ။
https://s3.amazonaws.com/outline-releases/client/windows/stable/Outline-Client.exe
2. Install လုပ်ပြီး VPN key ကို paste လုပ်ပါ။
3. Add Server နှိပ်ပြီး Connect လုပ်ပါ။

macOS:
1. App Store မှ Outline App ကို install လုပ်ပါ။
https://itunes.apple.com/us/app/outline-app/id1356178125
2. VPN key ကို paste လုပ်ပြီး Add Server နှိပ်ပါ။

Android official link:
https://play.google.com/store/apps/details?id=org.outline.android.client

iOS official link:
https://itunes.apple.com/us/app/outline-app/id1356177741`;

const USER_MANUAL_MM = `အသုံးပြုနည်း Manual

1. Bot မှပေးသော VPN key ကို copy လုပ်ပါ။
2. Outline app ကိုဖွင့်ပါ။
3. Add Server / + ကိုနှိပ်ပြီး key ကို paste လုပ်ပါ။
4. Add Server နှိပ်ပြီး Connect လုပ်ပါ။
5. မချိတ်နိုင်ပါက Wi-Fi / Mobile Data ပြောင်းစမ်းပါ။
6. GB လက်ကျန်ကြည့်ရန် bot ထဲမှာ "Check GB" ကိုနှိပ်ပါ။
7. သက်တမ်းကုန်ခါနီးလျှင် bot က reminder ပို့ပါမည်။
8. Payment screenshot ပို့ပြီးနောက် admin approve လုပ်မှ key ရပါမည်။`;

// ===== CREATE KEY =====
async function createKey(api, username, gb) {
  const res = await axios.post(`${api}/access-keys`,
    { name: username },
    { httpsAgent: agent });

  const keyId = res.data.id;

  await axios.put(`${api}/access-keys/${keyId}/data-limit`, {
    limit: { bytes: gb * 1024 * 1024 * 1024 }
  }, { httpsAgent: agent });

  return { key: res.data.accessUrl, keyId };
}

async function getUsageBytes(server, keyId) {
  const res = await axios.get(`${server}/metrics/transfer`, { httpsAgent: agent });
  return Number(res.data?.bytesTransferredByUserId?.[keyId] || 0);
}

function formatGb(bytes) {
  return (bytes / GB).toFixed(2);
}

function daysLeft(expireAt) {
  return Math.max(0, Math.ceil((expireAt.getTime() - Date.now()) / 86400000));
}

async function findActiveUser(telegramId) {
  return User.findOne({
    telegramId: String(telegramId),
    active: true,
    expireAt: { $gt: new Date() }
  }).sort({ expireAt: -1 });
}

async function sendUsage(chatId) {
  const user = await findActiveUser(chatId);
  if (!user) {
    return bot.sendMessage(chatId, "Active VPN key မရှိသေးပါ။ Buy VPN သို့မဟုတ် Free Test Key ကိုနှိပ်ပါ။", mainKeyboard);
  }

  const limitGb = Number(user.dataLimitGb || PLANS[user.plan]?.gb || 0);
  if (!limitGb) {
    return bot.sendMessage(chatId, "ဒီ key အတွက် GB limit မတွေ့ပါ။ Admin ကိုဆက်သွယ်ပါ။", mainKeyboard);
  }

  try {
    const usedBytes = await getUsageBytes(user.server, user.keyId);
    const limitBytes = limitGb * GB;
    const remainingBytes = Math.max(0, limitBytes - usedBytes);

    return bot.sendMessage(chatId,
`သင့် VPN GB အခြေအနေ

စုစုပေါင်း: ${limitGb} GB
သုံးပြီး: ${formatGb(usedBytes)} GB
ကျန်ရှိ: ${formatGb(remainingBytes)} GB
သက်တမ်းကျန်: ${daysLeft(user.expireAt)} ရက်`);
  } catch (err) {
    return bot.sendMessage(chatId, "GB အခြေအနေကို အခုမစစ်နိုင်သေးပါ။ ခဏနေရင် ပြန်စမ်းပါ။");
  }
}

async function createTrialKey(chatId, region, from) {
  const existingUser = await User.findOne({ telegramId: String(chatId) });
  if (existingUser) {
    return bot.sendMessage(chatId, "Free test key ကို customer အသစ်များအတွက် တစ်ကြိမ်သာပေးပါသည်။", mainKeyboard);
  }

  const api = await getServer(region);
  const username = from?.username ? `trial_@${from.username}` : `trial_${chatId}`;
  const { key, keyId } = await createKey(api, username, TRIAL_GB);

  const expireAt = new Date();
  expireAt.setDate(expireAt.getDate() + 3);

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
    trialStartedAt: new Date()
  });

  return bot.sendMessage(chatId,
`Free Test VPN Key (3 days)
Data: ${TRIAL_GB} GB

${key}

အသုံးပြုနည်းကြည့်ရန် "User Manual" ကိုနှိပ်ပါ။`, mainKeyboard);
}

// ===== START =====
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "VPN ဝယ်ရန်၊ GB စစ်ရန်၊ guide ကြည့်ရန် menu မှရွေးပါ။", mainKeyboard);
});

// ===== BUY =====
bot.onText(/Buy VPN/, async (msg) => {
  const regions = await listRegions();

  if (regions.length === 0) {
    return bot.sendMessage(msg.chat.id, "No VPN servers are available right now.");
  }

  bot.sendMessage(msg.chat.id, "Select Region", {
    reply_markup: {
      inline_keyboard: regions.map(region => [{
        text: region.label,
        callback_data: `region_${region.code}`
      }])
    }
  });
});

// ===== CHECK GB =====
bot.onText(/^(Check GB|\/gb)$/i, async (msg) => {
  await sendUsage(String(msg.chat.id));
});

// ===== GUIDES =====
bot.onText(/^(Outline Download Guide|\/guide)$/i, (msg) => {
  bot.sendMessage(msg.chat.id, DOWNLOAD_GUIDE_MM, mainKeyboard);
});

bot.onText(/^(User Manual|\/manual)$/i, (msg) => {
  bot.sendMessage(msg.chat.id, USER_MANUAL_MM, mainKeyboard);
});

// ===== FREE TRIAL =====
bot.onText(/^(Free Test Key|\/trial)$/i, async (msg) => {
  const chatId = String(msg.chat.id);
  const existingUser = await User.findOne({ telegramId: chatId });
  if (existingUser) {
    return bot.sendMessage(chatId, "Free test key ကို customer အသစ်များအတွက် တစ်ကြိမ်သာပေးပါသည်။", mainKeyboard);
  }

  const regions = await listRegions();
  if (regions.length === 0) {
    return bot.sendMessage(chatId, "No VPN servers are available right now.");
  }

  bot.sendMessage(chatId, "Free test key အတွက် Region ရွေးပါ။", {
    reply_markup: {
      inline_keyboard: regions.map(region => [{
        text: region.label,
        callback_data: `trial_region_${region.code}`
      }])
    }
  });
});

// ===== CALLBACK =====
bot.on("callback_query", async (q) => {
  const chatId = String(q.message.chat.id);
  const data = q.data;

  if (data.startsWith("region_")) {
    const region = data.split("_")[1];
    userState[chatId] = { region };

    bot.sendMessage(chatId, "Select Plan", {
      reply_markup: {
        inline_keyboard: Object.keys(PLANS).map(p => [{
          text: `${p}GB - ${PLANS[p].price} Ks`,
          callback_data: `plan_${p}`
        }])
      }
    });
  }

  if (data.startsWith("trial_region_")) {
    const region = data.replace("trial_region_", "");
    await createTrialKey(chatId, region, q.from);
  }

  if (data.startsWith("plan_")) {
    const plan = data.split("_")[1];
    if (!userState[chatId]) {
      return bot.sendMessage(chatId, "Please choose a region first.");
    }

    userState[chatId].plan = plan;

    bot.sendMessage(chatId,
`Pay ${PLANS[plan].price} Ks
KPay/AyaPay: ${process.env.KPAY}

Send screenshot`);
  }

  if (data.startsWith("approve_")) {
    const userId = data.split("_")[1];
    const state = userState[userId];
    if (!state?.region || !state?.plan) {
      return bot.sendMessage(ADMIN_ID, "This order is missing region or plan. Ask the user to order again.");
    }

    const api = await getServer(state.region);

    const { key, keyId } = await createKey(api, userId, PLANS[state.plan].gb);

    const expireAt = new Date();
    expireAt.setMonth(expireAt.getMonth() + 1);

    await User.create({
      telegramId: userId,
      region: state.region,
      plan: state.plan,
      key,
      keyId,
      server: api,
      dataLimitGb: PLANS[state.plan].gb,
      expireAt,
      active: true
    });

    await Order.create({
      telegramId: userId,
      amount: PLANS[state.plan].price,
      region: state.region,
      plan: state.plan
    });

    bot.sendMessage(userId, `VPN Key:\n${key}\n\nအသုံးပြုနည်းကြည့်ရန် "User Manual" ကိုနှိပ်ပါ။`, mainKeyboard);

    delete userState[userId];
  }
});

// ===== SCREENSHOT =====
function orderCaption(msg, state) {
  const price = PLANS[state.plan]?.price;
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.id;

  return `New Order

User: ${username}
Region: ${state.region}
Plan: ${state.plan}GB
Price transfered: ${price} Ks`;
}

function orderApprovalMarkup(chatId) {
  return {
    inline_keyboard: [
      [{ text: "Approve", callback_data: `approve_${chatId}` }]
    ]
  };
}

bot.on("photo", (msg) => {
  const chatId = String(msg.chat.id);
  if (!userState[chatId]) return;

  const state = userState[chatId];
  const photo = msg.photo[msg.photo.length - 1];

  bot.sendPhoto(ADMIN_ID, photo.file_id, {
    caption: orderCaption(msg, state),
    reply_markup: orderApprovalMarkup(chatId)
  });
});

bot.on("document", (msg) => {
  const chatId = String(msg.chat.id);
  if (!userState[chatId]) return;
  if (!msg.document?.mime_type?.startsWith("image/")) return;

  bot.sendDocument(ADMIN_ID, msg.document.file_id, {
    caption: orderCaption(msg, userState[chatId]),
    reply_markup: orderApprovalMarkup(chatId)
  });
});

// ===== EXPIRY CHECK =====
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

  for (let u of reminderUsers) {
    try {
      await bot.sendMessage(u.telegramId,
`သင့် VPN key သက်တမ်းကုန်ခါနီးပါပြီ။

သက်တမ်းကျန်: ${daysLeft(u.expireAt)} ရက်
ဆက်သုံးချင်ပါက renewal အတွက် admin ကိုဆက်သွယ်ပါ။`);
      u.reminderSentAt = new Date();
      await u.save();
    } catch {}
  }

  const users = await User.find({
    expireAt: { $lt: now },
    active: true
  });

  for (let u of users) {
    try {
      await axios.delete(`${u.server}/access-keys/${u.keyId}`,
        { httpsAgent: agent });

      u.active = false;
      await u.save();

      bot.sendMessage(u.telegramId, "VPN expired");
    } catch {}
  }
}, 3600000);

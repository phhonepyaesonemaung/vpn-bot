require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const https = require("https");

require("./db");

const { PLANS, getServer } = require("./config");
const User = require("./models/User");
const Order = require("./models/Order");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const ADMIN_ID = String(process.env.ADMIN_ID);
const agent = new https.Agent({ rejectUnauthorized: false });

const userState = {};

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

// ===== START =====
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Buy VPN", {
    reply_markup: { keyboard: [["Buy VPN"]], resize_keyboard: true }
  });
});

// ===== BUY =====
bot.onText(/Buy VPN/, (msg) => {
  bot.sendMessage(msg.chat.id, "Select Region", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Singapore 🇸🇬", callback_data: "region_SG" }],
        [{ text: "Japan 🇯🇵", callback_data: "region_JP" }]
      ]
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

  if (data.startsWith("plan_")) {
    const plan = data.split("_")[1];
    userState[chatId].plan = plan;

    bot.sendMessage(chatId,
`Pay ${PLANS[plan].price} Ks
KPay/AyaPay: ${process.env.KPAY}

Send screenshot`);
  }

  if (data.startsWith("approve_")) {
    const userId = data.split("_")[1];
    const state = userState[userId];

    const api = getServer(state.region);

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
      expireAt,
      active: true
    });

    await Order.create({
      telegramId: userId,
      amount: PLANS[state.plan].price,
      region: state.region,
      plan: state.plan
    });

    bot.sendMessage(userId, `VPN Key:\n${key}`);
  }
});

// ===== SCREENSHOT =====
bot.on("photo", (msg) => {
  const chatId = String(msg.chat.id);
  if (!userState[chatId]) return;

  const state = userState[chatId];
  const price = PLANS[state.plan]?.price;
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.id;

  bot.sendMessage(ADMIN_ID,
`📥 New Order

User: ${username}
Region: ${state.region}
Plan: ${state.plan}GB
Price transfered: ${price} Ks`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Approve", callback_data: `approve_${chatId}` }]
      ]
    }
  });
});

// ===== EXPIRY CHECK =====
setInterval(async () => {
  const now = new Date();

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
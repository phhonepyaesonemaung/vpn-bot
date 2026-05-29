const express = require("express");
const axios = require("axios");
const https = require("https");
const Order = require("./models/Order");
const User = require("./models/User");
const OutlineServer = require("./models/OutlineServer");
const PendingOrder = require("./models/PendingOrder");
const { REGION_LABELS, listServers } = require("./config");

require("./db");

const app = express();
const PORT = process.env.DASHBOARD_PORT || process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const GB = 1024 * 1024 * 1024;
const agent = new https.Agent({ rejectUnauthorized: false });

app.use(express.urlencoded({ extended: false }));

function formatDate(date) {
  if (!date) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: process.env.DASHBOARD_TIMEZONE || "Asia/Rangoon"
  }).format(date);
}

function formatMoney(amount) {
  return `${Number(amount || 0).toLocaleString("en-US")} Ks`;
}

function formatGb(bytes) {
  return `${(Number(bytes || 0) / GB).toFixed(2)} GB`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function maskApiUrl(apiUrl) {
  if (!apiUrl) return "-";

  try {
    const url = new URL(apiUrl);
    const suffix = url.pathname.slice(-6);
    return `${url.origin}/...${suffix}`;
  } catch {
    return `${apiUrl.slice(0, 16)}...`;
  }
}

function dashboardAuth(req, res, next) {
  if (!DASHBOARD_PASSWORD) return next();

  const auth = req.headers.authorization || "";
  const [scheme, encoded] = auth.split(" ");

  if (scheme === "Basic" && encoded) {
    const [, password] = Buffer.from(encoded, "base64").toString().split(":");
    if (password === DASHBOARD_PASSWORD) return next();
  }

  res.set("WWW-Authenticate", 'Basic realm="VPN Dashboard"');
  return res.status(401).send("Authentication required");
}

async function getServerHealth(server) {
  const activeUsers = await User.countDocuments({
    server: server.apiUrl,
    active: true,
    expireAt: { $gt: new Date() }
  });

  try {
    const res = await axios.get(`${server.apiUrl}/metrics/transfer`, {
      httpsAgent: agent,
      timeout: 5000
    });
    const transfers = Object.values(res.data?.bytesTransferredByUserId || {});
    const transferred = transfers.reduce((sum, value) => sum + Number(value || 0), 0);

    return {
      ...server,
      activeUsers,
      online: true,
      transferred
    };
  } catch {
    return {
      ...server,
      activeUsers,
      online: false,
      transferred: 0
    };
  }
}

app.use(dashboardAuth);

app.post("/servers", async (req, res) => {
  const region = String(req.body.region || "").trim().toUpperCase();
  const name = String(req.body.name || "").trim();
  const apiUrl = String(req.body.apiUrl || "").trim();

  if (region && name && apiUrl) {
    await OutlineServer.updateOne(
      { region, apiUrl },
      { $set: { name } },
      { upsert: true }
    );
  }

  res.redirect("/");
});

app.post("/servers/delete", async (req, res) => {
  const id = String(req.body.id || "").trim();

  if (id.match(/^[a-f0-9]{24}$/i)) {
    await OutlineServer.findByIdAndDelete(id);
  }

  res.redirect("/");
});

app.post("/users/extend", async (req, res) => {
  const id = String(req.body.id || "").trim();
  const days = Math.max(1, Number(req.body.days || 0));

  if (id.match(/^[a-f0-9]{24}$/i) && days) {
    const user = await User.findById(id);
    if (user) {
      const base = user.expireAt && user.expireAt > new Date() ? user.expireAt : new Date();
      user.expireAt = new Date(base.getTime() + days * 86400000);
      user.active = true;
      user.reminderSentAt = null;
      await user.save();
    }
  }

  res.redirect("/");
});

app.post("/users/disable", async (req, res) => {
  const id = String(req.body.id || "").trim();

  if (id.match(/^[a-f0-9]{24}$/i)) {
    const user = await User.findById(id);
    if (user) {
      try {
        await axios.delete(`${user.server}/access-keys/${user.keyId}`, {
          httpsAgent: agent,
          timeout: 5000
        });
      } catch {}

      user.active = false;
      await user.save();
    }
  }

  res.redirect("/");
});

app.post("/users/plan", async (req, res) => {
  const id = String(req.body.id || "").trim();
  const dataLimitGb = Math.max(1, Number(req.body.dataLimitGb || 0));

  if (id.match(/^[a-f0-9]{24}$/i) && dataLimitGb) {
    const user = await User.findById(id);
    if (user) {
      user.dataLimitGb = dataLimitGb;
      await user.save();
      try {
        await axios.put(`${user.server}/access-keys/${user.keyId}/data-limit`, {
          limit: { bytes: Math.ceil(dataLimitGb * GB) }
        }, {
          httpsAgent: agent,
          timeout: 5000
        });
      } catch {}
    }
  }

  res.redirect("/");
});

app.get("/", async (req, res) => {
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const search = String(req.query.search || "").trim();
  const userQuery = search
    ? { telegramId: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") } }
    : {};

  const [
    totalOrders,
    revenueAgg,
    todayAgg,
    monthAgg,
    activeUsers,
    expiredUsers,
    pendingOrders,
    users,
    outlineServers
  ] = await Promise.all([
    Order.countDocuments(),
    Order.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }]),
    Order.aggregate([
      { $match: { createdAt: { $gte: startOfToday } } },
      { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }
    ]),
    Order.aggregate([
      { $match: { createdAt: { $gte: startOfMonth } } },
      { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }
    ]),
    User.countDocuments({ active: true, expireAt: { $gte: now } }),
    User.countDocuments({ $or: [{ active: false }, { expireAt: { $lt: now } }] }),
    PendingOrder.find({ status: { $in: ["awaiting_payment", "pending_admin", "needs_better_screenshot"] } })
      .sort({ createdAt: -1 })
      .lean(),
    User.find(userQuery).sort({ active: -1, expireAt: 1 }).limit(200).lean(),
    listServers()
  ]);

  const serversWithHealth = await Promise.all(outlineServers.map(getServerHealth));
  const totalRevenue = revenueAgg[0]?.total || 0;
  const todayRevenue = todayAgg[0]?.total || 0;
  const monthRevenue = monthAgg[0]?.total || 0;
  const averageOrder = totalOrders ? totalRevenue / totalOrders : 0;
  const averageDailyRevenue = monthRevenue / now.getDate();

  const serverRows = serversWithHealth.map((server) => `
    <tr>
      <td>${escapeHtml(server.region)}</td>
      <td>${escapeHtml(server.name)}</td>
      <td><span class="pill ${server.online ? "active" : "expired"}">${server.online ? "Online" : "Offline"}</span></td>
      <td>${server.activeUsers}</td>
      <td>${formatGb(server.transferred)}</td>
      <td>${escapeHtml(maskApiUrl(server.apiUrl))}</td>
      <td>
        <form method="post" action="/servers/delete">
          <input type="hidden" name="id" value="${escapeHtml(server._id)}">
          <button class="danger" type="submit">Delete</button>
        </form>
      </td>
    </tr>
  `).join("");

  const pendingRows = pendingOrders.map((order) => `
    <tr>
      <td>${escapeHtml(order._id)}</td>
      <td>${escapeHtml(order.type)}</td>
      <td>${escapeHtml(order.telegramId)}</td>
      <td>${escapeHtml(order.region)}</td>
      <td>${escapeHtml(order.plan)} GB</td>
      <td>${formatMoney(order.amount)}</td>
      <td><span class="pill pending">${escapeHtml(order.status)}</span></td>
      <td>${formatDate(order.createdAt)}</td>
    </tr>
  `).join("");

  const userRows = users.map((user) => {
    const expired = !user.active || !user.expireAt || user.expireAt < now;
    const status = expired ? "Expired" : "Active";
    const statusClass = expired ? "expired" : "active";

    return `
      <tr>
        <td>${escapeHtml(user.telegramId)}</td>
        <td>${escapeHtml(user.region)}</td>
        <td>${escapeHtml(user.plan)} GB</td>
        <td>${escapeHtml(user.dataLimitGb || "-")} GB</td>
        <td>${escapeHtml(user.keyId || "-")}</td>
        <td>${formatDate(user.expireAt)}</td>
        <td><span class="pill ${statusClass}">${status}</span></td>
        <td class="actions">
          <form method="post" action="/users/extend">
            <input type="hidden" name="id" value="${escapeHtml(user._id)}">
            <input class="small" name="days" value="30" type="number" min="1">
            <button type="submit">Extend</button>
          </form>
          <form method="post" action="/users/plan">
            <input type="hidden" name="id" value="${escapeHtml(user._id)}">
            <input class="small" name="dataLimitGb" value="${escapeHtml(user.dataLimitGb || 50)}" type="number" min="1">
            <button type="submit">GB</button>
          </form>
          <form method="post" action="/users/disable">
            <input type="hidden" name="id" value="${escapeHtml(user._id)}">
            <button class="danger" type="submit">Disable</button>
          </form>
        </td>
      </tr>
    `;
  }).join("");

  const regionOptions = Object.entries(REGION_LABELS).map(([code, label]) =>
    `<option value="${escapeHtml(code)}">${escapeHtml(label)} (${escapeHtml(code)})</option>`
  ).join("");

  res.send(`
    <!doctype html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="refresh" content="45">
      <title>VPN Dashboard</title>
      <style>
        * { box-sizing: border-box; }
        body { margin: 0; font-family: Arial, sans-serif; background: #f6f7f9; color: #1f2933; }
        header { background: #102a43; color: white; padding: 22px 28px; }
        header h1 { margin: 0 0 6px; font-size: 24px; }
        header p { margin: 0; color: #bcccdc; font-size: 14px; }
        main { padding: 24px 28px; max-width: 1440px; margin: 0 auto; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 24px; }
        .stat, .panel { background: white; border: 1px solid #d9e2ec; border-radius: 8px; }
        .stat { padding: 16px; }
        .stat span { display: block; color: #52606d; font-size: 13px; margin-bottom: 8px; }
        .stat strong { font-size: 24px; }
        .panel { margin-bottom: 24px; overflow: hidden; }
        h2 { font-size: 18px; margin: 0; padding: 16px; border-bottom: 1px solid #d9e2ec; }
        .server-form, .search-form { display: grid; grid-template-columns: 150px 1fr 2fr auto; gap: 12px; padding: 16px; border-bottom: 1px solid #d9e2ec; }
        .search-form { grid-template-columns: 1fr auto; }
        .table-scroll { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; min-width: 920px; }
        th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #edf2f7; font-size: 14px; vertical-align: top; }
        th { color: #52606d; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; background: #f8fafc; }
        input, select, button { height: 38px; border-radius: 6px; border: 1px solid #bcccdc; padding: 0 10px; font: inherit; }
        button { border-color: #0f609b; background: #0f609b; color: white; cursor: pointer; font-weight: 700; }
        button.danger { border-color: #b91c1c; background: #b91c1c; }
        td form { margin: 0; }
        .actions { min-width: 340px; }
        .actions form { display: inline-grid; grid-template-columns: auto auto auto; gap: 6px; margin: 0 4px 6px 0; }
        .small { width: 72px; }
        .pill { display: inline-block; border-radius: 999px; padding: 4px 9px; font-size: 12px; font-weight: 700; }
        .active { background: #dcfce7; color: #166534; }
        .expired { background: #fee2e2; color: #991b1b; }
        .pending { background: #fef3c7; color: #92400e; }
        @media (max-width: 760px) {
          main { padding: 16px; }
          .server-form, .search-form { grid-template-columns: 1fr; }
        }
      </style>
    </head>
    <body>
      <header>
        <h1>VPN Dashboard</h1>
        <p>Last updated ${formatDate(now)}. Auto-refreshes every 45 seconds.</p>
      </header>

      <main>
        <section class="stats">
          <div class="stat"><span>Total revenue</span><strong>${formatMoney(totalRevenue)}</strong></div>
          <div class="stat"><span>Today revenue</span><strong>${formatMoney(todayRevenue)}</strong></div>
          <div class="stat"><span>This month revenue</span><strong>${formatMoney(monthRevenue)}</strong></div>
          <div class="stat"><span>Average order</span><strong>${formatMoney(averageOrder)}</strong></div>
          <div class="stat"><span>Average daily revenue</span><strong>${formatMoney(averageDailyRevenue)}</strong></div>
          <div class="stat"><span>Total orders</span><strong>${totalOrders}</strong></div>
          <div class="stat"><span>Pending orders</span><strong>${pendingOrders.length}</strong></div>
          <div class="stat"><span>Active keys</span><strong>${activeUsers}</strong></div>
          <div class="stat"><span>Expired keys</span><strong>${expiredUsers}</strong></div>
        </section>

        <section class="panel">
          <h2>Outline Servers</h2>
          <form class="server-form" method="post" action="/servers">
            <select name="region" aria-label="Region" required>${regionOptions}</select>
            <input name="name" placeholder="Server name" required>
            <input name="apiUrl" placeholder="Outline API URL" required>
            <button type="submit">Add Server</button>
          </form>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Region</th><th>Name</th><th>Status</th><th>Active Users</th><th>Total Transfer</th><th>API URL</th><th>Action</th>
                </tr>
              </thead>
              <tbody>${serverRows || '<tr><td colspan="7">No Outline servers configured.</td></tr>'}</tbody>
            </table>
          </div>
        </section>

        <section class="panel">
          <h2>Pending Orders</h2>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Order</th><th>Type</th><th>Telegram ID</th><th>Region</th><th>Plan</th><th>Amount</th><th>Status</th><th>Created</th>
                </tr>
              </thead>
              <tbody>${pendingRows || '<tr><td colspan="8">No pending orders.</td></tr>'}</tbody>
            </table>
          </div>
        </section>

        <section class="panel">
          <h2>Users</h2>
          <form class="search-form" method="get" action="/">
            <input name="search" placeholder="Search Telegram ID" value="${escapeHtml(search)}">
            <button type="submit">Search</button>
          </form>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Telegram ID</th><th>Region</th><th>Plan</th><th>Limit</th><th>Key ID</th><th>Expire Date</th><th>Status</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>${userRows || '<tr><td colspan="8">No VPN keys yet.</td></tr>'}</tbody>
            </table>
          </div>
        </section>
      </main>
    </body>
    </html>
  `);
});

app.listen(PORT, () =>
  console.log(`Dashboard: http://localhost:${PORT}`)
);

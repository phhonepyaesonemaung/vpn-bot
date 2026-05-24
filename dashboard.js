const express = require("express");
const Order = require("./models/Order");
const User = require("./models/User");

require("./db");

const app = express();
const PORT = process.env.DASHBOARD_PORT || process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

app.use(dashboardAuth);

app.get("/", async (req, res) => {
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    totalOrders,
    revenueAgg,
    todayAgg,
    monthAgg,
    activeUsers,
    expiredUsers,
    users
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
    User.countDocuments({
      $or: [{ active: false }, { expireAt: { $lt: now } }]
    }),
    User.find().sort({ active: -1, expireAt: 1 }).lean()
  ]);

  const totalRevenue = revenueAgg[0]?.total || 0;
  const todayRevenue = todayAgg[0]?.total || 0;
  const monthRevenue = monthAgg[0]?.total || 0;
  const averageOrder = totalOrders ? totalRevenue / totalOrders : 0;
  const dayOfMonth = now.getDate();
  const averageDailyRevenue = monthRevenue / dayOfMonth;

  const userRows = users.map((user) => {
    const expired = !user.active || !user.expireAt || user.expireAt < now;
    const status = expired ? "Expired" : "Active";
    const statusClass = expired ? "expired" : "active";

    return `
      <tr>
        <td>${escapeHtml(user.telegramId)}</td>
        <td>${escapeHtml(user.region)}</td>
        <td>${escapeHtml(user.plan)} GB</td>
        <td>${escapeHtml(user.keyId || "-")}</td>
        <td>${formatDate(user.expireAt)}</td>
        <td><span class="pill ${statusClass}">${status}</span></td>
      </tr>
    `;
  }).join("");

  res.send(`
    <!doctype html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="refresh" content="30">
      <title>VPN Dashboard</title>
      <style>
        * { box-sizing: border-box; }
        body {
          margin: 0;
          font-family: Arial, sans-serif;
          background: #f6f7f9;
          color: #1f2933;
        }
        header {
          background: #102a43;
          color: white;
          padding: 22px 28px;
        }
        header h1 {
          margin: 0 0 6px;
          font-size: 24px;
        }
        header p {
          margin: 0;
          color: #bcccdc;
          font-size: 14px;
        }
        main {
          padding: 24px 28px;
          max-width: 1280px;
          margin: 0 auto;
        }
        .stats {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
          gap: 14px;
          margin-bottom: 24px;
        }
        .stat {
          background: white;
          border: 1px solid #d9e2ec;
          border-radius: 8px;
          padding: 16px;
        }
        .stat span {
          display: block;
          color: #52606d;
          font-size: 13px;
          margin-bottom: 8px;
        }
        .stat strong {
          font-size: 24px;
        }
        .table-wrap {
          background: white;
          border: 1px solid #d9e2ec;
          border-radius: 8px;
          overflow-x: auto;
        }
        h2 {
          font-size: 18px;
          margin: 0;
          padding: 16px;
          border-bottom: 1px solid #d9e2ec;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          min-width: 760px;
        }
        th, td {
          padding: 12px 16px;
          text-align: left;
          border-bottom: 1px solid #edf2f7;
          font-size: 14px;
        }
        th {
          color: #52606d;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: .04em;
          background: #f8fafc;
        }
        .pill {
          display: inline-block;
          border-radius: 999px;
          padding: 4px 9px;
          font-size: 12px;
          font-weight: 700;
        }
        .active {
          background: #dcfce7;
          color: #166534;
        }
        .expired {
          background: #fee2e2;
          color: #991b1b;
        }
      </style>
    </head>
    <body>
      <header>
        <h1>VPN Dashboard</h1>
        <p>Last updated ${formatDate(now)}. Auto-refreshes every 30 seconds.</p>
      </header>

      <main>
        <section class="stats">
          <div class="stat"><span>Total revenue</span><strong>${formatMoney(totalRevenue)}</strong></div>
          <div class="stat"><span>Today revenue</span><strong>${formatMoney(todayRevenue)}</strong></div>
          <div class="stat"><span>This month revenue</span><strong>${formatMoney(monthRevenue)}</strong></div>
          <div class="stat"><span>Average order</span><strong>${formatMoney(averageOrder)}</strong></div>
          <div class="stat"><span>Average daily revenue</span><strong>${formatMoney(averageDailyRevenue)}</strong></div>
          <div class="stat"><span>Total orders</span><strong>${totalOrders}</strong></div>
          <div class="stat"><span>Active keys</span><strong>${activeUsers}</strong></div>
          <div class="stat"><span>Expired keys</span><strong>${expiredUsers}</strong></div>
        </section>

        <section class="table-wrap">
          <h2>Key Expiry</h2>
          <table>
            <thead>
              <tr>
                <th>Telegram ID</th>
                <th>Region</th>
                <th>Plan</th>
                <th>Key ID</th>
                <th>Expire date</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${userRows || '<tr><td colspan="6">No VPN keys yet.</td></tr>'}
            </tbody>
          </table>
        </section>
      </main>
    </body>
    </html>
  `);
});

app.listen(PORT, () =>
  console.log(`Dashboard: http://localhost:${PORT}`)
);

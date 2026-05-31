# VPN Bot

Telegram bot and web dashboard for selling and managing Outline VPN keys.

## Features

- Telegram customer menu for buying, renewing, checking VPN status, checking GB usage, free trial keys, referral links, support, and setup guides.
- Admin approval flow for payment screenshots.
- Outline server management from the dashboard.
- Dashboard stats for revenue, orders, pending payments, active keys, expired keys, and server health.
- Automatic expiry reminders and expired-key cleanup.
- Server status checker script for PM2, dashboard, MongoDB, and Telegram API.

## Requirements

- Node.js 18 or newer
- npm
- MongoDB
- PM2 for production deployment
- Telegram bot token from BotFather
- Outline Manager API URLs for your VPN servers

## Environment Variables

Create a `.env` file in the project root.

```env
BOT_TOKEN=your_telegram_bot_token
ADMIN_ID=your_telegram_numeric_id
MONGO_URI=mongodb://127.0.0.1:27017/vpn-bot

KPAY=your_kpay_payment_info
AYAPAY=your_ayapay_payment_info

DASHBOARD_PORT=3000
DASHBOARD_PASSWORD=change_this_password
DASHBOARD_TIMEZONE=Asia/Rangoon

SUPPORT_CONTACT=https://t.me/Htaminlake

TRIAL_GB=5
TRIAL_DAYS=3
EXPIRY_REMINDER_DAYS=3
REFERRAL_BONUS_DAYS=3

SG_API_1=https://server-ip:port/api-key
SG_API_2=https://server-ip:port/api-key
JP_API_1=https://server-ip:port/api-key
JP_API_2=https://server-ip:port/api-key
KR_API=https://server-ip:port/api-key
TH_API=https://server-ip:port/api-key
US_API=https://server-ip:port/api-key
```

Only add the server variables you actually use. The bot loads configured Outline servers into the dashboard.

## Local Development

Install dependencies:

```bash
npm install
```

Run the bot:

```bash
npm run bot
```

Run the dashboard:

```bash
npm run dashboard
```

Open the dashboard:

```text
http://localhost:3000
```

If `DASHBOARD_PASSWORD` is set, use Basic Auth. The username can be anything; the password must match `DASHBOARD_PASSWORD`.

## Production Deployment

Clone the repository on the server:

```bash
cd /root
git clone https://github.com/phhonepyaesonemaung/vpn-bot.git
cd vpn-bot
```

Install dependencies:

```bash
npm install --omit=dev
```

Create `.env`:

```bash
nano .env
```

Start with PM2:

```bash
pm2 start bot.js --name vpn-bot
pm2 start dashboard.js --name vpn-dashboard
pm2 save
pm2 startup
```

Check status:

```bash
pm2 status
pm2 logs vpn-bot --lines 30
pm2 logs vpn-dashboard --lines 30
```

## Updating The Server

Run this on the server after pushing changes to GitHub:

```bash
cd /root/vpn-bot
git pull
pm2 restart vpn-bot --update-env
pm2 restart vpn-dashboard --update-env
python3 check_server_status.py
```

## Health Check

Run:

```bash
python3 check_server_status.py
```

The expected result is:

```text
[OK] PM2
[OK] Dashboard
[OK] MongoDB TCP
[OK] Telegram API
```

If Telegram API fails with an IPv6 timeout, this project already prefers IPv4 in `bot.js`.

## Dashboard

The dashboard includes:

- Revenue summary
- Pending orders
- Outline server list and online/offline status
- Add/delete Outline servers
- User list
- Extend, disable, and change user GB limit

## Git Branch

The active branch is:

```text
master
```

Use `master` for deployment and updates.

## Security Notes

- Never commit `.env`.
- Rotate the Telegram bot token if it is pasted into logs, screenshots, chat, or GitHub.
- Use a strong `DASHBOARD_PASSWORD`.
- Keep MongoDB private to the server where possible.

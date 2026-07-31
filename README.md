# FiveM Sales Tracker

A tiny server that receives your business's sale events, stores them, and shows
a live dashboard with revenue charts. Optionally forwards each sale on to your
existing Discord webhook too, so you don't lose your current notifications.

## 1. Deploy to Railway (free tier)

1. Create a free account at https://railway.app
2. Click **New Project → Deploy from GitHub repo** (push this folder to a new
   GitHub repo first), or use **Empty Project → Deploy from local directory**
   with the Railway CLI:
   ```bash
   npm install -g @railway/cli
   railway login
   railway init
   railway up
   ```
3. In Railway, go to your project's **Variables** tab and add:
   - `API_KEY` — any secret string you make up, e.g. `mybiz-2026-secret`
   - `DISCORD_WEBHOOK_URL` — your existing Discord webhook URL (optional, only
     if you want sales still posted to Discord from this server)
4. Railway will give you a public URL like `https://your-app.up.railway.app`
5. Visit that URL in your browser — you'll see the dashboard (empty until
   sales start coming in).
6. **Important:** Railway's filesystem resets on redeploy by default. Add a
   **Volume** (Railway → your service → Settings → Volumes) mounted at
   `/app` (or wherever you deploy the app) so `sales.db` persists between
   deploys/restarts.

## 2. Point your FiveM script at it

Wherever your script currently sends a sale to Discord, add a second request
to your new server. Example in Lua (FiveM server-side):

```lua
-- Existing Discord webhook send (keep as-is, or remove if you set
-- DISCORD_WEBHOOK_URL on the server and let it forward for you)
local discordWebhook = "https://discord.com/api/webhooks/..."

-- New: send to your tracker
local trackerUrl = "sales-tracker-production-c832.up.railway.app"
local apiKey = "321123" -- must match API_KEY you set in Railway

PerformHttpRequest(trackerUrl, function(err, text, headers) end, 'POST',
  json.encode({
    item = itemName,   -- replace with your actual variable
    price = itemPrice  -- replace with your actual variable (number, not string)
  }),
  {
    ['Content-Type'] = 'application/json',
    ['x-api-key'] = apiKey
  }
)
```

Put this in the same place your script currently fires the Discord webhook
(right after a successful sale).

## 3. View your dashboard

Just open `https://your-app.up.railway.app` in a browser any time. It shows:

- Total revenue and total sales
- Average sale price
- **Top Sellers** — a ranked leaderboard of which items are selling the
  fastest, based on units sold per day since each item's first recorded sale
  (also shows how many hours pass between sales, on average, for that item)
- A line chart of revenue per day
- A bar chart of revenue per item

The page auto-refreshes every 30 seconds. Theme is a dark glass UI with blue
accents to match your existing crafting portal.

### How "fastest selling" is calculated

For each item, the server looks at time between its first recorded sale and
now, divides units sold by that time window, and ranks items by units/day
(highest first). An item selling 1 unit every 2 hours ranks above one selling
1 unit every 2 days, regardless of total revenue — so this table answers
"what's flying off the shelves" rather than "what makes the most money"
(that's what the Revenue By Item chart is for).

## Local testing (optional)

```bash
npm install
API_KEY=test123 node server.js
```

Then test it:
```bash
curl -X POST http://localhost:3000/sale \
  -H "Content-Type: application/json" \
  -H "x-api-key: test123" \
  -d '{"item":"Water Bottle","price":12.5}'
```

Visit http://localhost:3000 to see it show up on the dashboard.

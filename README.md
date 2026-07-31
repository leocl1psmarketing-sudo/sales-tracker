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
   - `OWNER_PASSWORD` — a password only you (the business owner) know, used
     to unlock the Owner tab on the dashboard
4. Railway will give you a public URL like `https://your-app.up.railway.app`
5. Visit that URL in your browser — you'll see the dashboard (empty until
   sales start coming in).
6. **Important:** Railway's filesystem resets on redeploy by default. Attach
   a **Volume** so `sales.db` persists between deploys/restarts:
   - In your Railway project, right-click your service's tile (or click its
     **⋯** menu) → **Attach Volume**
   - Set **Mount Path** to `/app/data`
   - Save (this triggers a redeploy)
   - Then add one more variable in the **Variables** tab:
     - Name: `DB_PATH` → Value: `/app/data`
   - This tells the server to save `sales.db` inside the mounted volume
     instead of the app folder, so it survives future deploys.

## 2. Set up the Discord bot (if you can't edit the FiveM script)

If you're just a player and can't modify the server's Lua scripts, this
project can instead run a small Discord bot that watches your Kiosk sale-log
channel directly and logs each sale automatically — no script access needed.

1. Go to https://discord.com/developers/applications → **New Application**
2. Click **Bot** in the sidebar → **Reset Token** → copy the token
3. Still on the Bot page, enable **Message Content Intent** under
   Privileged Gateway Intents
4. Go to **OAuth2 → URL Generator** → check scope **bot** → under
   permissions check **View Channels** and **Read Message History** →
   copy the generated URL, open it, and add the bot to your server
5. In Discord, enable Developer Mode (User Settings → Advanced), then
   right-click the channel with the sale messages → **Copy Channel ID**
6. In Railway's **Variables** tab, add:
   - `DISCORD_BOT_TOKEN` — the token from step 2
   - `DISCORD_CHANNEL_ID` — the channel ID from step 5

The bot parses lines formatted like `Item Name x1 ($100/unit)` from the
"Items" field of each sale embed. If your kiosk's message format looks
different from that, paste an example message and the parsing can be
adjusted.

**Never paste your bot token anywhere except Railway's Variables tab** —
not in chat, not in a GitHub file. If a token is ever exposed, reset it
immediately from the Discord Developer Portal.

## 3. (Alternative) Point your FiveM script at it directly

If you *do* have access to the FiveM script instead, you can skip the bot
entirely and send sales straight from the script:

Wherever your script currently sends a sale to Discord, add a second request
to your new server. Example in Lua (FiveM server-side):

```lua
-- Existing Discord webhook send (keep as-is, or remove if you set
-- DISCORD_WEBHOOK_URL on the server and let it forward for you)
local discordWebhook = "https://discord.com/api/webhooks/..."

-- New: send to your tracker
local trackerUrl = "https://your-app.up.railway.app/sale"
local apiKey = "mybiz-2026-secret" -- must match API_KEY you set in Railway

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

## Owner Tab — ending the week & viewing history

Click the **Owner** tab (top right of the dashboard) and enter your
`OWNER_PASSWORD` to unlock it. From there:

- **End This Week & Save** — takes a permanent snapshot of the current
  week's total revenue, total sales, and best sellers, saves it to history,
  then resets the live dashboard to zero so you can start tracking the next
  week fresh. Past data is never deleted — just moved into the weekly
  history list.
- **Past Weeks** — a list of every week you've ended, showing total revenue,
  total sales, and the best-selling item for that week. Click any week to
  expand its top 5 sellers.

The Owner tab uses your `OWNER_PASSWORD` (separate from `API_KEY`, which is
only for the FiveM/bot sale-logging endpoint). Only share the owner password
with people who should be able to close out weeks and view revenue history.

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

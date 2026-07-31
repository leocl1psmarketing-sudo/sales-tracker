const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- CONFIG ----
// Set this to your existing Discord webhook URL if you want this server
// to also forward sale notifications on to Discord (optional).
// You can also set it as an environment variable DISCORD_WEBHOOK_URL instead
// of hardcoding it here.
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

// A simple shared secret so random people on the internet can't post fake
// sales to your endpoint. Set this in your FiveM script too.
const API_KEY = process.env.API_KEY || 'change-this-secret';

// ---- DATABASE ----
// If you've attached a Railway Volume, set DB_PATH to its mount path
// (e.g. /app/data) so the database survives redeploys. Falls back to
// storing it next to the app if no volume is configured yet.
const fs = require('fs');
const dbDir = process.env.DB_PATH || __dirname;
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const db = new Database(path.join(dbDir, 'sales.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item TEXT NOT NULL,
    price REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const insertSale = db.prepare('INSERT INTO sales (item, price) VALUES (?, ?)');
const getAllSales = db.prepare('SELECT * FROM sales ORDER BY created_at ASC');

// ---- ROUTES ----

// Health check
app.get('/', (req, res) => {
  res.send('Sales tracker is running.');
});

// Endpoint your FiveM script (or a relay) posts sales to.
// Expected JSON body: { "item": "Water Bottle", "price": 12.50 }
app.post('/sale', async (req, res) => {
  const key = req.header('x-api-key');
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const { item, price } = req.body;

  if (!item || typeof price !== 'number') {
    return res.status(400).json({ error: 'Expected { item: string, price: number }' });
  }

  insertSale.run(item, price);

  // Optionally forward to Discord so you keep your existing notifications
  if (DISCORD_WEBHOOK_URL) {
    try {
      await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `💰 **${item}** sold for **$${price.toFixed(2)}**`
        })
      });
    } catch (err) {
      console.error('Failed to forward to Discord:', err.message);
    }
  }

  res.json({ success: true });
});

// Returns raw sales data for the dashboard
app.get('/api/sales', (req, res) => {
  res.json(getAllSales.all());
});

// Returns aggregated stats for the dashboard
app.get('/api/stats', (req, res) => {
  const sales = getAllSales.all();

  const totalRevenue = sales.reduce((sum, s) => sum + s.price, 0);
  const totalSales = sales.length;

  // Revenue grouped by day
  const byDay = {};
  for (const s of sales) {
    const day = s.created_at.split(' ')[0]; // YYYY-MM-DD
    byDay[day] = (byDay[day] || 0) + s.price;
  }

  // Revenue grouped by item
  const byItem = {};
  for (const s of sales) {
    byItem[s.item] = (byItem[s.item] || 0) + s.price;
  }

  // --- Top sellers by velocity (how fast each item is selling) ---
  // For each item: count units, revenue, and how many days it's been
  // on sale for (from first sale to now), then units/day = velocity.
  const itemStats = {};
  const now = new Date();

  for (const s of sales) {
    if (!itemStats[s.item]) {
      itemStats[s.item] = {
        item: s.item,
        unitsSold: 0,
        revenue: 0,
        firstSale: s.created_at,
        lastSale: s.created_at
      };
    }
    const stat = itemStats[s.item];
    stat.unitsSold += 1;
    stat.revenue += s.price;
    if (s.created_at < stat.firstSale) stat.firstSale = s.created_at;
    if (s.created_at > stat.lastSale) stat.lastSale = s.created_at;
  }

  const topSellers = Object.values(itemStats).map(stat => {
    const firstSaleDate = new Date(stat.firstSale + 'Z');
    const hoursActive = Math.max((now - firstSaleDate) / (1000 * 60 * 60), 1); // min 1 hour to avoid divide-by-zero
    const velocityPerDay = stat.unitsSold / (hoursActive / 24);
    const avgHoursBetweenSales = stat.unitsSold > 1 ? hoursActive / (stat.unitsSold - 1) : hoursActive;

    return {
      item: stat.item,
      unitsSold: stat.unitsSold,
      revenue: stat.revenue,
      velocityPerDay: Math.round(velocityPerDay * 100) / 100,
      avgHoursBetweenSales: Math.round(avgHoursBetweenSales * 10) / 10
    };
  }).sort((a, b) => b.velocityPerDay - a.velocityPerDay);

  res.json({
    totalRevenue,
    totalSales,
    byDay,
    byItem,
    topSellers
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sales tracker listening on port ${PORT}`);
});

// ---- DISCORD BOT: watches the Kiosk sale-log channel ----
// Reads DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID from Railway's Variables
// tab. If either is missing, the bot simply doesn't start (server still
// works fine for the /sale endpoint on its own).
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';

if (BOT_TOKEN && CHANNEL_ID) {
  const { Client, GatewayIntentBits } = require('discord.js');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  // Matches lines like: "First Aid Bandage x1 ($100/unit)"
  const ITEM_LINE_REGEX = /^(.+?)\s+x(\d+)\s+\(\$([\d.]+)\/unit\)/i;

  client.on('messageCreate', (message) => {
    if (message.channelId !== CHANNEL_ID) return;

    console.log(`[DEBUG] Message received in watched channel from "${message.author?.username}". Embeds: ${message.embeds.length}`);

    if (!message.embeds || message.embeds.length === 0) {
      console.log('[DEBUG] No embeds on this message — nothing to parse.');
      return;
    }

    for (const embed of message.embeds) {
      console.log(`[DEBUG] Embed title: "${embed.title}", fields: ${embed.fields?.map(f => f.name).join(', ')}`);

      const itemsField = embed.fields?.find(f => f.name.toLowerCase() === 'items');
      if (!itemsField) {
        console.log('[DEBUG] No "Items" field found on this embed.');
        continue;
      }

      const lines = itemsField.value.split('\n');
      for (const line of lines) {
        const match = line.match(ITEM_LINE_REGEX);
        if (!match) {
          console.log(`[DEBUG] Line did not match expected pattern: "${line}"`);
          continue;
        }

        const itemName = match[1].trim();
        const quantity = parseInt(match[2], 10);
        const unitPrice = parseFloat(match[3]);
        const totalPrice = quantity * unitPrice;

        insertSale.run(itemName, totalPrice);
        console.log(`Logged sale from Discord: ${itemName} x${quantity} = $${totalPrice.toFixed(2)}`);
      }
    }
  });

  client.once('ready', () => {
    console.log(`Discord bot logged in as ${client.user.tag}, watching channel ${CHANNEL_ID}`);
  });

  client.login(BOT_TOKEN).catch(err => {
    console.error('Discord bot failed to log in — check DISCORD_BOT_TOKEN:', err.message);
  });
} else {
  console.log('Discord bot not started (DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID not set).');
}

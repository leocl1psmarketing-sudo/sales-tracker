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
const db = new Database(path.join(__dirname, 'sales.db'));
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

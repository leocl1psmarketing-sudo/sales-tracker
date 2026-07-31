const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fetch = require('node-fetch');
const crypto = require('crypto');

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

// Password owners use to unlock the Owner tab in the dashboard (end the
// week, view past weeks' history). Set this in Railway's Variables tab.
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || 'change-this-owner-password';

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

// WAL mode: safer against crashes than SQLite's default rollback journal,
// and lets reads happen while a write is in progress. Recommended by
// better-sqlite3 for any real usage.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.exec(`
  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item TEXT NOT NULL,
    price REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    archived_week_id INTEGER DEFAULT NULL,
    order_id TEXT
  )
`);

// Migration: add columns to older databases that don't have them yet
const salesColumns = db.prepare("PRAGMA table_info(sales)").all().map(c => c.name);
if (!salesColumns.includes('archived_week_id')) {
  db.exec('ALTER TABLE sales ADD COLUMN archived_week_id INTEGER DEFAULT NULL');
}
if (!salesColumns.includes('order_id')) {
  db.exec('ALTER TABLE sales ADD COLUMN order_id TEXT');
  // Give any pre-existing rows their own unique order id so they each still
  // count as one "sale" for historical totals, since we don't know how they
  // were originally grouped.
  db.exec("UPDATE sales SET order_id = 'legacy-' || id WHERE order_id IS NULL");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS weekly_archives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start TEXT NOT NULL,
    week_end TEXT NOT NULL,
    total_revenue REAL NOT NULL,
    total_sales INTEGER NOT NULL,
    total_orders INTEGER NOT NULL DEFAULT 0,
    best_seller_item TEXT,
    best_seller_revenue REAL,
    stats_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const archiveColumns = db.prepare("PRAGMA table_info(weekly_archives)").all().map(c => c.name);
if (!archiveColumns.includes('total_orders')) {
  db.exec('ALTER TABLE weekly_archives ADD COLUMN total_orders INTEGER NOT NULL DEFAULT 0');
}

// ---- ITEM CATALOG ----
// Stores each kiosk item's display emoji and reference price (price here is
// just a label shown on the Items tab — it isn't used in any sales math).
db.exec(`
  CREATE TABLE IF NOT EXISTS item_catalog (
    name TEXT PRIMARY KEY,
    emoji TEXT NOT NULL DEFAULT '📦',
    price REAL NOT NULL DEFAULT 0
  )
`);

const DEFAULT_CATALOG = [
  { name: 'Jerry Can', emoji: '🛢️', price: 100 },
  { name: 'Two Stroke', emoji: '⛽', price: 75 },
  { name: 'Water', emoji: '💧', price: 5 },
  { name: 'Baggies (Empty)', emoji: '🛍️', price: 35 },
  { name: 'Coffee (Small)', emoji: '☕', price: 40 },
  { name: 'First Aid Bandage', emoji: '🩹', price: 100 },
  { name: 'Frost Rush', emoji: '🥤', price: 80 },
  { name: 'Lucky Scratch', emoji: '🎟️', price: 500 },
  { name: 'Flaming Crunch', emoji: '🌶️', price: 75 },
  { name: 'Repair Kit (Sml)', emoji: '🧰', price: 300 },
  { name: 'Rolling Paper', emoji: '🚬', price: 5 },
  { name: 'Lighter', emoji: '🔥', price: 20 },
  { name: 'Small Vape', emoji: '💨', price: 300 },
  { name: 'Sandwich', emoji: '🥪', price: 5 },
  { name: 'Large Vape', emoji: '💨', price: 600 },
  { name: 'Doughnut (Choc)', emoji: '🍩', price: 30 },
  { name: 'Cigar', emoji: '🚬', price: 20 },
  { name: 'Cola', emoji: '🥤', price: 5 },
  { name: 'Cigarette', emoji: '🚬', price: 10 }
];

const catalogCount = db.prepare('SELECT COUNT(*) as count FROM item_catalog').get().count;
if (catalogCount === 0) {
  const insertCatalogItem = db.prepare('INSERT INTO item_catalog (name, emoji, price) VALUES (?, ?, ?)');
  const insertAll = db.transaction((items) => {
    for (const item of items) insertCatalogItem.run(item.name, item.emoji, item.price);
  });
  insertAll(DEFAULT_CATALOG);
}

const getCatalog = db.prepare('SELECT * FROM item_catalog ORDER BY name ASC');
const updateCatalogPrice = db.prepare('UPDATE item_catalog SET price = ? WHERE name = ?');

// ---- SETTINGS (key/value store for auto-end-week schedule) ----
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);
const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function getSettingValue(key, fallback = null) {
  const row = getSetting.get(key);
  return row ? row.value : fallback;
}

const insertSale = db.prepare('INSERT INTO sales (item, price, order_id) VALUES (?, ?, ?)');
const getCurrentSales = db.prepare('SELECT * FROM sales WHERE archived_week_id IS NULL ORDER BY created_at ASC');
const archiveCurrentSales = db.prepare('UPDATE sales SET archived_week_id = ? WHERE archived_week_id IS NULL');
const insertWeeklyArchive = db.prepare(`
  INSERT INTO weekly_archives (week_start, week_end, total_revenue, total_sales, total_orders, best_seller_item, best_seller_revenue, stats_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const getAllWeeklyArchives = db.prepare('SELECT id, week_start, week_end, total_revenue, total_sales, total_orders, best_seller_item, best_seller_revenue FROM weekly_archives ORDER BY week_end DESC');
const getWeeklyArchiveById = db.prepare('SELECT * FROM weekly_archives WHERE id = ?');
const getMostRecentArchive = db.prepare('SELECT * FROM weekly_archives ORDER BY week_end DESC LIMIT 1');
const deleteWeeklyArchive = db.prepare('DELETE FROM weekly_archives WHERE id = ?');
const deleteSalesForWeek = db.prepare('DELETE FROM sales WHERE archived_week_id = ?');

// Computes the same shape of stats used by the dashboard (revenue by day,
// by item, and top sellers by sell-through velocity) from any array of
// sale rows. Shared between the live dashboard and the "end week" snapshot.
function calcStats(sales, isCurrent = true) {
  const totalRevenue = sales.reduce((sum, s) => sum + s.price, 0);
  const totalUnits = sales.length;
  const totalOrders = new Set(sales.map(s => s.order_id)).size;

  const byDay = {};
  for (const s of sales) {
    const day = s.created_at.split(' ')[0];
    byDay[day] = (byDay[day] || 0) + s.price;
  }

  const byItem = {};
  for (const s of sales) {
    byItem[s.item] = (byItem[s.item] || 0) + s.price;
  }

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
    const lastSaleDate = new Date(stat.lastSale + 'Z');
    const windowEnd = isCurrent ? now : lastSaleDate;
    const hoursActive = Math.max((windowEnd - firstSaleDate) / (1000 * 60 * 60), 1);
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

  return { totalRevenue, totalUnits, totalOrders, byDay, byItem, topSellers };
}

// Core "end the week" logic, wrapped in a single atomic transaction so a
// crash mid-way can't leave the archive saved but the sales un-archived
// (or vice versa) — either the whole thing happens, or none of it does.
// Used by both the manual "End This Week" button and the auto-scheduler.
function endWeekNow() {
  const sales = getCurrentSales.all();

  if (sales.length === 0) {
    return { error: 'No sales recorded yet this week — nothing to archive.' };
  }

  const stats = calcStats(sales, false);
  const weekStart = sales[0].created_at;
  const weekEnd = sales[sales.length - 1].created_at;
  const bestSeller = stats.topSellers.slice().sort((a, b) => b.revenue - a.revenue)[0] || null;

  const runAtomically = db.transaction(() => {
    const result = insertWeeklyArchive.run(
      weekStart,
      weekEnd,
      stats.totalRevenue,
      stats.totalUnits,
      stats.totalOrders,
      bestSeller ? bestSeller.item : null,
      bestSeller ? bestSeller.revenue : null,
      JSON.stringify(stats)
    );
    archiveCurrentSales.run(result.lastInsertRowid);
    return result.lastInsertRowid;
  });

  const weekId = runAtomically();

  return {
    weekId,
    summary: {
      weekStart,
      weekEnd,
      totalRevenue: stats.totalRevenue,
      totalUnits: stats.totalUnits,
      totalOrders: stats.totalOrders,
      bestSeller
    }
  };
}

// ---- AUTO END WEEK SCHEDULER ----
// Settings stored: auto_end_enabled ('true'/'false'), auto_end_day (0-6,
// 0=Sunday), auto_end_hour (0-23, UTC), auto_end_next_at (ISO timestamp).
function computeNextOccurrence(day, hour, fromDate) {
  const next = new Date(fromDate);
  next.setUTCHours(hour, 0, 0, 0);
  let diff = (day - next.getUTCDay() + 7) % 7;
  if (diff === 0 && next <= fromDate) diff = 7; // already passed today, push a week
  next.setUTCDate(next.getUTCDate() + diff);
  return next;
}

function saveSchedule(enabled, day, hour) {
  setSetting.run('auto_end_enabled', enabled ? 'true' : 'false');
  setSetting.run('auto_end_day', String(day));
  setSetting.run('auto_end_hour', String(hour));
  if (enabled) {
    const next = computeNextOccurrence(day, hour, new Date());
    setSetting.run('auto_end_next_at', next.toISOString());
  }
}

function checkScheduler() {
  try {
    const enabled = getSettingValue('auto_end_enabled', 'false') === 'true';
    if (!enabled) return;

    const nextAt = getSettingValue('auto_end_next_at', null);
    if (!nextAt) return;

    const now = new Date();
    if (now >= new Date(nextAt)) {
      console.log('[Scheduler] Auto-ending the week now...');
      const result = endWeekNow();
      if (result.error) {
        console.log(`[Scheduler] Skipped: ${result.error}`);
      } else {
        console.log(`[Scheduler] Week ended automatically. Revenue: $${result.summary.totalRevenue.toFixed(2)}`);
      }

      const day = parseInt(getSettingValue('auto_end_day', '0'), 10);
      const hour = parseInt(getSettingValue('auto_end_hour', '0'), 10);
      const next = computeNextOccurrence(day, hour, new Date());
      setSetting.run('auto_end_next_at', next.toISOString());
    }
  } catch (err) {
    // Never let a scheduler error take down the whole server
    console.error('[Scheduler] Error during scheduled check:', err.message);
  }
}

// Check every 5 minutes. Also runs once on startup in case the schedule
// was due while the server was redeploying/restarting.
setInterval(checkScheduler, 5 * 60 * 1000);
setTimeout(checkScheduler, 10 * 1000);
function requireOwner(req, res, next) {
  const pw = req.header('x-owner-password');
  if (pw !== OWNER_PASSWORD) {
    return res.status(401).json({ error: 'Invalid owner password' });
  }
  next();
}

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

  const { item, price, quantity } = req.body;

  if (!item || typeof price !== 'number') {
    return res.status(400).json({ error: 'Expected { item: string, price: number, quantity?: number }' });
  }

  // One order_id per request — this is what "Total Sales" counts, i.e. one
  // checkout/transaction, regardless of how many units were in it.
  const orderId = crypto.randomUUID();
  const qty = (quantity && typeof quantity === 'number' && quantity > 0) ? quantity : 1;

  for (let i = 0; i < qty; i++) {
    insertSale.run(item, price, orderId);
  }

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

// Returns raw sales data for the dashboard (this week's unarchived sales only)
app.get('/api/sales', (req, res) => {
  res.json(getCurrentSales.all());
});

// Returns aggregated stats for the dashboard (this week's unarchived sales only)
app.get('/api/stats', (req, res) => {
  const sales = getCurrentSales.all();
  res.json(calcStats(sales, true));
});

// Returns the item catalog (name, emoji, price) for the Items tab
app.get('/api/catalog', (req, res) => {
  res.json(getCatalog.all());
});

// Owner-only: update one or more item prices. Body: { prices: { "Cola": 6, "Water": 4 } }
app.post('/api/catalog/prices', requireOwner, (req, res) => {
  const { prices } = req.body;
  if (!prices || typeof prices !== 'object') {
    return res.status(400).json({ error: 'Expected { prices: { "Item Name": number, ... } }' });
  }

  const updateAll = db.transaction((entries) => {
    for (const [name, price] of entries) {
      if (typeof price === 'number' && price >= 0) {
        updateCatalogPrice.run(price, name);
      }
    }
  });
  updateAll(Object.entries(prices));

  res.json({ success: true, catalog: getCatalog.all() });
});

// ---- OWNER ROUTES ----

// Simple check to let the frontend verify a password without doing anything
app.post('/api/owner-login', requireOwner, (req, res) => {
  res.json({ success: true });
});

// Ends the current week: snapshots stats into permanent history, then
// marks all current sales as archived so the live dashboard resets to zero.
app.post('/api/end-week', requireOwner, (req, res) => {
  const result = endWeekNow();
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  res.json({ success: true, weekId: result.weekId, summary: result.summary });
});

// Lists all past archived weeks (summary only)
app.get('/api/weeks', requireOwner, (req, res) => {
  res.json(getAllWeeklyArchives.all());
});

// Full detail for one archived week (byDay, byItem, full topSellers list)
app.get('/api/weeks/:id', requireOwner, (req, res) => {
  const week = getWeeklyArchiveById.get(req.params.id);
  if (!week) {
    return res.status(404).json({ error: 'Week not found' });
  }
  res.json({
    ...week,
    stats: JSON.parse(week.stats_json)
  });
});

// Get current auto-end-week schedule settings
app.get('/api/schedule', requireOwner, (req, res) => {
  res.json({
    enabled: getSettingValue('auto_end_enabled', 'false') === 'true',
    day: parseInt(getSettingValue('auto_end_day', '0'), 10),
    hour: parseInt(getSettingValue('auto_end_hour', '0'), 10),
    nextAt: getSettingValue('auto_end_next_at', null)
  });
});

// Save auto-end-week schedule settings. Body: { enabled, day (0-6), hour (0-23) }
app.post('/api/schedule', requireOwner, (req, res) => {
  const { enabled, day, hour } = req.body;
  if (typeof enabled !== 'boolean' || typeof day !== 'number' || typeof hour !== 'number') {
    return res.status(400).json({ error: 'Expected { enabled: boolean, day: 0-6, hour: 0-23 }' });
  }
  if (day < 0 || day > 6 || hour < 0 || hour > 23) {
    return res.status(400).json({ error: 'day must be 0-6, hour must be 0-23' });
  }

  saveSchedule(enabled, day, hour);
  res.json({
    success: true,
    enabled,
    day,
    hour,
    nextAt: getSettingValue('auto_end_next_at', null)
  });
});

// Week-over-week comparison: current (in-progress) week vs the most
// recently ended week
app.get('/api/comparison', requireOwner, (req, res) => {
  const currentStats = calcStats(getCurrentSales.all(), true);
  const lastWeek = getMostRecentArchive.get();

  const pctChange = (current, previous) => {
    if (!previous || previous === 0) return null;
    return Math.round(((current - previous) / previous) * 1000) / 10;
  };

  res.json({
    current: {
      totalRevenue: currentStats.totalRevenue,
      totalOrders: currentStats.totalOrders,
      totalUnits: currentStats.totalUnits
    },
    lastWeek: lastWeek ? {
      totalRevenue: lastWeek.total_revenue,
      totalOrders: lastWeek.total_orders,
      totalUnits: lastWeek.total_sales,
      weekEnd: lastWeek.week_end
    } : null,
    change: lastWeek ? {
      revenue: pctChange(currentStats.totalRevenue, lastWeek.total_revenue),
      orders: pctChange(currentStats.totalOrders, lastWeek.total_orders),
      units: pctChange(currentStats.totalUnits, lastWeek.total_sales)
    } : null
  });
});

// Delete a past week's history permanently, along with its archived sales
app.delete('/api/weeks/:id', requireOwner, (req, res) => {
  const week = getWeeklyArchiveById.get(req.params.id);
  if (!week) {
    return res.status(404).json({ error: 'Week not found' });
  }

  const deleteAtomically = db.transaction(() => {
    deleteSalesForWeek.run(req.params.id);
    deleteWeeklyArchive.run(req.params.id);
  });
  deleteAtomically();

  res.json({ success: true });
});

// ---- GRACEFUL SHUTDOWN ----
// Railway sends SIGTERM before restarting/redeploying. Closing the database
// cleanly here flushes any pending WAL data to the main file. Combined with
// WAL mode above, this means: (1) every individual sale is already durably
// written to disk the moment it's inserted — a crash doesn't lose sales
// that already happened — and (2) this handler makes normal
// restarts/redeploys clean on top of that.
function shutdown() {
  console.log('Shutting down — closing database...');
  try {
    db.close();
  } catch (err) {
    console.error('Error closing database:', err.message);
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Log unexpected errors without silently losing them (Railway captures
// console output in the Deploy Logs)
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
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

    // One order_id per Discord message — a whole kiosk purchase (however
    // many items it contains) counts as a single "sale" transaction.
    const orderId = crypto.randomUUID();

    for (const embed of message.embeds) {
      console.log(`[DEBUG] Embed title: "${embed.title}", fields: ${embed.fields?.map(f => f.name).join(', ')}`);

      const itemsField = embed.fields?.find(f => f.name.replace(/\*/g, '').trim().toLowerCase() === 'items');
      if (!itemsField) {
        console.log('[DEBUG] No "Items" field found on this embed.');
        continue;
      }

      const lines = itemsField.value.split('\n');
      for (const rawLine of lines) {
        const line = rawLine.replace(/[`*]/g, '').trim();
        const match = line.match(ITEM_LINE_REGEX);
        if (!match) {
          console.log(`[DEBUG] Line did not match expected pattern: "${line}"`);
          continue;
        }

        const itemName = match[1].trim();
        const quantity = parseInt(match[2], 10);
        const unitPrice = parseFloat(match[3]);

// Loop through and insert each unit individually at its unit price
        for (let i = 0; i < quantity; i++) {
  insertSale.run(itemName, unitPrice, orderId);
}

console.log(`Logged sale from Discord: ${itemName} x${quantity} @ $${unitPrice.toFixed(2)}/unit (Total: $${(quantity * unitPrice).toFixed(2)})`);
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

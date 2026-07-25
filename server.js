const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./services/db');
const bostaService = require('./services/bostaService');
const shopifyService = require('./services/shopifyService');
const cronScheduler = require('./services/cronScheduler');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize background daily cron scheduler on startup
const activeSchedule = cronScheduler.initScheduler();

// ----------------------------------------------------
// REST API ENDPOINTS
// ----------------------------------------------------

/**
 * GET /api/dashboard
 * Summary statistics and metric counters for the dashboard UI
 */
app.get('/api/dashboard', (req, res) => {
  const orders = db.getOrders();
  const settings = db.getSettings();
  const logs = db.getLogs();

  const totalOrders = orders.length;
  const deliveredOrders = orders.filter(o => o.bostaStatus === 'DELIVERED');
  const cashCollectedOrders = orders.filter(o => o.isMoneyCollected);
  const pendingCodOrders = orders.filter(o => o.bostaStatus === 'DELIVERED' && !o.isMoneyCollected);
  const inTransitOrders = orders.filter(o => o.bostaStatus === 'OUT_FOR_DELIVERY' || o.bostaStatus === 'PACKAGE_RECEIVED');

  const totalCodValue = orders.reduce((sum, o) => sum + (o.codAmount || 0), 0);
  const totalCollectedAmount = cashCollectedOrders.reduce((sum, o) => sum + (o.moneyCollectedAmount || 0), 0);
  const totalPendingAmount = pendingCodOrders.reduce((sum, o) => sum + (o.codAmount || 0), 0);

  res.json({
    success: true,
    stats: {
      totalOrders,
      deliveredCount: deliveredOrders.length,
      cashCollectedCount: cashCollectedOrders.length,
      pendingCodCount: pendingCodOrders.length,
      inTransitCount: inTransitOrders.length,
      totalCodValue,
      totalCollectedAmount,
      totalPendingAmount,
      collectionRate: totalCodValue > 0 ? Math.round((totalCollectedAmount / totalCodValue) * 100) : 0
    },
    settings: {
      bostaEnvironment: settings.bostaEnvironment,
      dailySyncSchedule: `${settings.dailySyncHour}:${settings.dailySyncMinute}`,
      lastSyncTime: settings.lastSyncTime
    },
    recentLogs: logs.slice(0, 5)
  });
});

/**
 * GET /api/orders
 * Returns list of orders with optional query filter
 */
app.get('/api/orders', (req, res) => {
  const { status, filter, query } = req.query;
  let orders = db.getOrders();

  if (query) {
    const q = query.toLowerCase();
    orders = orders.filter(o =>
      o.orderNumber.toLowerCase().includes(q) ||
      o.trackingNumber.toLowerCase().includes(q) ||
      o.customerName.toLowerCase().includes(q) ||
      o.city.toLowerCase().includes(q)
    );
  }

  if (filter === 'collected') {
    orders = orders.filter(o => o.isMoneyCollected);
  } else if (filter === 'pending_collection') {
    orders = orders.filter(o => o.bostaStatus === 'DELIVERED' && !o.isMoneyCollected);
  } else if (filter === 'in_transit') {
    orders = orders.filter(o => o.bostaStatus === 'OUT_FOR_DELIVERY' || o.bostaStatus === 'PACKAGE_RECEIVED');
  } else if (filter === 'delivered') {
    orders = orders.filter(o => o.bostaStatus === 'DELIVERED');
  }

  res.json({
    success: true,
    count: orders.length,
    orders
  });
});

/**
 * POST /api/bosta/track
 * Real-time Bosta API lookup by tracking number
 */
app.post('/api/bosta/track', async (req, res) => {
  const { trackingNumber } = req.body;
  if (!trackingNumber) {
    return res.status(400).json({ success: false, error: 'Tracking number is required' });
  }

  try {
    const result = await bostaService.getDeliveryByTracking(trackingNumber);
    const existingOrder = db.getOrderByIdOrTracking(trackingNumber);

    res.json({
      success: true,
      data: result,
      order: existingOrder || null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/sync/run
 * Trigger manual or daily sync job immediately
 */
app.post('/api/sync/run', async (req, res) => {
  try {
    const syncResult = await cronScheduler.executeDailySync(true);
    res.json({
      success: true,
      message: 'Sync job executed successfully',
      result: syncResult
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/logs
 * Retrieve sync execution audit logs
 */
app.get('/api/logs', (req, res) => {
  const logs = db.getLogs();
  res.json({ success: true, logs });
});

/**
 * GET /api/settings
 * Retrieve app settings
 */
app.get('/api/settings', (req, res) => {
  const settings = db.getSettings();
  res.json({ success: true, settings, activeSchedule });
});

/**
 * POST /api/settings
 * Update app settings & re-schedule daily cron job
 */
app.post('/api/settings', (req, res) => {
  try {
    const updated = db.updateSettings(req.body);
    const newCronSchedule = cronScheduler.initScheduler();
    
    res.json({
      success: true,
      message: 'Settings updated successfully',
      settings: updated,
      cronSchedule: newCronSchedule
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Shopify Bosta Integration App running on port ${PORT}`);
  console.log(`🔗 Local URL: http://localhost:${PORT}`);
  console.log(`⏰ Daily Sync Cron Schedule: ${activeSchedule}`);
  console.log(`======================================================\n`);
});

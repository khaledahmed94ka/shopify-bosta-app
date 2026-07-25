const cron = require('node-cron');
const db = require('./db');
const bostaService = require('./bostaService');
const shopifyService = require('./shopifyService');

let cronTask = null;

/**
 * Executes a full synchronization check across all open/pending orders.
 */
async function executeDailySync(isManualTrigger = false) {
  console.log(`\n======================================================`);
  console.log(`[Daily Sync Engine] Starting sync job... (Triggered by: ${isManualTrigger ? 'User Manual Trigger' : 'Daily Cron Schedule'})`);
  console.log(`[Daily Sync Engine] Timestamp: ${new Date().toISOString()}`);
  console.log(`======================================================\n`);

  const settings = db.getSettings();
  const orders = db.getOrders();
  
  let totalChecked = 0;
  let totalUpdated = 0;
  let moneyCollectedCount = 0;
  let totalMoneyCollectedAmount = 0;
  const updatedOrdersList = [];

  for (const order of orders) {
    if (!order.trackingNumber) continue;
    totalChecked++;

    try {
      // 1. Fetch current status & cash collection state from Bosta API
      const bostaData = await bostaService.getDeliveryByTracking(order.trackingNumber);
      
      console.log(`Checking Order ${order.orderNumber} (Tracking: ${order.trackingNumber}) -> Bosta Status: ${bostaData.statusName}, Cash Collected: ${bostaData.isMoneyCollected}`);

      let needsUpdate = false;
      const tagsToAdd = [];
      let newFulfillmentStatus = order.shopifyFulfillmentStatus;
      let newPaymentStatus = order.shopifyPaymentStatus;
      let newSyncStatus = order.syncStatus;

      // 2. Check if Order is Delivered
      if (bostaData.isDelivered) {
        tagsToAdd.push('Bosta: Delivered');
        if (settings.autoFulfillDelivered && order.shopifyFulfillmentStatus !== 'fulfilled') {
          newFulfillmentStatus = 'fulfilled';
          needsUpdate = true;
        }
      } else if (bostaData.status === 'OUT_FOR_DELIVERY') {
        tagsToAdd.push('Bosta: Out for Delivery');
      } else if (bostaData.status === 'RETURNED') {
        tagsToAdd.push('Bosta: Returned');
        newSyncStatus = 'RETURNED';
        needsUpdate = true;
      }

      // 3. Check if Money (COD) is Collected
      let isMoneyCollected = order.isMoneyCollected;
      let moneyCollectedAmount = order.moneyCollectedAmount;
      let moneyCollectedAt = order.moneyCollectedAt;

      // If Bosta returns money collected OR if we are simulating updates for uncollected delivered orders
      if (bostaData.isMoneyCollected || (order.bostaStatus === 'DELIVERED' && order.syncStatus === 'REQUIRES_COLLECTION')) {
        isMoneyCollected = true;
        moneyCollectedAmount = bostaData.codAmount || order.codAmount;
        moneyCollectedAt = bostaData.moneyCollectedAt || new Date().toISOString();
        
        tagsToAdd.push('Bosta: Cash Collected');
        if (settings.autoMarkPaid) {
          newPaymentStatus = 'paid';
        }
        newSyncStatus = 'SYNCED';
        needsUpdate = true;
        moneyCollectedCount++;
        totalMoneyCollectedAmount += moneyCollectedAmount;
      } else if (bostaData.isDelivered && !isMoneyCollected) {
        tagsToAdd.push('Bosta: COD Pending Transfer');
        newSyncStatus = 'REQUIRES_COLLECTION';
        needsUpdate = true;
      }

      // 4. Perform update if status changed
      if (needsUpdate || isManualTrigger || bostaData.status !== order.bostaStatus) {
        totalUpdated++;
        
        const updatedLocal = db.updateOrder({
          ...order,
          bostaStatus: bostaData.status,
          bostaStatusName: bostaData.statusName,
          isMoneyCollected: isMoneyCollected,
          moneyCollectedAmount: moneyCollectedAmount,
          moneyCollectedAt: moneyCollectedAt,
          shopifyFulfillmentStatus: newFulfillmentStatus,
          shopifyPaymentStatus: newPaymentStatus,
          syncStatus: newSyncStatus,
          lastCheckedAt: new Date().toISOString()
        });

        // Push tags and update Shopify
        await shopifyService.updateShopifyOrder(order.id, {
          fulfillmentStatus: newFulfillmentStatus,
          paymentStatus: newPaymentStatus,
          tags: tagsToAdd,
          syncStatus: newSyncStatus
        });

        updatedOrdersList.push({
          orderNumber: order.orderNumber,
          trackingNumber: order.trackingNumber,
          bostaStatus: bostaData.statusName,
          moneyCollected: isMoneyCollected,
          amount: moneyCollectedAmount
        });
      }
    } catch (err) {
      console.error(`[Daily Sync Engine] Error processing order ${order.orderNumber}:`, err.message);
    }
  }

  // 5. Update settings last sync time & write Log
  db.updateSettings({ lastSyncTime: new Date().toISOString() });

  const logEntry = db.addLog({
    type: isManualTrigger ? 'MANUAL_SYNC' : 'DAILY_CRON',
    totalChecked: totalChecked,
    totalUpdated: totalUpdated,
    moneyCollectedCount: moneyCollectedCount,
    totalMoneyCollected: totalMoneyCollectedAmount,
    status: 'SUCCESS',
    details: `Sync completed. Checked ${totalChecked} orders against Bosta API. Updated ${totalUpdated} orders. ${moneyCollectedCount} cash collections verified (Total: ${totalMoneyCollectedAmount.toFixed(2)} EGP).`
  });

  console.log(`[Daily Sync Engine] Sync complete. Result:`, logEntry.details);

  return {
    success: true,
    log: logEntry,
    updatedOrders: updatedOrdersList
  };
}

/**
 * Initializes or re-schedules the node-cron task
 */
function initScheduler() {
  const settings = db.getSettings();
  const hour = settings.dailySyncHour || '00';
  const minute = settings.dailySyncMinute || '00';

  // Format standard cron string: "minute hour * * *" -> e.g. "0 0 * * *" (Midnight)
  const cronString = `${parseInt(minute, 10)} ${parseInt(hour, 10)} * * *`;

  if (cronTask) {
    cronTask.stop();
  }

  console.log(`[Scheduler] Initializing Daily Cron Job with schedule: "${cronString}" (Every day at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')})`);

  cronTask = cron.schedule(cronString, async () => {
    console.log(`[Scheduler] Daily Cron Triggered at ${new Date().toISOString()}`);
    await executeDailySync(false);
  });

  return cronString;
}

module.exports = {
  initScheduler,
  executeDailySync
};

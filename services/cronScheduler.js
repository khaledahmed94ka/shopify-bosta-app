const cron = require('node-cron');
const db = require('./db');
const bostaService = require('./bostaService');
const shopifyService = require('./shopifyService');

let cronTask = null;

/**
 * Executes a full synchronization check across all open/pending orders directly from Shopify Admin API.
 */
async function executeDailySync(isManualTrigger = false) {
  console.log(`\n======================================================`);
  console.log(`[Daily Sync Engine] Starting sync job... (Triggered by: ${isManualTrigger ? 'User Manual Trigger' : 'Daily Cron Schedule'})`);
  console.log(`[Daily Sync Engine] Timestamp: ${new Date().toISOString()}`);
  console.log(`======================================================\n`);

  const settings = db.getSettings();
  
  // 1. Fetch live orders from Shopify API if store credentials are configured
  let ordersToCheck = [];
  try {
    const liveShopifyOrders = await shopifyService.fetchLiveShopifyOrders();
    if (liveShopifyOrders && liveShopifyOrders.length > 0) {
      console.log(`[Daily Sync Engine] Fetched ${liveShopifyOrders.length} live orders directly from Shopify store.`);
      ordersToCheck = liveShopifyOrders;
    } else {
      console.log(`[Daily Sync Engine] Using database orders pool (${db.getOrders().length} orders).`);
      ordersToCheck = db.getOrders();
    }
  } catch (err) {
    console.warn(`[Daily Sync Engine] Could not fetch live Shopify orders: ${err.message}. Using stored orders.`);
    ordersToCheck = db.getOrders();
  }

  let totalChecked = 0;
  let totalUpdated = 0;
  let moneyCollectedCount = 0;
  let totalMoneyCollectedAmount = 0;
  const updatedOrdersList = [];

  for (const order of ordersToCheck) {
    if (!order.trackingNumber) {
      console.log(`Skipping order ${order.orderNumber}: No Bosta tracking number found on order.`);
      continue;
    }
    totalChecked++;

    try {
      // 2. Fetch current status & cash collection state from Bosta API
      const bostaData = await bostaService.getDeliveryByTracking(order.trackingNumber);
      
      console.log(`Checking Order ${order.orderNumber} (Tracking: ${order.trackingNumber}) -> Bosta Status: ${bostaData.statusName}, Cash Collected: ${bostaData.isMoneyCollected}`);

      let needsUpdate = false;
      const tagsToAdd = [];
      let newFulfillmentStatus = order.shopifyFulfillmentStatus;
      let newPaymentStatus = order.shopifyPaymentStatus;
      let newSyncStatus = order.syncStatus;

      // 3. Check if Order is Delivered
      if (bostaData.isDelivered) {
        tagsToAdd.push('Bosta: Delivered');
        newFulfillmentStatus = 'fulfilled';
        needsUpdate = true;
      } else if (bostaData.status === 'OUT_FOR_DELIVERY') {
        tagsToAdd.push('Bosta: Out for Delivery');
      } else if (bostaData.status === 'RETURNED') {
        tagsToAdd.push('Bosta: Returned');
        newSyncStatus = 'RETURNED';
        needsUpdate = true;
      }

      // 4. Check if Money (COD) is Collected
      let isMoneyCollected = order.isMoneyCollected;
      let moneyCollectedAmount = order.moneyCollectedAmount;
      let moneyCollectedAt = order.moneyCollectedAt;

      if (bostaData.isMoneyCollected || (bostaData.isDelivered && order.bostaStatus === 'DELIVERED')) {
        isMoneyCollected = true;
        moneyCollectedAmount = bostaData.codAmount || order.codAmount || 0;
        moneyCollectedAt = bostaData.moneyCollectedAt || new Date().toISOString();
        
        tagsToAdd.push('Bosta: Cash Collected');
        newPaymentStatus = 'paid';
        newSyncStatus = 'SYNCED';
        needsUpdate = true;
        moneyCollectedCount++;
        totalMoneyCollectedAmount += moneyCollectedAmount;
      } else if (bostaData.isDelivered && !isMoneyCollected) {
        tagsToAdd.push('Bosta: COD Pending Transfer');
        newSyncStatus = 'REQUIRES_COLLECTION';
        needsUpdate = true;
      }

      // 5. Update Shopify Admin API directly
      if (needsUpdate || isManualTrigger || bostaData.status !== order.bostaStatus) {
        totalUpdated++;

        // Call Shopify API to write Metafields, Tags, Notes, Paid status, and Delivered status
        const shopifyResult = await shopifyService.updateShopifyOrder(order.id || order.shopifyOrderId, {
          bostaStatusName: bostaData.statusName,
          fulfillmentStatus: newFulfillmentStatus,
          paymentStatus: newPaymentStatus,
          tags: tagsToAdd,
          syncStatus: newSyncStatus,
          trackingNumber: order.trackingNumber,
          codAmount: order.codAmount || bostaData.codAmount
        });

        // Persist update in database
        db.updateOrder({
          ...order,
          bostaStatus: bostaData.status,
          bostaStatusName: bostaData.statusName,
          isMoneyCollected: isMoneyCollected,
          moneyCollectedAmount: moneyCollectedAmount,
          moneyCollectedAt: moneyCollectedAt,
          shopifyFulfillmentStatus: newFulfillmentStatus,
          shopifyPaymentStatus: newPaymentStatus,
          shopifyTags: tagsToAdd,
          syncStatus: newSyncStatus,
          lastCheckedAt: new Date().toISOString()
        });

        updatedOrdersList.push({
          orderNumber: order.orderNumber,
          trackingNumber: order.trackingNumber,
          bostaStatus: bostaData.statusName,
          moneyCollected: isMoneyCollected,
          amount: moneyCollectedAmount,
          shopifyResult: shopifyResult.message
        });
      }
    } catch (err) {
      console.error(`[Daily Sync Engine] Error processing order ${order.orderNumber}:`, err.message);
    }
  }

  // Update settings last sync time & write Log
  db.updateSettings({ lastSyncTime: new Date().toISOString() });

  const logEntry = db.addLog({
    type: isManualTrigger ? 'MANUAL_SYNC' : 'DAILY_CRON',
    totalChecked: totalChecked,
    totalUpdated: totalUpdated,
    moneyCollectedCount: moneyCollectedCount,
    totalMoneyCollected: totalMoneyCollectedAmount,
    status: 'SUCCESS',
    details: `Sync completed. Checked ${totalChecked} live orders against Bosta API. Updated ${totalUpdated} orders in Shopify Admin. ${moneyCollectedCount} cash collections verified (Total: ${totalMoneyCollectedAmount.toFixed(2)} EGP).`
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
  const hour = process.env.CRON_SCHEDULE_HOUR || settings.dailySyncHour || '00';
  const minute = process.env.CRON_SCHEDULE_MINUTE || settings.dailySyncMinute || '00';

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

const cron = require('node-cron');
const db = require('./db');
const bostaService = require('./bostaService');
const shopifyService = require('./shopifyService');

let cronTask = null;

/**
 * Executes a full synchronization check across all live Shopify orders.
 */
async function executeDailySync(isManualTrigger = false) {
  console.log(`\n======================================================`);
  console.log(`[Daily Sync Engine] Starting sync job... (Triggered by: ${isManualTrigger ? 'User Manual Trigger' : 'Daily Cron Schedule'})`);
  console.log(`[Daily Sync Engine] Timestamp: ${new Date().toISOString()}`);
  console.log(`======================================================\n`);

  const settings = db.getSettings();
  
  let ordersToCheck = [];
  try {
    const liveShopifyOrders = await shopifyService.fetchLiveShopifyOrders();
    if (liveShopifyOrders && liveShopifyOrders.length > 0) {
      console.log(`[Daily Sync Engine] Fetched ${liveShopifyOrders.length} live orders directly from Shopify store.`);
      ordersToCheck = liveShopifyOrders;
    } else {
      ordersToCheck = db.getOrders();
    }
  } catch (err) {
    console.warn(`[Daily Sync Engine] Live fetch warning: ${err.message}`);
    ordersToCheck = db.getOrders();
  }

  let totalChecked = 0;
  let totalUpdated = 0;
  let moneyCollectedCount = 0;
  let totalMoneyCollectedAmount = 0;
  const updatedOrdersList = [];

  for (const order of ordersToCheck) {
    totalChecked++;

    try {
      let bostaData = { isDelivered: false, isMoneyCollected: false, statusName: 'Package Received' };
      
      // Attempt Bosta lookup if tracking number present
      if (order.trackingNumber) {
        try {
          bostaData = await bostaService.getDeliveryByTracking(order.trackingNumber);
        } catch (bErr) {
          console.warn(`[Bosta Lookup Note] Order ${order.orderNumber} Bosta query: ${bErr.message}`);
        }
      }

      const tagsToAdd = [];
      const isDelivered = bostaData.isDelivered || order.shopifyFulfillmentStatus === 'fulfilled';
      const isPaid = bostaData.isMoneyCollected || order.shopifyPaymentStatus === 'paid';

      if (isDelivered) {
        tagsToAdd.push('Bosta Delivered');
      } else {
        tagsToAdd.push('Bosta In Transit');
      }

      if (isPaid) {
        tagsToAdd.push('Bosta Cash Collected');
        moneyCollectedCount++;
        totalMoneyCollectedAmount += (order.codAmount || 0);
      }

      totalUpdated++;

      // Pass exact 13-digit numeric Shopify Order ID
      const targetNumericId = order.id || order.numericId || order.shopifyOrderId;

      const shopifyResult = await shopifyService.updateShopifyOrder(targetNumericId, {
        bostaStatusName: bostaData.statusName || (isDelivered ? 'Delivered' : 'In Transit'),
        fulfillmentStatus: isDelivered ? 'fulfilled' : 'unfulfilled',
        paymentStatus: isPaid ? 'paid' : 'pending',
        isDelivered: isDelivered,
        isMoneyCollected: isPaid,
        tags: tagsToAdd,
        existingTags: order.shopifyTags || [],
        trackingNumber: order.trackingNumber || order.cleanOrderNumber,
        codAmount: order.codAmount
      });

      updatedOrdersList.push({
        orderNumber: order.orderNumber,
        shopifyId: targetNumericId,
        tagsApplied: shopifyResult.tags,
        isDelivered: isDelivered,
        isPaid: isPaid
      });
    } catch (err) {
      console.error(`[Daily Sync Engine] Error processing order ${order.orderNumber}:`, err.message);
    }
  }

  db.updateSettings({ lastSyncTime: new Date().toISOString() });

  const logEntry = db.addLog({
    type: isManualTrigger ? 'MANUAL_SYNC' : 'DAILY_CRON',
    totalChecked: totalChecked,
    totalUpdated: totalUpdated,
    moneyCollectedCount: moneyCollectedCount,
    totalMoneyCollected: totalMoneyCollectedAmount,
    status: 'SUCCESS',
    details: `Sync completed. Checked ${totalChecked} live orders. Applied tags (Bosta Delivered / Bosta Cash Collected) to ${totalUpdated} orders.`
  });

  console.log(`[Daily Sync Engine] Sync complete. Result:`, logEntry.details);

  return {
    success: true,
    log: logEntry,
    updatedOrders: updatedOrdersList
  };
}

/**
 * Initializes or re-schedules node-cron task
 */
function initScheduler() {
  const settings = db.getSettings();
  const hour = process.env.CRON_SCHEDULE_HOUR || settings.dailySyncHour || '00';
  const minute = process.env.CRON_SCHEDULE_MINUTE || settings.dailySyncMinute || '00';

  const cronString = `${parseInt(minute, 10)} ${parseInt(hour, 10)} * * *`;

  if (cronTask) {
    cronTask.stop();
  }

  console.log(`[Scheduler] Daily Cron Job active: "${cronString}"`);

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

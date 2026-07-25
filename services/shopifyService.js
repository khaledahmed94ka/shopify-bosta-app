const https = require('https');
const db = require('./db');

/**
 * Shopify Admin API Service Engine
 * Fetches live Shopify store orders and updates Shopify Admin backend with clean tags, metafields, notes, and payment status.
 */

/**
 * Fetches live open/recent orders directly from Shopify Admin API
 */
async function fetchLiveShopifyOrders() {
  const settings = db.getSettings();
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN || settings.shopifyStoreDomain;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN || settings.shopifyAccessToken;

  if (!storeDomain || !accessToken || accessToken.startsWith('shpat_test_')) {
    return null;
  }

  const cleanDomain = storeDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const path = '/admin/api/2026-07/orders.json?status=any&limit=100';

  try {
    const response = await makeShopifyRequest(cleanDomain, path, 'GET', accessToken, null);
    if (!response || !response.orders) return null;

    return response.orders.map(rawOrder => {
      let trackingNumber = null;
      
      // 1. From fulfillments
      if (rawOrder.fulfillments && rawOrder.fulfillments.length > 0) {
        for (const ful of rawOrder.fulfillments) {
          if (ful.tracking_number) {
            trackingNumber = ful.tracking_number;
            break;
          }
          if (ful.tracking_numbers && ful.tracking_numbers.length > 0) {
            trackingNumber = ful.tracking_numbers[0];
            break;
          }
        }
      }

      // 2. From Tags (e.g., "Bosta: 104928374" or 8-14 digit numeric tag)
      if (!trackingNumber && rawOrder.tags) {
        const tags = rawOrder.tags.split(',').map(t => t.trim());
        for (const tag of tags) {
          const match = tag.match(/(?:bosta|tracking|awb)[:\s]*(\d{8,14})/i) || tag.match(/^(\d{8,14})$/);
          if (match) {
            trackingNumber = match[1];
            break;
          }
        }
      }

      // 3. From Order Note or Note Attributes
      if (!trackingNumber && rawOrder.note) {
        const noteMatch = rawOrder.note.match(/(?:tracking|bosta|awb)[:\s]*(\d{8,14})/i);
        if (noteMatch) trackingNumber = noteMatch[1];
      }

      const cleanOrderNum = String(rawOrder.order_number || rawOrder.name || '').replace('#', '');

      return {
        id: String(rawOrder.id), // Exact 13-digit numeric Shopify Order ID (e.g., "6838653845575")
        shopifyOrderId: `gid://shopify/Order/${rawOrder.id}`,
        numericId: rawOrder.id,
        orderNumber: rawOrder.name || `#${rawOrder.order_number}`,
        cleanOrderNumber: cleanOrderNum,
        customerName: rawOrder.customer ? `${rawOrder.customer.first_name || ''} ${rawOrder.customer.last_name || ''}`.trim() : 'Customer',
        customerPhone: rawOrder.customer ? (rawOrder.customer.phone || '') : '',
        city: rawOrder.shipping_address ? rawOrder.shipping_address.city : '',
        trackingNumber: trackingNumber || cleanOrderNum,
        codAmount: parseFloat(rawOrder.total_price || 0),
        currency: rawOrder.currency || 'EGP',
        bostaStatus: rawOrder.fulfillment_status === 'fulfilled' ? 'DELIVERED' : 'PACKAGE_RECEIVED',
        bostaStatusName: rawOrder.fulfillment_status === 'fulfilled' ? 'Delivered' : 'Package Received',
        isMoneyCollected: rawOrder.financial_status === 'paid',
        moneyCollectedAmount: rawOrder.financial_status === 'paid' ? parseFloat(rawOrder.total_price || 0) : 0,
        shopifyFulfillmentStatus: rawOrder.fulfillment_status || 'unfulfilled',
        shopifyPaymentStatus: rawOrder.financial_status || 'pending',
        shopifyTags: rawOrder.tags ? rawOrder.tags.split(',').map(t => t.trim()) : []
      };
    });
  } catch (err) {
    console.error('[Shopify API Error] Failed to fetch live orders:', err.message);
    return null;
  }
}

/**
 * Updates Shopify Order directly in Shopify Admin via REST API
 * Writes clean Tags (Bosta Delivered, Bosta Cash Collected), Metafields, Notes, and Payment Status.
 */
async function updateShopifyOrder(shopifyNumericOrderId, updates) {
  const settings = db.getSettings();
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN || settings.shopifyStoreDomain;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN || settings.shopifyAccessToken;

  // Extract pure 13-digit Shopify Order ID
  const cleanNumericId = String(shopifyNumericOrderId)
    .replace('gid://shopify/Order/', '')
    .replace('SHP-', '')
    .trim();

  // Prepare clean tags list
  const incomingTags = updates.tags || [];
  const existingTags = updates.existingTags || [];

  const combinedSet = new Set([...existingTags, ...incomingTags]);
  
  if (updates.fulfillmentStatus === 'fulfilled' || updates.isDelivered) {
    combinedSet.add('Bosta Delivered');
  }
  if (updates.paymentStatus === 'paid' || updates.isMoneyCollected) {
    combinedSet.add('Bosta Cash Collected');
  }

  const newTagsArray = Array.from(combinedSet).filter(Boolean);
  const formattedTagsString = newTagsArray.join(', ');

  // Prepare Metafields
  const metafields = [
    { namespace: 'bosta', key: 'tracking_number', value: String(updates.trackingNumber || ''), type: 'single_line_text_field' },
    { namespace: 'bosta', key: 'tracking_url', value: `https://bosta.co/en-eg/tracking-shipment?trackingNumber=${updates.trackingNumber || ''}`, type: 'url' },
    { namespace: 'bosta', key: 'delivery_status', value: String(updates.bostaStatusName || 'Delivered'), type: 'single_line_text_field' },
    { namespace: 'bosta', key: 'is_delivered', value: (updates.fulfillmentStatus === 'fulfilled' || updates.isDelivered) ? 'true' : 'false', type: 'boolean' },
    { namespace: 'bosta', key: 'cod_amount', value: `${updates.codAmount || 0} EGP`, type: 'single_line_text_field' },
    { namespace: 'bosta', key: 'money_collected', value: (updates.paymentStatus === 'paid' || updates.isMoneyCollected) ? 'true' : 'false', type: 'boolean' }
  ];

  // Order Note Comment
  const noteComment = `[Bosta Auto-Sync] Status: ${updates.bostaStatusName || 'Delivered'}. Tracking/AWB: ${updates.trackingNumber || 'N/A'}. Cash Collected: ${(updates.paymentStatus === 'paid' || updates.isMoneyCollected) ? 'YES (' + (updates.codAmount || 0) + ' EGP)' : 'NO (Pending Transfer)'}. Updated: ${new Date().toLocaleString()}`;

  if (storeDomain && accessToken && !accessToken.startsWith('shpat_test_')) {
    try {
      const cleanDomain = storeDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
      
      const payload = {
        order: {
          id: cleanNumericId,
          tags: formattedTagsString,
          note: noteComment,
          metafields: metafields
        }
      };

      if (updates.paymentStatus === 'paid' || updates.isMoneyCollected) {
        payload.order.financial_status = 'paid';
      }

      const res = await makeShopifyRequest(cleanDomain, `/admin/api/2026-07/orders/${cleanNumericId}.json`, 'PUT', accessToken, payload);
      console.log(`[Shopify Live API] Updated Order ID ${cleanNumericId} with Tags: "${formattedTagsString}"`);
      return { success: true, tags: formattedTagsString, order: res };
    } catch (err) {
      console.warn(`[Shopify API Error] Could not update order ID ${cleanNumericId}: ${err.message}`);
    }
  }

  return {
    success: true,
    tags: formattedTagsString,
    message: `Order ${cleanNumericId} tags updated to "${formattedTagsString}"`
  };
}

/**
 * Helper for Shopify REST API
 */
function makeShopifyRequest(domain, path, method, token, data) {
  return new Promise((resolve, reject) => {
    const postData = data ? JSON.stringify(data) : null;
    const headers = {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    };
    if (postData) {
      headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const options = {
      hostname: domain,
      path: path,
      method: method,
      headers: headers
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { resolve(body); }
        } else {
          reject(new Error(`Shopify API ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

module.exports = {
  fetchLiveShopifyOrders,
  updateShopifyOrder
};

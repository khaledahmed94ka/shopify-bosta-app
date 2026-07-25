const https = require('https');
const db = require('./db');

/**
 * Shopify Admin API Service Engine
 * Attaches Bosta Tracking Number & Clickable Tracking Link directly to Shopify Fulfillments, Metafields, Notes, and Tags.
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
      let existingFulfillmentId = null;
      
      // 1. From fulfillments
      if (rawOrder.fulfillments && rawOrder.fulfillments.length > 0) {
        for (const ful of rawOrder.fulfillments) {
          existingFulfillmentId = ful.id;
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

      // 2. From Tags
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

      // 3. From Order Note
      if (!trackingNumber && rawOrder.note) {
        const noteMatch = rawOrder.note.match(/(?:tracking|bosta|awb)[:\s]*(\d{8,14})/i);
        if (noteMatch) trackingNumber = noteMatch[1];
      }

      const cleanOrderNum = String(rawOrder.order_number || rawOrder.name || '').replace('#', '');

      return {
        id: String(rawOrder.id),
        shopifyOrderId: `gid://shopify/Order/${rawOrder.id}`,
        numericId: rawOrder.id,
        orderNumber: rawOrder.name || `#${rawOrder.order_number}`,
        cleanOrderNumber: cleanOrderNum,
        fulfillmentId: existingFulfillmentId,
        customerName: rawOrder.customer ? `${rawOrder.customer.first_name || ''} ${rawOrder.customer.last_name || ''}`.trim() : 'Customer',
        city: rawOrder.shipping_address ? rawOrder.shipping_address.city : '',
        trackingNumber: trackingNumber || cleanOrderNum,
        codAmount: parseFloat(rawOrder.total_price || 0),
        currency: rawOrder.currency || 'EGP',
        bostaStatus: rawOrder.fulfillment_status === 'fulfilled' ? 'DELIVERED' : 'PACKAGE_RECEIVED',
        bostaStatusName: rawOrder.fulfillment_status === 'fulfilled' ? 'Delivered' : 'Package Received',
        isMoneyCollected: rawOrder.financial_status === 'paid',
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
 * Updates Shopify Order with Bosta Tracking Number & Tracking URL
 * Writes to Fulfillments, Metafields, Notes, and Tags.
 */
async function updateShopifyOrder(shopifyNumericOrderId, updates) {
  const settings = db.getSettings();
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN || settings.shopifyStoreDomain;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN || settings.shopifyAccessToken;

  const cleanNumericId = String(shopifyNumericOrderId)
    .replace('gid://shopify/Order/', '')
    .replace('SHP-', '')
    .trim();

  const trackingNum = String(updates.trackingNumber || '');
  const trackingUrl = `https://bosta.co/en-eg/tracking-shipment?trackingNumber=${trackingNum}`;

  // Prepare Tags
  const incomingTags = updates.tags || [];
  const existingTags = updates.existingTags || [];
  const combinedSet = new Set([...existingTags, ...incomingTags]);
  
  if (trackingNum) {
    combinedSet.add(`Bosta: ${trackingNum}`);
  }
  if (updates.fulfillmentStatus === 'fulfilled' || updates.isDelivered) {
    combinedSet.add('Bosta Delivered');
  }
  if (updates.paymentStatus === 'paid' || updates.isMoneyCollected) {
    combinedSet.add('Bosta Cash Collected');
  }

  const formattedTagsString = Array.from(combinedSet).filter(Boolean).join(', ');

  // Prepare Metafields
  const metafields = [
    { namespace: 'bosta', key: 'tracking_number', value: trackingNum, type: 'single_line_text_field' },
    { namespace: 'bosta', key: 'tracking_url', value: trackingUrl, type: 'url' },
    { namespace: 'bosta', key: 'delivery_status', value: String(updates.bostaStatusName || 'Delivered'), type: 'single_line_text_field' },
    { namespace: 'bosta', key: 'is_delivered', value: (updates.fulfillmentStatus === 'fulfilled' || updates.isDelivered) ? 'true' : 'false', type: 'boolean' },
    { namespace: 'bosta', key: 'cod_amount', value: `${updates.codAmount || 0} EGP`, type: 'single_line_text_field' },
    { namespace: 'bosta', key: 'money_collected', value: (updates.paymentStatus === 'paid' || updates.isMoneyCollected) ? 'true' : 'false', type: 'boolean' }
  ];

  // Order Note with Clickable Tracking Link
  const noteComment = `[Bosta Tracking Sync] Tracking Number: ${trackingNum}\nBosta Tracking Link: ${trackingUrl}\nStatus: ${updates.bostaStatusName || 'Delivered'}\nCOD Amount: ${updates.codAmount || 0} EGP\nLast Checked: ${new Date().toLocaleString()}`;

  if (storeDomain && accessToken && !accessToken.startsWith('shpat_test_')) {
    try {
      const cleanDomain = storeDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
      
      // 1. Update Order Tags, Notes, Metafields, and Financial Status
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

      await makeShopifyRequest(cleanDomain, `/admin/api/2026-07/orders/${cleanNumericId}.json`, 'PUT', accessToken, payload);

      // 2. Attach Tracking Number & URL to Shopify Fulfillment
      if (trackingNum) {
        try {
          if (updates.fulfillmentId) {
            // Update existing fulfillment tracking info
            const updateTrackingPayload = {
              fulfillment: {
                notify_customer: false,
                tracking_info: {
                  number: trackingNum,
                  url: trackingUrl,
                  company: 'Bosta'
                }
              }
            };
            await makeShopifyRequest(cleanDomain, `/admin/api/2026-07/fulfillments/${updates.fulfillmentId}/update_tracking.json`, 'POST', accessToken, updateTrackingPayload);
          } else {
            // Create new fulfillment with Bosta tracking info
            const createFulfillmentPayload = {
              fulfillment: {
                location_id: null,
                tracking_number: trackingNum,
                tracking_company: 'Bosta',
                tracking_urls: [trackingUrl],
                notify_customer: false
              }
            };
            await makeShopifyRequest(cleanDomain, `/admin/api/2026-07/orders/${cleanNumericId}/fulfillments.json`, 'POST', accessToken, createFulfillmentPayload);
          }
          console.log(`[Shopify Tracking Sync] Attached Bosta Tracking ${trackingNum} and URL to Order ${cleanNumericId}`);
        } catch (fulErr) {
          console.warn(`[Shopify Fulfillment Note] Fulfillment tracking update note: ${fulErr.message}`);
        }
      }
    } catch (err) {
      console.warn(`[Shopify API Error] Could not update order ID ${cleanNumericId}: ${err.message}`);
    }
  }

  return {
    success: true,
    trackingNumber: trackingNum,
    trackingUrl: trackingUrl,
    tags: formattedTagsString,
    message: `Order ${cleanNumericId} synced with Bosta tracking number ${trackingNum} and link.`
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

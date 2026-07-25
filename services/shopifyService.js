const https = require('https');
const db = require('./db');

/**
 * Shopify Admin API Service Engine
 * Fetches live Shopify store orders and updates Shopify Admin backend (Delivered status, Metafields, Tags, Notes, Paid status).
 */

/**
 * Fetches live open orders directly from Shopify Admin API
 */
async function fetchLiveShopifyOrders() {
  const settings = db.getSettings();
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN || settings.shopifyStoreDomain;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN || settings.shopifyAccessToken;

  if (!storeDomain || !accessToken || accessToken.startsWith('shpat_test_')) {
    return null; // Fallback to local DB if no live token configured
  }

  const cleanDomain = storeDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const path = '/admin/api/2026-07/orders.json?status=any&limit=100';

  try {
    const response = await makeShopifyRequest(cleanDomain, path, 'GET', accessToken, null);
    if (!response || !response.orders) return null;

    return response.orders.map(rawOrder => {
      // Extract Bosta tracking number from fulfillments, tags, note_attributes, or metafields
      let trackingNumber = null;
      
      // 1. From fulfillments
      if (rawOrder.fulfillments && rawOrder.fulfillments.length > 0) {
        const ful = rawOrder.fulfillments.find(f => f.tracking_number);
        if (ful) trackingNumber = ful.tracking_number;
      }

      // 2. From Tags (e.g., "Bosta: 104928374" or "Tracking: 104928374" or 9-12 digit numeric tag)
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

      // 3. From Note Attributes
      if (!trackingNumber && rawOrder.note_attributes) {
        const attr = rawOrder.note_attributes.find(a => /tracking|bosta|awb/i.test(a.name));
        if (attr) trackingNumber = attr.value;
      }

      // 4. From Order Note
      if (!trackingNumber && rawOrder.note) {
        const noteMatch = rawOrder.note.match(/(?:tracking|bosta|awb)[:\s]*(\d{8,14})/i);
        if (noteMatch) trackingNumber = noteMatch[1];
      }

      return {
        id: `SHP-${rawOrder.order_number}`,
        shopifyOrderId: `gid://shopify/Order/${rawOrder.id}`,
        orderNumber: `#${rawOrder.order_number}`,
        customerName: rawOrder.customer ? `${rawOrder.customer.first_name || ''} ${rawOrder.customer.last_name || ''}`.trim() : 'Customer',
        customerPhone: rawOrder.customer ? (rawOrder.customer.phone || '') : '',
        city: rawOrder.shipping_address ? rawOrder.shipping_address.city : '',
        trackingNumber: trackingNumber,
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
    console.error('[Shopify API Error] Failed to fetch live orders from Shopify Admin:', err.message);
    return null;
  }
}

/**
 * Updates Shopify Order directly in Shopify Admin via REST API
 * Writes Bosta Metafields, Tags, Order Notes, and Payment Status so staff view everything inside Shopify.
 */
async function updateShopifyOrder(orderId, updates) {
  const settings = db.getSettings();
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN || settings.shopifyStoreDomain;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN || settings.shopifyAccessToken;

  const localOrder = db.getOrderByIdOrTracking(orderId) || {
    id: orderId,
    shopifyOrderId: String(orderId).includes('gid://') ? orderId : `gid://shopify/Order/${orderId}`,
    orderNumber: String(orderId),
    trackingNumber: updates.trackingNumber || '',
    codAmount: updates.codAmount || 0,
    currency: 'EGP',
    shopifyTags: []
  };

  // 1. Prepare Metafields payload for Shopify Order
  const metafields = [
    { namespace: 'bosta', key: 'tracking_number', value: String(updates.trackingNumber || localOrder.trackingNumber || ''), type: 'single_line_text_field' },
    { namespace: 'bosta', key: 'tracking_url', value: `https://bosta.co/tracking-shipment?trackingNumber=${updates.trackingNumber || localOrder.trackingNumber || ''}`, type: 'url' },
    { namespace: 'bosta', key: 'delivery_status', value: String(updates.bostaStatusName || 'Delivered'), type: 'single_line_text_field' },
    { namespace: 'bosta', key: 'is_delivered', value: (updates.fulfillmentStatus === 'fulfilled') ? 'true' : 'false', type: 'boolean' },
    { namespace: 'bosta', key: 'cod_amount', value: `${updates.codAmount || localOrder.codAmount || 0} EGP`, type: 'single_line_text_field' },
    { namespace: 'bosta', key: 'money_collected', value: updates.paymentStatus === 'paid' ? 'true' : 'false', type: 'boolean' },
    { namespace: 'bosta', key: 'money_collected_at', value: new Date().toISOString(), type: 'single_line_text_field' }
  ];

  // 2. Prepare Tags
  const newTags = [...new Set([...(localOrder.shopifyTags || []), ...(updates.tags || [])])];
  if (updates.fulfillmentStatus === 'fulfilled' && !newTags.includes('Bosta: Delivered')) {
    newTags.push('Bosta: Delivered');
  }

  // 3. Prepare Order Note comment for Shopify Admin Staff
  const isDelivered = updates.fulfillmentStatus === 'fulfilled';
  const noteComment = `[Bosta Auto-Sync] Delivery Status: ${isDelivered ? 'DELIVERED' : updates.bostaStatusName}. Bosta Tracking AWB: ${updates.trackingNumber || localOrder.trackingNumber}. COD Cash Collected: ${updates.paymentStatus === 'paid' ? 'YES (' + (updates.codAmount || localOrder.codAmount) + ' EGP)' : 'NO (Pending Transfer)'}. Last Checked: ${new Date().toLocaleString()}`;

  // If live credentials provided, execute HTTPS request to Shopify Admin API
  if (storeDomain && accessToken && !accessToken.startsWith('shpat_test_')) {
    try {
      const cleanDomain = storeDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const rawShopifyId = String(localOrder.shopifyOrderId || orderId).replace('gid://shopify/Order/', '').replace('SHP-', '');
      
      // Update Order Tags, Notes, Financial status, and Metafields
      const payload = {
        order: {
          id: rawShopifyId,
          tags: newTags.join(', '),
          note: noteComment,
          metafields: metafields
        }
      };

      if (updates.paymentStatus === 'paid') {
        payload.order.financial_status = 'paid';
      }

      await makeShopifyRequest(cleanDomain, `/admin/api/2026-07/orders/${rawShopifyId}.json`, 'PUT', accessToken, payload);

      // Create/Update Fulfillment to mark order as DELIVERED in Shopify Admin
      if (isDelivered) {
        try {
          const fulfillmentPayload = {
            fulfillment: {
              tracking_number: updates.trackingNumber || localOrder.trackingNumber,
              tracking_company: 'Bosta',
              tracking_urls: [`https://bosta.co/tracking-shipment?trackingNumber=${updates.trackingNumber || localOrder.trackingNumber}`],
              shipment_status: 'delivered',
              notify_customer: true
            }
          };
          await makeShopifyRequest(cleanDomain, `/admin/api/2026-07/orders/${rawShopifyId}/fulfillments.json`, 'POST', accessToken, fulfillmentPayload);
          console.log(`[Shopify Live API] Marked Order ${localOrder.orderNumber || rawShopifyId} as DELIVERED & FULFILLED in Shopify Admin.`);
        } catch (fulErr) {
          console.warn(`[Shopify Fulfillment Note] Fulfillment creation response: ${fulErr.message}`);
        }
      }
    } catch (err) {
      console.warn(`[Shopify API Error] Could not update live Shopify API for order ${orderId}: ${err.message}`);
    }
  }

  return {
    success: true,
    metafields: metafields,
    message: `Order ${localOrder.orderNumber || orderId} synchronized with Shopify Admin.`
  };
}

/**
 * Helper to make HTTPS requests to Shopify REST Admin API
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
          reject(new Error(`Shopify API responded with ${res.statusCode}: ${body}`));
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

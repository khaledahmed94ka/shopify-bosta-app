const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '../data.json');

// Initial default data seed
const defaultData = {
  settings: {
    bostaApiKey: 'bosta_test_key_998877665544332211',
    bostaEnvironment: 'sandbox', // 'sandbox' or 'live'
    shopifyStoreDomain: 'my-awesome-store.myshopify.com',
    shopifyAccessToken: 'shpat_test_token_1234567890abcdef',
    dailySyncHour: '00', // 00:00 midnight daily
    dailySyncMinute: '00',
    autoTagOrders: true,
    autoMarkPaid: true,
    autoFulfillDelivered: true,
    lastSyncTime: null
  },
  orders: [
    {
      id: 'SHP-1001',
      shopifyOrderId: 'gid://shopify/Order/5839201948',
      orderNumber: '#1001',
      customerName: 'Ahmed Mansour',
      customerPhone: '+201012345678',
      city: 'Cairo',
      trackingNumber: '104928374',
      bostaDeliveryId: 'DEL-99201',
      codAmount: 850.00,
      currency: 'EGP',
      bostaStatus: 'DELIVERED',
      bostaStatusName: 'Delivered',
      isMoneyCollected: true,
      moneyCollectedAmount: 850.00,
      moneyCollectedAt: '2026-07-24T14:30:00Z',
      shopifyFulfillmentStatus: 'fulfilled',
      shopifyPaymentStatus: 'paid',
      shopifyTags: ['Bosta: Delivered', 'Bosta: Cash Collected'],
      lastCheckedAt: '2026-07-25T00:00:00Z',
      syncStatus: 'SYNCED'
    },
    {
      id: 'SHP-1002',
      shopifyOrderId: 'gid://shopify/Order/5839201949',
      orderNumber: '#1002',
      customerName: 'Sara Hassan',
      customerPhone: '+201198765432',
      city: 'Alexandria',
      trackingNumber: '204859102',
      bostaDeliveryId: 'DEL-99202',
      codAmount: 1450.00,
      currency: 'EGP',
      bostaStatus: 'OUT_FOR_DELIVERY',
      bostaStatusName: 'Out for Delivery',
      isMoneyCollected: false,
      moneyCollectedAmount: 0.00,
      moneyCollectedAt: null,
      shopifyFulfillmentStatus: 'in_transit',
      shopifyPaymentStatus: 'pending',
      shopifyTags: ['Bosta: In Transit'],
      lastCheckedAt: '2026-07-25T00:00:00Z',
      syncStatus: 'PENDING'
    },
    {
      id: 'SHP-1003',
      shopifyOrderId: 'gid://shopify/Order/5839201950',
      orderNumber: '#1003',
      customerName: 'Mohamed Ali',
      customerPhone: '+201234567890',
      city: 'Giza',
      trackingNumber: '309482711',
      bostaDeliveryId: 'DEL-99203',
      codAmount: 620.00,
      currency: 'EGP',
      bostaStatus: 'DELIVERED',
      bostaStatusName: 'Delivered',
      isMoneyCollected: false, // Delivered today, money collection pending transfer
      moneyCollectedAmount: 0.00,
      moneyCollectedAt: null,
      shopifyFulfillmentStatus: 'fulfilled',
      shopifyPaymentStatus: 'pending',
      shopifyTags: ['Bosta: Delivered', 'Bosta: COD Pending'],
      lastCheckedAt: '2026-07-25T00:00:00Z',
      syncStatus: 'REQUIRES_COLLECTION'
    },
    {
      id: 'SHP-1004',
      shopifyOrderId: 'gid://shopify/Order/5839201951',
      orderNumber: '#1004',
      customerName: 'Nour El-Din',
      customerPhone: '+201099887766',
      city: 'Maadi, Cairo',
      trackingNumber: '401928374',
      bostaDeliveryId: 'DEL-99204',
      codAmount: 2100.00,
      currency: 'EGP',
      bostaStatus: 'DELIVERED',
      bostaStatusName: 'Delivered',
      isMoneyCollected: true,
      moneyCollectedAmount: 2100.00,
      moneyCollectedAt: '2026-07-25T11:15:00Z',
      shopifyFulfillmentStatus: 'fulfilled',
      shopifyPaymentStatus: 'paid',
      shopifyTags: ['Bosta: Delivered', 'Bosta: Cash Collected'],
      lastCheckedAt: '2026-07-25T12:00:00Z',
      syncStatus: 'SYNCED'
    },
    {
      id: 'SHP-1005',
      shopifyOrderId: 'gid://shopify/Order/5839201952',
      orderNumber: '#1005',
      customerName: 'Kareem Ibrahim',
      customerPhone: '+201155443322',
      city: 'Tanta',
      trackingNumber: '508291039',
      bostaDeliveryId: 'DEL-99205',
      codAmount: 990.00,
      currency: 'EGP',
      bostaStatus: 'PACKAGE_RECEIVED',
      bostaStatusName: 'Package Received at Warehouse',
      isMoneyCollected: false,
      moneyCollectedAmount: 0.00,
      moneyCollectedAt: null,
      shopifyFulfillmentStatus: 'unfulfilled',
      shopifyPaymentStatus: 'pending',
      shopifyTags: ['Bosta: Dispatched'],
      lastCheckedAt: '2026-07-25T00:00:00Z',
      syncStatus: 'PENDING'
    }
  ],
  logs: [
    {
      id: 'LOG-1001',
      timestamp: '2026-07-25T00:00:00Z',
      type: 'DAILY_CRON',
      totalChecked: 5,
      totalUpdated: 2,
      moneyCollectedCount: 2,
      totalMoneyCollected: 2950.00,
      status: 'SUCCESS',
      details: 'Daily sync executed successfully. Verified 5 orders with Bosta API. 2 orders confirmed delivered and cash collected.'
    },
    {
      id: 'LOG-1002',
      timestamp: '2026-07-24T00:00:00Z',
      type: 'DAILY_CRON',
      totalChecked: 4,
      totalUpdated: 1,
      moneyCollectedCount: 1,
      totalMoneyCollected: 850.00,
      status: 'SUCCESS',
      details: 'Daily sync completed. 1 order marked as paid (COD collected).'
    }
  ]
};

function readDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      writeDb(defaultData);
      return defaultData;
    }
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading DB, falling back to default:', err);
    return defaultData;
  }
}

function writeDb(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing DB:', err);
  }
}

module.exports = {
  getSettings: () => readDb().settings,
  updateSettings: (newSettings) => {
    const db = readDb();
    db.settings = { ...db.settings, ...newSettings };
    writeDb(db);
    return db.settings;
  },
  getOrders: () => readDb().orders,
  getOrderByIdOrTracking: (query) => {
    const db = readDb();
    const q = query.trim().toLowerCase();
    return db.orders.find(
      o => o.trackingNumber.toLowerCase() === q ||
           o.orderNumber.toLowerCase() === q ||
           o.orderNumber.toLowerCase() === `#${q}` ||
           o.id.toLowerCase() === q
    );
  },
  updateOrder: (updatedOrder) => {
    const db = readDb();
    const index = db.orders.findIndex(o => o.id === updatedOrder.id);
    if (index !== -1) {
      db.orders[index] = { ...db.orders[index], ...updatedOrder };
      writeDb(db);
      return db.orders[index];
    }
    return null;
  },
  addOrder: (order) => {
    const db = readDb();
    db.orders.unshift(order);
    writeDb(db);
    return order;
  },
  getLogs: () => readDb().logs,
  addLog: (log) => {
    const db = readDb();
    const newLog = {
      id: `LOG-${Date.now()}`,
      timestamp: new Date().toISOString(),
      ...log
    };
    db.logs.unshift(newLog);
    writeDb(db);
    return newLog;
  }
};

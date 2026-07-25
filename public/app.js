document.addEventListener('DOMContentLoaded', () => {
  // Global State
  let currentTab = 'dashboard';
  let allOrders = [];
  let currentFilter = 'all';

  // DOM Elements
  const navItems = document.querySelectorAll('.nav-item');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const pageTitle = document.getElementById('pageTitle');
  const pageSubtitle = document.getElementById('pageSubtitle');
  const sidebarSyncStatus = document.getElementById('sidebarSyncStatus');

  // Action Buttons
  const btnRefreshData = document.getElementById('btnRefreshData');
  const btnRunSync = document.getElementById('btnRunSync');
  const btnGoToOrders = document.getElementById('btnGoToOrders');
  const btnRefreshLogs = document.getElementById('btnRefreshLogs');

  // Search Forms
  const dashTrackForm = document.getElementById('dashTrackForm');
  const mainTrackForm = document.getElementById('mainTrackForm');
  const dashTrackingInput = document.getElementById('dashTrackingInput');
  const mainTrackingInput = document.getElementById('mainTrackingInput');

  // Modal
  const trackingModal = document.getElementById('trackingModal');
  const closeModal = document.getElementById('closeModal');
  const modalBodyContent = document.getElementById('modalBodyContent');

  // Init App
  init();

  function init() {
    setupTabNavigation();
    setupEventListeners();
    loadDashboardData();
    loadOrdersData();
    loadLogsData();
    loadSettingsData();
  }

  // --------------------------------------------------
  // TAB NAVIGATION & ROUTING
  // --------------------------------------------------
  function setupTabNavigation() {
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        const targetTab = item.getAttribute('data-tab');
        switchTab(targetTab);
      });
    });

    if (btnGoToOrders) {
      btnGoToOrders.addEventListener('click', () => switchTab('orders'));
    }
  }

  function switchTab(tabId) {
    currentTab = tabId;
    navItems.forEach(item => {
      if (item.getAttribute('data-tab') === tabId) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    tabPanes.forEach(pane => {
      if (pane.id === `tab-${tabId}`) {
        pane.classList.add('active');
      } else {
        pane.classList.remove('active');
      }
    });

    // Update Titles
    const titles = {
      dashboard: { title: 'Dashboard & COD Analytics', sub: 'Real-time Bosta API sync & daily cash collection verification' },
      tracking: { title: 'Bosta Order Tracker', sub: 'Instant lookup by tracking number or airwaybill' },
      orders: { title: 'Shopify Orders & Bosta Tracking', sub: 'Manage order status and COD cash collection transfers' },
      'sync-logs': { title: 'Daily Sync Execution Logs', sub: 'Audit trail of background automated daily checks' },
      settings: { title: 'App Settings & Daily Schedule', sub: 'Configure Bosta API tokens and daily background cron' }
    };

    if (titles[tabId]) {
      pageTitle.textContent = titles[tabId].title;
      pageSubtitle.textContent = titles[tabId].sub;
    }
  }

  // --------------------------------------------------
  // DATA FETCHING & DASHBOARD RENDERING
  // --------------------------------------------------
  async function loadDashboardData() {
    try {
      const res = await fetch('/api/dashboard');
      const data = await res.json();

      if (data.success) {
        const { stats, settings } = data;

        document.getElementById('kpiTotalOrders').textContent = stats.totalOrders;
        document.getElementById('kpiCollectedAmount').textContent = `${formatCurrency(stats.totalCollectedAmount)} EGP`;
        document.getElementById('kpiCollectionRate').textContent = `${stats.collectionRate}% Collection Rate`;
        document.getElementById('kpiPendingAmount').textContent = `${formatCurrency(stats.totalPendingAmount)} EGP`;
        document.getElementById('kpiPendingCount').textContent = `${stats.pendingCodCount} Delivered Orders`;
        document.getElementById('kpiInTransitCount').textContent = stats.inTransitCount;

        if (sidebarSyncStatus) {
          sidebarSyncStatus.textContent = `Scheduled (${settings.dailySyncSchedule} Daily)`;
        }
      }
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
      showToast('Error loading dashboard stats', 'error');
    }
  }

  async function loadOrdersData() {
    try {
      const res = await fetch('/api/orders');
      const data = await res.json();

      if (data.success) {
        allOrders = data.orders;
        renderOrdersTables();
      }
    } catch (err) {
      console.error('Failed to load orders:', err);
    }
  }

  function renderOrdersTables() {
    renderDashTable();
    renderMainOrdersTable();
  }

  function renderDashTable() {
    const tbody = document.getElementById('dashOrdersTableBody');
    if (!tbody) return;

    // Show orders needing collection or active
    const attentionOrders = allOrders.slice(0, 5);

    if (attentionOrders.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center">No active orders found</td></tr>`;
      return;
    }

    tbody.innerHTML = attentionOrders.map(o => `
      <tr>
        <td><strong>${o.orderNumber}</strong></td>
        <td>${o.customerName}</td>
        <td><code>${o.trackingNumber}</code></td>
        <td>${renderStatusBadge(o.bostaStatus, o.bostaStatusName)}</td>
        <td><strong>${formatCurrency(o.codAmount)} EGP</strong></td>
        <td>${o.isMoneyCollected ? '<span class="badge badge-success"><i class="fa-solid fa-circle-check"></i> Collected</span>' : '<span class="badge badge-warning"><i class="fa-solid fa-clock"></i> Pending COD</span>'}</td>
        <td>
          <button class="btn btn-sm btn-outline btn-track-modal" data-track="${o.trackingNumber}">
            <i class="fa-solid fa-eye"></i> Track
          </button>
        </td>
      </tr>
    `).join('');
  }

  function renderMainOrdersTable() {
    const tbody = document.getElementById('ordersTableBody');
    if (!tbody) return;

    let filtered = allOrders;
    if (currentFilter === 'collected') {
      filtered = allOrders.filter(o => o.isMoneyCollected);
    } else if (currentFilter === 'pending_collection') {
      filtered = allOrders.filter(o => o.bostaStatus === 'DELIVERED' && !o.isMoneyCollected);
    } else if (currentFilter === 'in_transit') {
      filtered = allOrders.filter(o => o.bostaStatus === 'OUT_FOR_DELIVERY' || o.bostaStatus === 'PACKAGE_RECEIVED');
    } else if (currentFilter === 'delivered') {
      filtered = allOrders.filter(o => o.bostaStatus === 'DELIVERED');
    }

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="text-center">No orders match the selected filter</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(o => `
      <tr>
        <td><strong>${o.orderNumber}</strong><br><small style="color:#94a3b8">${o.id}</small></td>
        <td><strong>${o.customerName}</strong><br><small style="color:#94a3b8">${o.city}</small></td>
        <td><code style="color:#06b6d4; font-weight:600;">${o.trackingNumber}</code></td>
        <td>${renderStatusBadge(o.bostaStatus, o.bostaStatusName)}</td>
        <td><strong>${formatCurrency(o.codAmount)} EGP</strong></td>
        <td>${o.isMoneyCollected ? `<span class="badge badge-success"><i class="fa-solid fa-check"></i> ${formatCurrency(o.moneyCollectedAmount)} EGP</span>` : '<span class="badge badge-warning"><i class="fa-solid fa-clock"></i> Pending COD</span>'}</td>
        <td>${(o.shopifyTags || []).map(t => `<span class="badge badge-secondary" style="font-size:0.7rem;">${t}</span>`).join(' ')}</td>
        <td><small>${formatTimeAgo(o.lastCheckedAt)}</small></td>
        <td>
          <button class="btn btn-sm btn-accent btn-track-modal" data-track="${o.trackingNumber}">
            <i class="fa-solid fa-magnifying-glass"></i> Track
          </button>
        </td>
      </tr>
    `).join('');
  }

  // --------------------------------------------------
  // REAL-TIME BOSTA TRACKING LOOKUP
  // --------------------------------------------------
  async function performTrackingSearch(trackingNumber) {
    if (!trackingNumber) return;

    showToast(`Querying Bosta API for tracking: ${trackingNumber}...`, 'info');

    try {
      const res = await fetch('/api/bosta/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackingNumber })
      });
      const result = await res.json();

      if (result.success) {
        openTrackingModal(result.data, result.order);
      } else {
        showToast(result.error || 'Failed to track order', 'error');
      }
    } catch (err) {
      showToast('Network error during Bosta tracking lookup', 'error');
    }
  }

  function openTrackingModal(bostaData, orderData) {
    modalBodyContent.innerHTML = `
      <div class="tracking-modal-card">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:1.25rem;">
          <div>
            <span style="font-size:0.8rem; color:#94a3b8; text-transform:uppercase;">Tracking Number</span>
            <h2 style="font-family:var(--font-heading); color:#06b6d4; font-size:1.6rem;">${bostaData.trackingNumber}</h2>
            ${orderData ? `<span style="font-size:0.85rem; color:#cbd5e1;">Shopify Order ${orderData.orderNumber} (${orderData.customerName})</span>` : ''}
          </div>
          <div>
            ${renderStatusBadge(bostaData.status, bostaData.statusName)}
          </div>
        </div>

        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:1rem; background:rgba(15,23,42,0.6); padding:1rem; border-radius:12px; margin-bottom:1.5rem; border:1px solid rgba(255,255,255,0.08);">
          <div>
            <span style="font-size:0.75rem; color:#94a3b8; display:block;">COD Amount</span>
            <strong style="font-size:1.1rem; color:white;">${formatCurrency(bostaData.codAmount)} EGP</strong>
          </div>
          <div>
            <span style="font-size:0.75rem; color:#94a3b8; display:block;">Cash Collection Status</span>
            ${bostaData.isMoneyCollected ? `<strong style="color:#10b981;"><i class="fa-solid fa-circle-check"></i> Money Collected</strong>` : `<strong style="color:#f59e0b;"><i class="fa-solid fa-clock"></i> Pending Transfer</strong>`}
          </div>
        </div>

        <h4 style="font-size:0.95rem; margin-bottom:0.75rem;"><i class="fa-solid fa-timeline"></i> Bosta Delivery Timeline</h4>
        
        <div class="timeline">
          ${bostaData.timeline.map((item, idx) => `
            <div class="timeline-item">
              <div class="timeline-dot ${idx === bostaData.timeline.length - 1 ? 'done' : ''}"></div>
              <div class="timeline-content">
                <h4>${formatStateName(item.state)}</h4>
                <p>${item.note || 'Shipment status updated'}</p>
                <div class="timeline-time">${formatDate(item.timestamp)}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    trackingModal.classList.add('active');
  }

  // --------------------------------------------------
  // RUN MANUAL SYNC
  // --------------------------------------------------
  async function triggerManualSync() {
    btnRunSync.disabled = true;
    btnRunSync.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Running Sync...`;

    try {
      const res = await fetch('/api/sync/run', { method: 'POST' });
      const data = await res.json();

      if (data.success) {
        showToast(`Sync finished! ${data.result.log.details}`, 'success');
        await loadDashboardData();
        await loadOrdersData();
        await loadLogsData();
      } else {
        showToast(`Sync failed: ${data.error}`, 'error');
      }
    } catch (err) {
      showToast('Error executing manual sync', 'error');
    } finally {
      btnRunSync.disabled = false;
      btnRunSync.innerHTML = `<i class="fa-solid fa-bolt-lightning"></i> Run Sync Now`;
    }
  }

  // --------------------------------------------------
  // LOGS & SETTINGS
  // --------------------------------------------------
  async function loadLogsData() {
    try {
      const res = await fetch('/api/logs');
      const data = await res.json();

      if (data.success) {
        const tbody = document.getElementById('logsTableBody');
        if (!tbody) return;

        tbody.innerHTML = data.logs.map(l => `
          <tr>
            <td><code>${l.id}</code></td>
            <td><small>${formatDate(l.timestamp)}</small></td>
            <td>${l.type === 'DAILY_CRON' ? '<span class="badge badge-info"><i class="fa-solid fa-calendar-day"></i> Daily Cron</span>' : '<span class="badge badge-secondary"><i class="fa-solid fa-user"></i> Manual Trigger</span>'}</td>
            <td><strong>${l.totalChecked}</strong></td>
            <td><strong>${l.totalUpdated}</strong></td>
            <td><strong style="color:#10b981;">${l.moneyCollectedCount}</strong></td>
            <td><strong>${formatCurrency(l.totalMoneyCollected)} EGP</strong></td>
            <td><span class="badge badge-success">${l.status}</span><br><small style="color:#94a3b8">${l.details}</small></td>
          </tr>
        `).join('');
      }
    } catch (err) {
      console.error('Failed to load logs:', err);
    }
  }

  async function loadSettingsData() {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();

      if (data.success) {
        const s = data.settings;
        document.getElementById('bostaApiKey').value = s.bostaApiKey || '';
        document.getElementById('bostaEnvironment').value = s.bostaEnvironment || 'sandbox';
        document.getElementById('shopifyStoreDomain').value = s.shopifyStoreDomain || '';
        document.getElementById('shopifyAccessToken').value = s.shopifyAccessToken || '';
        document.getElementById('dailySyncHour').value = s.dailySyncHour || '00';
        document.getElementById('autoTagOrders').checked = !!s.autoTagOrders;
        document.getElementById('autoMarkPaid').checked = !!s.autoMarkPaid;
        document.getElementById('autoFulfillDelivered').checked = !!s.autoFulfillDelivered;
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  }

  async function saveSettings(e) {
    e.preventDefault();

    const payload = {
      bostaApiKey: document.getElementById('bostaApiKey').value.trim(),
      bostaEnvironment: document.getElementById('bostaEnvironment').value,
      shopifyStoreDomain: document.getElementById('shopifyStoreDomain').value.trim(),
      shopifyAccessToken: document.getElementById('shopifyAccessToken').value.trim(),
      dailySyncHour: document.getElementById('dailySyncHour').value,
      autoTagOrders: document.getElementById('autoTagOrders').checked,
      autoMarkPaid: document.getElementById('autoMarkPaid').checked,
      autoFulfillDelivered: document.getElementById('autoFulfillDelivered').checked
    };

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data.success) {
        showToast('Settings saved & daily cron re-scheduled!', 'success');
        if (sidebarSyncStatus) {
          sidebarSyncStatus.textContent = `Scheduled (${payload.dailySyncHour}:00 Daily)`;
        }
      } else {
        showToast('Failed to save settings', 'error');
      }
    } catch (err) {
      showToast('Error saving settings', 'error');
    }
  }

  // --------------------------------------------------
  // EVENT LISTENERS
  // --------------------------------------------------
  function setupEventListeners() {
    btnRefreshData.addEventListener('click', () => {
      loadDashboardData();
      loadOrdersData();
      loadLogsData();
      showToast('Data refreshed!', 'info');
    });

    btnRunSync.addEventListener('click', triggerManualSync);
    
    if (btnRefreshLogs) {
      btnRefreshLogs.addEventListener('click', loadLogsData);
    }

    // Forms
    if (dashTrackForm) {
      dashTrackForm.addEventListener('submit', (e) => {
        e.preventDefault();
        performTrackingSearch(dashTrackingInput.value.trim());
      });
    }

    if (mainTrackForm) {
      mainTrackForm.addEventListener('submit', (e) => {
        e.preventDefault();
        performTrackingSearch(mainTrackingInput.value.trim());
      });
    }

    document.getElementById('settingsForm').addEventListener('submit', saveSettings);

    // Sample Chips
    document.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const track = chip.getAttribute('data-track');
        performTrackingSearch(track);
      });
    });

    // Delegated modal button clicks
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-track-modal');
      if (btn) {
        const trackNum = btn.getAttribute('data-track');
        performTrackingSearch(trackNum);
      }
    });

    // Modal Close
    closeModal.addEventListener('click', () => trackingModal.classList.remove('active'));
    trackingModal.addEventListener('click', (e) => {
      if (e.target === trackingModal) trackingModal.classList.remove('active');
    });

    // Filter Pills
    document.querySelectorAll('.pill').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        currentFilter = pill.getAttribute('data-filter');
        renderMainOrdersTable();
      });
    });
  }

  // --------------------------------------------------
  // UTILITIES & HELPERS
  // --------------------------------------------------
  function renderStatusBadge(statusCode, statusName) {
    switch (statusCode) {
      case 'DELIVERED':
        return `<span class="badge badge-success"><i class="fa-solid fa-circle-check"></i> ${statusName || 'Delivered'}</span>`;
      case 'OUT_FOR_DELIVERY':
        return `<span class="badge badge-info"><i class="fa-solid fa-truck"></i> ${statusName || 'Out for Delivery'}</span>`;
      case 'PACKAGE_RECEIVED':
        return `<span class="badge badge-secondary"><i class="fa-solid fa-warehouse"></i> ${statusName || 'At Hub'}</span>`;
      case 'RETURNED':
        return `<span class="badge badge-danger"><i class="fa-solid fa-rotate-left"></i> ${statusName || 'Returned'}</span>`;
      default:
        return `<span class="badge badge-warning"><i class="fa-solid fa-clock"></i> ${statusName || statusCode}</span>`;
    }
  }

  function formatCurrency(val) {
    return (val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatDate(isoStr) {
    if (!isoStr) return 'N/A';
    const d = new Date(isoStr);
    return d.toLocaleString();
  }

  function formatTimeAgo(isoStr) {
    if (!isoStr) return 'Never';
    const seconds = Math.floor((new Date() - new Date(isoStr)) / 1000);
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function formatStateName(state) {
    const map = {
      'DELIVERED': 'Delivered to Customer',
      'OUT_FOR_DELIVERY': 'Out for Delivery with Driver',
      'PACKAGE_RECEIVED': 'Package Received at Bosta Warehouse',
      'CANCELLED': 'Order Cancelled',
      'RETURNED': 'Returned to Merchant'
    };
    return map[state] || state;
  }

  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle'}"></i> ${message}`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }
});

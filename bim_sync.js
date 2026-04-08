/**
 * BIM Manager – Supabase Sync Adapter
 * Datei: bim_sync.js
 *
 * Dieses Skript ersetzt localStorage transparent durch Supabase-Sync.
 * Alle Module verwenden weiterhin localStorage – Syncing läuft im Hintergrund.
 *
 * EINRICHTUNG:
 * 1. Supabase-Konto anlegen: https://supabase.com (kostenlos)
 * 2. Neues Projekt erstellen
 * 3. Im SQL-Editor ausführen:
 *      CREATE TABLE bim_data (
 *        key TEXT PRIMARY KEY,
 *        value TEXT,
 *        updated_at TIMESTAMPTZ DEFAULT NOW()
 *      );
 *      ALTER TABLE bim_data ENABLE ROW LEVEL SECURITY;
 *      CREATE POLICY "allow_all" ON bim_data FOR ALL USING (true) WITH CHECK (true);
 * 4. Project URL und anon Key unten eintragen (Settings → API)
 */

// ─── KONFIGURATION ────────────────────────────────────────────────────
const BIM_SUPABASE_URL = 'https://frohpggmwdxbnpigyodx.supabase.co_URL';      // z.B. https://xxxx.supabase.co
const BIM_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZyb2hwZ2dtd2R4Ym5waWd5b2R4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2MjY0NzYsImV4cCI6MjA5MTIwMjQ3Nn0.OSJ6FyohNNnuuCpTB1SfC1Y-TaV4wH81a4gXRT8oMOo';  // eyJh...

// ─── SYNC-SCHLÜSSEL ──────────────────────────────────────────────────
// Nur Keys mit diesem Prefix werden synchronisiert
const SYNC_PREFIX = 'bim_';

// ─── STATE ────────────────────────────────────────────────────────────
let _syncEnabled = BIM_SUPABASE_URL !== 'DEINE_SUPABASE_URL';
let _syncQueue = [];
let _syncTimer = null;
let _lastSync = null;
let _syncStatus = 'offline'; // offline | syncing | synced | error

// ─── SUPABASE REST API ────────────────────────────────────────────────
async function _sbFetch(path, options = {}) {
  const url = BIM_SUPABASE_URL + '/rest/v1/' + path;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey': BIM_SUPABASE_KEY,
      'Authorization': 'Bearer ' + BIM_SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
      ...(options.headers || {}),
    },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error('Supabase ' + res.status + ': ' + await res.text());
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return null;
  return res.json().catch(() => null);
}

async function _sbUpsert(key, value) {
  await _sbFetch('bim_data', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
}

async function _sbGetAll() {
  return await _sbFetch('bim_data?select=key,value,updated_at&order=updated_at.desc') || [];
}

// ─── LOCAL STORAGE INTERCEPT ──────────────────────────────────────────
const _origSetItem = localStorage.setItem.bind(localStorage);
const _origGetItem = localStorage.getItem.bind(localStorage);
const _origRemoveItem = localStorage.removeItem.bind(localStorage);

localStorage.setItem = function(key, value) {
  _origSetItem(key, value);
  if (_syncEnabled && key.startsWith(SYNC_PREFIX)) {
    _queueSync(key, value);
  }
};

localStorage.removeItem = function(key) {
  _origRemoveItem(key);
  if (_syncEnabled && key.startsWith(SYNC_PREFIX)) {
    // Mark as deleted by writing null
    _sbUpsert(key, null).catch(console.warn);
  }
};

// ─── SYNC QUEUE (batched writes) ──────────────────────────────────────
function _queueSync(key, value) {
  _syncQueue = _syncQueue.filter(q => q.key !== key);
  _syncQueue.push({ key, value });
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(_flushQueue, 800); // 800ms debounce
}

async function _flushQueue() {
  if (!_syncQueue.length) return;
  const batch = [..._syncQueue];
  _syncQueue = [];
  _setSyncStatus('syncing');
  try {
    await Promise.all(batch.map(({ key, value }) => _sbUpsert(key, value)));
    _lastSync = new Date();
    _setSyncStatus('synced');
  } catch (err) {
    console.warn('[BIM Sync] Schreibfehler:', err.message);
    _setSyncStatus('error');
    // Re-queue for retry
    _syncQueue.push(...batch);
    _syncTimer = setTimeout(_flushQueue, 5000);
  }
}

// ─── INITIAL LOAD FROM SUPABASE ───────────────────────────────────────
async function bimSyncLoad() {
  if (!_syncEnabled) {
    console.info('[BIM Sync] Deaktiviert – localStorage-Modus');
    _updateUI();
    return;
  }
  _setSyncStatus('syncing');
  _showSyncBanner('⏳ Daten werden geladen…');
  try {
    const rows = await _sbGetAll();
    let loaded = 0;
    rows.forEach(row => {
      if (!row.key || !row.key.startsWith(SYNC_PREFIX)) return;
      if (row.value === null) {
        _origRemoveItem(row.key);
      } else {
        // Supabase wins if newer than local
        const local = _origGetItem(row.key);
        _origSetItem(row.key, row.value);
        loaded++;
      }
    });
    _lastSync = new Date();
    _setSyncStatus('synced');
    _showSyncBanner(null);
    console.info(`[BIM Sync] ✓ ${loaded} Keys synchronisiert`);
    // Trigger re-render in current module if possible
    if (typeof render === 'function') setTimeout(render, 100);
    else if (typeof init === 'function') setTimeout(init, 100);
  } catch (err) {
    console.warn('[BIM Sync] Ladefehler:', err.message);
    _setSyncStatus('error');
    _showSyncBanner('⚠ Sync fehlgeschlagen – Lokale Daten werden verwendet');
  }
  _updateUI();
}

// ─── MANUAL SYNC ──────────────────────────────────────────────────────
async function bimSyncNow() {
  await _flushQueue();
  await bimSyncLoad();
}

// ─── UI ────────────────────────────────────────────────────────────────
function _setSyncStatus(status) {
  _syncStatus = status;
  _updateUI();
}

function _updateUI() {
  const dot = document.getElementById('bim-sync-dot');
  const txt = document.getElementById('bim-sync-text');
  if (!dot || !txt) return;
  const MAP = {
    offline:  { color: '#8899b0', label: 'Lokal' },
    syncing:  { color: '#f59e0b', label: 'Syncing…' },
    synced:   { color: '#10b981', label: 'Synchron' },
    error:    { color: '#ef4444', label: 'Sync-Fehler' },
  };
  const s = MAP[_syncStatus] || MAP.offline;
  dot.style.background = s.color;
  txt.textContent = s.label;
  if (_syncStatus === 'syncing') {
    dot.style.animation = 'bim-pulse 1s infinite';
  } else {
    dot.style.animation = '';
  }
}

function _showSyncBanner(msg) {
  let banner = document.getElementById('bim-sync-banner');
  if (!msg) { if (banner) banner.remove(); return; }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'bim-sync-banner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#0f1623;color:#90b8e0;font-size:11px;font-family:monospace;padding:5px 12px;text-align:center;border-bottom:1px solid #1e2d45';
    document.body.prepend(banner);
  }
  banner.textContent = msg;
}

// ─── SYNC INDICATOR (injected into topbar) ────────────────────────────
function _injectSyncIndicator() {
  if (document.getElementById('bim-sync-indicator')) return;
  // Wait for topbar to exist
  const topbarRight = document.querySelector('.topbar-right');
  if (!topbarRight) return;
  const indicator = document.createElement('div');
  indicator.id = 'bim-sync-indicator';
  indicator.title = 'Letzte Synchronisierung – klicken zum Aktualisieren';
  indicator.style.cssText = 'display:flex;align-items:center;gap:5px;cursor:pointer;padding:3px 8px;border-radius:4px;border:1px solid var(--border,#e2e8f0);background:transparent;transition:background 0.1s';
  indicator.innerHTML = `
    <div id="bim-sync-dot" style="width:8px;height:8px;border-radius:50%;background:#8899b0;flex-shrink:0"></div>
    <span id="bim-sync-text" style="font-size:10px;font-family:monospace;color:var(--text3,#8899b0)">Lokal</span>`;
  indicator.addEventListener('click', bimSyncNow);
  indicator.addEventListener('mouseenter', () => indicator.style.background='var(--surface2,#f5f7fa)');
  indicator.addEventListener('mouseleave', () => indicator.style.background='transparent');
  topbarRight.prepend(indicator);

  const style = document.createElement('style');
  style.textContent = '@keyframes bim-pulse{0%,100%{opacity:1}50%{opacity:0.3}}';
  document.head.appendChild(style);
}

// ─── AUTO-START ────────────────────────────────────────────────────────
// Inject indicator and start sync after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(_injectSyncIndicator, 500);
    bimSyncLoad();
  });
} else {
  setTimeout(_injectSyncIndicator, 500);
  bimSyncLoad();
}

// Poll for sync every 30 seconds (live collaboration)
if (_syncEnabled) {
  setInterval(() => {
    if (_syncQueue.length === 0) bimSyncLoad();
  }, 30000);
}

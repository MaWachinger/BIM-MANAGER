/**
 * BIM Manager – Supabase Sync Adapter v3
 *
 * SQL (run once in Supabase SQL Editor):
 *   CREATE TABLE IF NOT EXISTS bim_data (
 *     key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
 *   );
 *   ALTER TABLE bim_data ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "allow_all" ON bim_data FOR ALL USING (true) WITH CHECK (true);
 */

const BIM_SUPABASE_URL = 'https://frohpggmwdxbnpigyodx.supabase.co';
const BIM_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZyb2hwZ2dtd2R4Ym5waWd5b2R4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2MjY0NzYsImV4cCI6MjA5MTIwMjQ3Nn0.OSJ6FyohNNnuuCpTB1SfC1Y-TaV4wH81a4gXRT8oMOo';
const SYNC_PREFIX = 'bim_';
const _enabled = BIM_SUPABASE_URL.indexOf('supabase.co') !== -1;

// ─── STATE ────────────────────────────────────────────────────────────
var _dirty  = {};
var _paused = false;
var _flushTimer = null;
var _status = 'idle';
var _pageLoadTime = Date.now();

// ─── HELPERS ──────────────────────────────────────────────────────────
function _headers() {
  return {
    'apikey': BIM_SUPABASE_KEY,
    'Authorization': 'Bearer ' + BIM_SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates,return=minimal'
  };
}
async function _upsert(key, value) {
  var r = await fetch(BIM_SUPABASE_URL + '/rest/v1/bim_data', {
    method: 'POST', headers: _headers(),
    body: JSON.stringify({key:key,value:value,updated_at:new Date().toISOString()})
  });
  if (!r.ok) throw new Error('upsert ' + r.status);
}
async function _fetchAll() {
  var r = await fetch(
    BIM_SUPABASE_URL + '/rest/v1/bim_data?select=key,value&key=like.' + SYNC_PREFIX + '*',
    {headers: _headers()}
  );
  if (!r.ok) throw new Error('fetch ' + r.status);
  return r.json();
}

// ─── WRITE QUEUE ──────────────────────────────────────────────────────
function _markDirty(key, value) {
  if (!_enabled || _paused) return;
  _dirty[key] = value;
  clearTimeout(_flushTimer);
  _flushTimer = setTimeout(_flush, 1200);
}
async function _flush() {
  if (!_enabled || Object.keys(_dirty).length === 0) return;
  var batch = _dirty; _dirty = {};
  _setStatus('syncing');
  try {
    await Promise.all(Object.keys(batch).map(function(k){ return _upsert(k, batch[k]); }));
    _setStatus('ok');
  } catch(e) {
    console.warn('[BIM Sync] write error:', e.message);
    _setStatus('error');
    Object.assign(_dirty, batch);
    _flushTimer = setTimeout(_flush, 8000);
  }
}

// Pause/resume for bulk operations (seed data)
function bimSyncPause()  { _paused = true; clearTimeout(_flushTimer); }
function bimSyncResume() {
  _paused = false;
  if (Object.keys(_dirty).length > 0) {
    _flushTimer = setTimeout(_flush, 2000);
  }
}

// ─── PATCH localStorage ────────────────────────────────────────────────
(function(){
  var _orig = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function(key, value) {
    _orig(key, value);
    if (key && key.indexOf(SYNC_PREFIX) === 0) _markDirty(key, value);
  };
})();

// ─── INITIAL PULL ─────────────────────────────────────────────────────
// KEY FIX: after pulling Supabase data, reload ONCE so init() runs with correct data
async function bimSyncLoad() {
  if (!_enabled) { _setStatus('local'); _updateUI(); return; }
  _setStatus('syncing');
  try {
    var rows = await _fetchAll();
    var n = 0;
    var _origSet = Object.getPrototypeOf(localStorage).setItem.bind(localStorage);
    rows.forEach(function(row) {
      if (!row.key || row.value === null || row.value === undefined) return;
      if (localStorage.getItem(row.key) !== row.value) {
        _origSet(row.key, row.value);  // write without triggering queue
        n++;
      }
    });
    _setStatus('ok');
    if (n > 0) {
      console.info('[BIM Sync] pulled ' + n + ' key(s) from Supabase');
      // RELOAD ONCE after first sync so init() runs with correct data
      if (!sessionStorage.getItem('_bimSyncDone')) {
        sessionStorage.setItem('_bimSyncDone', '1');
        console.info('[BIM Sync] First sync complete – reloading page');
        window.location.reload();
        return;
      }
    }
  } catch(e) {
    console.warn('[BIM Sync] pull error:', e.message);
    _setStatus('error');
  }
  _updateUI();
}

// Force reload on next visit (clears the "already synced" flag after tab close)
// sessionStorage auto-clears on tab close, so this is handled automatically.

// Manual sync button
async function bimSyncNow() {
  sessionStorage.removeItem('_bimSyncDone');
  await bimSyncLoad();
}

// Poll every 30s for collaborative updates
if (_enabled) {
  setInterval(function() {
    if (Object.keys(_dirty).length === 0) {
      // Silent pull: update localStorage but only reload if major change
      _fetchAll().then(function(rows) {
        var n = 0;
        var _origSet = Object.getPrototypeOf(localStorage).setItem.bind(localStorage);
        rows.forEach(function(row) {
          if (!row.key || row.value === null) return;
          if (localStorage.getItem(row.key) !== row.value) {
            _origSet(row.key, row.value);
            n++;
          }
        });
        if (n > 0) {
          console.info('[BIM Sync] poll: ' + n + ' key(s) updated');
          _setStatus('ok');
          _updateUI();
          // Soft re-render: call render() if available and no user is mid-edit
          if (typeof render === 'function') {
            try { render(); } catch(e) {}
          } else if (typeof renderProjects === 'function') {
            try { renderProjects(); } catch(e) {}
          }
        }
      }).catch(function(e){ _setStatus('error'); _updateUI(); });
    }
  }, 30000);
}

// ─── UI INDICATOR ──────────────────────────────────────────────────────
function _setStatus(s) { _status = s; _updateUI(); }
function _updateUI() {
  var dot = document.getElementById('bim-sync-dot');
  var txt = document.getElementById('bim-sync-text');
  if (!dot || !txt) return;
  var MAP = {
    local:   {c:'#8899b0', t:'Lokal'},
    idle:    {c:'#8899b0', t:'Lokal'},
    syncing: {c:'#f59e0b', t:'Sync…'},
    ok:      {c:'#10b981', t:'Synchron'},
    error:   {c:'#ef4444', t:'Offline'}
  };
  var s = MAP[_status] || MAP.idle;
  dot.style.background = s.c;
  txt.textContent = s.t;
}
function _injectIndicator() {
  if (document.getElementById('bim-sync-indicator')) return;
  var bar = document.querySelector('.topbar-right');
  if (!bar) return;
  var el = document.createElement('div');
  el.id = 'bim-sync-indicator';
  el.title = 'Sync-Status – klicken zum Aktualisieren';
  el.style.cssText = 'display:flex;align-items:center;gap:5px;cursor:pointer;padding:3px 9px;border-radius:4px;border:1px solid #e2e8f0;user-select:none';
  el.innerHTML =
    '<div id="bim-sync-dot" style="width:8px;height:8px;border-radius:50%;background:#8899b0;flex-shrink:0"></div>' +
    '<span id="bim-sync-text" style="font-size:10px;font-family:monospace;color:#8899b0">Lokal</span>';
  el.addEventListener('click', bimSyncNow);
  bar.insertBefore(el, bar.firstChild);
  _updateUI();
}

// ─── BOOT ─────────────────────────────────────────────────────────────
function _boot() {
  _injectIndicator();
  bimSyncLoad();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function(){ setTimeout(_boot, 200); });
} else {
  setTimeout(_boot, 200);
}

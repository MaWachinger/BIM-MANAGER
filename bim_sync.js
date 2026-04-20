/**
 * BIM Manager – Supabase Sync Adapter v2
 *
 * SETUP: Replace the two constants below with your Supabase project values.
 * SQL to run once in Supabase SQL Editor:
 *
 *   CREATE TABLE IF NOT EXISTS bim_data (
 *     key        TEXT PRIMARY KEY,
 *     value      TEXT,
 *     updated_at TIMESTAMPTZ DEFAULT NOW()
 *   );
 *   ALTER TABLE bim_data ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "allow_all" ON bim_data
 *     FOR ALL USING (true) WITH CHECK (true);
 */

const BIM_SUPABASE_URL = 'https://frohpggmwdxbnpigyodx.supabase.co';
const BIM_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZyb2hwZ2dtd2R4Ym5waWd5b2R4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2MjY0NzYsImV4cCI6MjA5MTIwMjQ3Nn0.OSJ6FyohNNnuuCpTB1SfC1Y-TaV4wH81a4gXRT8oMOo';

// Only keys with this prefix are synced
const SYNC_PREFIX = 'bim_';

// ─── INTERNAL STATE ────────────────────────────────────────────────────
const _enabled = (BIM_SUPABASE_URL.indexOf('supabase.co') !== -1);
let   _dirty   = {};   // {key: value} — pending writes
var   _paused  = false;
let   _flushId = null;
let   _status  = 'idle';

// ─── REST HELPERS ──────────────────────────────────────────────────────
function _headers() {
  return {
    'apikey':        BIM_SUPABASE_KEY,
    'Authorization': 'Bearer ' + BIM_SUPABASE_KEY,
    'Content-Type':  'application/json',
    'Prefer':        'resolution=merge-duplicates,return=minimal'
  };
}

async function _upsert(key, value) {
  const r = await fetch(BIM_SUPABASE_URL + '/rest/v1/bim_data', {
    method:  'POST',
    headers: _headers(),
    body:    JSON.stringify({ key: key, value: value, updated_at: new Date().toISOString() })
  });
  if (!r.ok) throw new Error('upsert ' + r.status);
}

async function _fetchAll() {
  const r = await fetch(
    BIM_SUPABASE_URL + '/rest/v1/bim_data?select=key,value&key=like.' + SYNC_PREFIX + '*',
    { headers: _headers() }
  );
  if (!r.ok) throw new Error('fetch ' + r.status);
  return r.json();
}

// ─── WRITE QUEUE (debounced 1 s) ───────────────────────────────────────
function _markDirty(key, value) {
  if (!_enabled) return;
  _dirty[key] = value;
  if (!_paused) {
    clearTimeout(_flushId);
    _flushId = setTimeout(_flush, 1000);
  }
}
function bimSyncPause()  { _paused = true; clearTimeout(_flushId); }
function bimSyncResume() {
  _paused = false;
  if (Object.keys(_dirty).length > 0) {
    _flushId = setTimeout(_flush, 2000);
  }
}

async function _flush() {
  if (!_enabled || Object.keys(_dirty).length === 0) return;
  const batch = _dirty;
  _dirty = {};
  _setStatus('syncing');
  try {
    await Promise.all(Object.entries(batch).map(function(e) { return _upsert(e[0], e[1]); }));
    _setStatus('ok');
  } catch (e) {
    console.warn('[BIM Sync] write error:', e.message);
    _setStatus('error');
    // re-queue for retry
    Object.assign(_dirty, batch);
    _flushId = setTimeout(_flush, 8000);
  }
}

// ─── PATCH localStorage WRITE ONLY ────────────────────────────────────
// We wrap setItem so writes are mirrored to Supabase.
// We do NOT wrap getItem – reads always come from local storage (fast, safe).
(function() {
  var orig = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function(key, value) {
    orig(key, value);                                   // local write first
    if (key && key.indexOf(SYNC_PREFIX) === 0) {
      _markDirty(key, value);                           // then queue remote
    }
  };
})();

// ─── INITIAL PULL FROM SUPABASE ────────────────────────────────────────
async function bimSyncLoad() {
  if (!_enabled) { _setStatus('local'); _updateUI(); return; }
  _setStatus('syncing');
  try {
    var rows = await _fetchAll();
    var n = 0;
    rows.forEach(function(row) {
      if (!row.key || row.value === null || row.value === undefined) return;
      // Only overwrite local if the remote value differs (avoids unnecessary renders)
      if (localStorage.getItem(row.key) !== row.value) {
        // Use the original setItem to avoid re-queuing back to Supabase
        Object.getPrototypeOf(localStorage).setItem.call(localStorage, row.key, row.value);
        n++;
      }
    });
    _setStatus('ok');
    if (n > 0) {
      console.info('[BIM Sync] pulled ' + n + ' updated key(s) from Supabase');
      // Soft page reload: let the module re-read localStorage without full init()
      // Each module re-reads on its own project selector change; we just refresh the badge
      _updateUI();
    }
  } catch (e) {
    console.warn('[BIM Sync] pull error:', e.message);
    _setStatus('error');
  }
  _updateUI();
}

// ─── POLL every 30 s ──────────────────────────────────────────────────
if (_enabled) {
  setInterval(function() {
    if (Object.keys(_dirty).length === 0) bimSyncLoad();
  }, 30000);
}

// ─── STATUS INDICATOR ─────────────────────────────────────────────────
function _setStatus(s) { _status = s; _updateUI(); }

function _updateUI() {
  var dot = document.getElementById('bim-sync-dot');
  var txt = document.getElementById('bim-sync-text');
  if (!dot || !txt) return;
  var map = {
    local:   { c: '#8899b0', t: 'Lokal'    },
    idle:    { c: '#8899b0', t: 'Lokal'    },
    syncing: { c: '#f59e0b', t: 'Sync…'   },
    ok:      { c: '#10b981', t: 'Synchron' },
    error:   { c: '#ef4444', t: 'Offline'  }
  };
  var s = map[_status] || map.idle;
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
  el.style.cssText = [
    'display:flex', 'align-items:center', 'gap:5px',
    'cursor:pointer', 'padding:3px 9px',
    'border-radius:4px', 'border:1px solid #e2e8f0',
    'user-select:none', 'font-family:monospace'
  ].join(';');
  el.innerHTML =
    '<div id="bim-sync-dot" style="width:8px;height:8px;border-radius:50%;background:#8899b0"></div>' +
    '<span id="bim-sync-text" style="font-size:10px;color:#8899b0">Lokal</span>';
  el.addEventListener('click', function() { bimSyncLoad(); });
  bar.insertBefore(el, bar.firstChild);
  _updateUI();
}

// ─── BOOT ─────────────────────────────────────────────────────────────
function _boot() {
  _injectIndicator();
  bimSyncLoad();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() { setTimeout(_boot, 300); });
} else {
  setTimeout(_boot, 300);
}

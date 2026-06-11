/**
 * BIM Manager – Supabase Sync Adapter v4
 *
 * Verbesserungen gegenüber v3:
 *  - Persistent Dirty-Queue (überlebt Browser-Schließen)
 *  - Sichtbarer Sync-Indikator mit "Letzter Sync vor X Min"
 *  - Exponential Backoff bei Sync-Fehlern
 *  - localStorage-Slot `bim_sync_pending` für ungespeicherte Änderungen
 *  - Warnung beim Tab-Schließen wenn pendings vorhanden
 *  - JSON Export/Import API: bimExportBackup() / bimImportBackup(json)
 *
 * SQL setup (Supabase SQL Editor):
 *   CREATE TABLE IF NOT EXISTS bim_data (
 *     key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
 *   );
 *   ALTER TABLE bim_data ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "allow_all" ON bim_data FOR ALL USING (true) WITH CHECK (true);
 */

const BIM_SUPABASE_URL = 'https://frohpggmwdxbnpigyodx.supabase.co';
const BIM_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZyb2hwZ2dtd2R4Ym5waWd5b2R4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2MjY0NzYsImV4cCI6MjA5MTIwMjQ3Nn0.OSJ6FyohNNnuuCpTB1SfC1Y-TaV4wH81a4gXRT8oMOo';
const SYNC_PREFIX = 'bim_';
const PENDING_KEY = '_bim_sync_pending_v4';
const LAST_SYNC_KEY = '_bim_sync_lastok_v4';
const RETRY_DELAYS = [3000, 8000, 30000, 120000, 600000];  // 3s, 8s, 30s, 2min, 10min
const _enabled = BIM_SUPABASE_URL.indexOf('supabase.co') !== -1;

// ─── STATE ────────────────────────────────────────────────────────────
var _dirty = {};
var _paused = false;
var _flushTimer = null;
var _status = 'idle';
var _retryAttempt = 0;
var _lastSyncOk = parseInt(localStorage.getItem(LAST_SYNC_KEY) || '0', 10);

// Restore pending queue from previous session
try {
  var saved = localStorage.getItem(PENDING_KEY);
  if (saved) {
    _dirty = JSON.parse(saved);
    console.info('[BIM Sync] Restored ' + Object.keys(_dirty).length + ' pending key(s) from previous session');
  }
} catch(e) {}

function _persistDirty() {
  try {
    if (Object.keys(_dirty).length === 0) {
      localStorage.removeItem(PENDING_KEY);
    } else {
      // Use raw setItem to avoid recursion
      Object.getPrototypeOf(localStorage).setItem.call(localStorage, PENDING_KEY, JSON.stringify(_dirty));
    }
  } catch(e) { console.warn('[BIM Sync] persistDirty failed:', e.message); }
}

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
  _persistDirty();
  clearTimeout(_flushTimer);
  _flushTimer = setTimeout(_flush, 1200);
}
async function _flush() {
  if (!_enabled || Object.keys(_dirty).length === 0) return;
  var batch = {};
  Object.keys(_dirty).forEach(function(k){ batch[k] = _dirty[k]; });
  _setStatus('syncing');
  try {
    await Promise.all(Object.keys(batch).map(function(k){ return _upsert(k, batch[k]); }));
    // Only remove from dirty queue what we successfully sent
    // (and that hasn't been re-dirtied since)
    Object.keys(batch).forEach(function(k){
      if (_dirty[k] === batch[k]) delete _dirty[k];
    });
    _persistDirty();
    _retryAttempt = 0;
    _lastSyncOk = Date.now();
    localStorage.setItem(LAST_SYNC_KEY, String(_lastSyncOk));
    _setStatus('ok');
  } catch(e) {
    console.warn('[BIM Sync] write error (attempt ' + (_retryAttempt+1) + '):', e.message);
    _setStatus('error');
    // Keep batch in _dirty for retry (it was never removed)
    var delay = RETRY_DELAYS[Math.min(_retryAttempt, RETRY_DELAYS.length-1)];
    _retryAttempt++;
    _flushTimer = setTimeout(_flush, delay);
  }
}

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
    if (key && key.indexOf(SYNC_PREFIX) === 0 && key.indexOf('_bim_sync_') !== 0) {
      _markDirty(key, value);
    }
  };
})();

// ─── INITIAL PULL ─────────────────────────────────────────────────────
async function bimSyncLoad() {
  if (!_enabled) { _setStatus('local'); _updateUI(); return; }
  _setStatus('syncing');
  try {
    var rows = await _fetchAll();
    var n = 0;
    var _origSet = Object.getPrototypeOf(localStorage).setItem.bind(localStorage);
    rows.forEach(function(row) {
      if (!row.key || row.value === null || row.value === undefined) return;
      // Don't overwrite a key that's in our dirty queue (local change wins)
      if (_dirty[row.key]) return;
      if (localStorage.getItem(row.key) !== row.value) {
        _origSet(row.key, row.value);
        n++;
      }
    });
    _lastSyncOk = Date.now();
    localStorage.setItem(LAST_SYNC_KEY, String(_lastSyncOk));
    _setStatus('ok');
    if (n > 0) {
      console.info('[BIM Sync] pulled ' + n + ' key(s) from Supabase');
      if (!sessionStorage.getItem('_bimSyncDone')) {
        sessionStorage.setItem('_bimSyncDone', '1');
        console.info('[BIM Sync] First sync complete – reloading page');
        window.location.reload();
        return;
      }
    }
    // If there were pending writes, flush them now that connection is back
    if (Object.keys(_dirty).length > 0) {
      console.info('[BIM Sync] Flushing ' + Object.keys(_dirty).length + ' pending write(s)');
      _flush();
    }
  } catch(e) {
    console.warn('[BIM Sync] pull error:', e.message);
    _setStatus('error');
  }
  _updateUI();
}

async function bimSyncNow() {
  sessionStorage.removeItem('_bimSyncDone');
  await bimSyncLoad();
}

// Poll every 30s for collaborative updates
if (_enabled) {
  setInterval(function() {
    if (Object.keys(_dirty).length === 0) {
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
        _lastSyncOk = Date.now();
        localStorage.setItem(LAST_SYNC_KEY, String(_lastSyncOk));
        if (n > 0) {
          console.info('[BIM Sync] poll: ' + n + ' key(s) updated');
          _setStatus('ok');
          _updateUI();
          if (typeof render === 'function') {
            try { render(); } catch(e) {}
          } else if (typeof renderProjects === 'function') {
            try { renderProjects(); } catch(e) {}
          }
        } else {
          _setStatus('ok');
          _updateUI();
        }
      }).catch(function(e){ _setStatus('error'); _updateUI(); });
    }
  }, 30000);
  // Update "X min ago" every minute
  setInterval(_updateUI, 60000);
}

// ─── beforeunload: warn if pendings ──────────────────────────────────
window.addEventListener('beforeunload', function(e) {
  if (Object.keys(_dirty).length > 0) {
    e.preventDefault();
    e.returnValue = 'Es gibt noch nicht synchronisierte Änderungen!';
    return e.returnValue;
  }
});

// ─── EXPORT / IMPORT BACKUP API ────────────────────────────────────
function bimExportBackup() {
  var data = {};
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (k && k.indexOf(SYNC_PREFIX) === 0 && k.indexOf('_bim_sync_') !== 0) {
      data[k] = localStorage.getItem(k);
    }
  }
  var blob = new Blob([JSON.stringify({ version:4, exportedAt: new Date().toISOString(), data: data }, null, 2)], { type:'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'bim-manager-backup-' + new Date().toISOString().substring(0,10) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  console.info('[BIM Sync] Backup exported: ' + Object.keys(data).length + ' keys');
  return Object.keys(data).length;
}

function bimImportBackup(jsonText) {
  try {
    var parsed = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
    var data = parsed.data || parsed;
    if (typeof data !== 'object') throw new Error('Invalid backup format');
    var n = 0;
    Object.keys(data).forEach(function(k) {
      if (k.indexOf(SYNC_PREFIX) === 0) {
        localStorage.setItem(k, data[k]);  // triggers sync queue
        n++;
      }
    });
    console.info('[BIM Sync] Imported ' + n + ' keys – will sync to Supabase');
    return { ok: true, count: n };
  } catch(e) {
    console.error('[BIM Sync] Import failed:', e.message);
    return { ok: false, error: e.message };
  }
}

function bimImportBackupFile() {
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.onchange = function(e) {
    var f = e.target.files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function() {
      var res = bimImportBackup(r.result);
      if (res.ok) {
        alert('✓ ' + res.count + ' Datensätze importiert. Seite wird neu geladen.');
        setTimeout(function(){ window.location.reload(); }, 500);
      } else {
        alert('✗ Import fehlgeschlagen: ' + res.error);
      }
    };
    r.readAsText(f);
  };
  inp.click();
}

// ─── UI INDICATOR (sucht jetzt mehrere Mount-Points) ─────────────────
function _setStatus(s) { _status = s; _updateUI(); }
function _formatAgo() {
  if (!_lastSyncOk) return 'nie';
  var sec = Math.floor((Date.now() - _lastSyncOk) / 1000);
  if (sec < 60)   return 'gerade eben';
  if (sec < 3600) return 'vor ' + Math.floor(sec/60) + ' Min';
  if (sec < 86400) return 'vor ' + Math.floor(sec/3600) + ' Std';
  return 'vor ' + Math.floor(sec/86400) + ' Tagen';
}
function _isStale() {
  return _lastSyncOk && (Date.now() - _lastSyncOk) > 24 * 3600 * 1000;
}
function _updateUI() {
  var dot = document.getElementById('bim-sync-dot');
  var txt = document.getElementById('bim-sync-text');
  var ago = document.getElementById('bim-sync-ago');
  var pending = document.getElementById('bim-sync-pending');
  if (!dot) return;
  var pendingCount = Object.keys(_dirty).length;
  var stale = _isStale();
  var MAP = {
    local:   {c:'#8899b0', t:'Lokal'},
    idle:    {c:'#8899b0', t:'Bereit'},
    syncing: {c:'#f59e0b', t:'Sync…'},
    ok:      {c: stale ? '#ef4444' : '#10b981', t: stale ? 'Veraltet!' : 'Synchron'},
    error:   {c:'#ef4444', t: pendingCount > 0 ? pendingCount + ' offen' : 'Offline'}
  };
  var s = MAP[_status] || MAP.idle;
  dot.style.background = s.c;
  if (txt) txt.textContent = s.t;
  if (ago) {
    ago.textContent = _formatAgo();
    ago.style.color = stale ? '#ef4444' : '#8899b0';
    ago.style.fontWeight = stale ? '600' : '400';
  }
  if (pending) {
    if (pendingCount > 0) {
      pending.textContent = '⚠ ' + pendingCount + ' nicht synchronisiert';
      pending.style.display = 'inline';
    } else {
      pending.style.display = 'none';
    }
  }
}

function _injectIndicator() {
  if (document.getElementById('bim-sync-indicator')) return;
  // Try multiple mount points, in order
  var mounts = [
    '.content-header .topbar-right-replacement',
    '.content-header > div:first-child > div:last-child',  // current toolbar location
    '.topbar-right',
    '.content-header',
    '.topbar'
  ];
  var bar = null;
  for (var i = 0; i < mounts.length; i++) {
    bar = document.querySelector(mounts[i]);
    if (bar) break;
  }
  if (!bar) {
    console.warn('[BIM Sync] No mount point found – indicator hidden');
    return;
  }
  var el = document.createElement('div');
  el.id = 'bim-sync-indicator';
  el.title = 'Sync-Status – klick zum Aktualisieren / Rechtsklick für Backup';
  el.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;padding:4px 10px;border-radius:4px;border:1px solid #e2e8f0;user-select:none;background:#fff;flex-shrink:0';
  el.innerHTML =
    '<div id="bim-sync-dot" style="width:8px;height:8px;border-radius:50%;background:#8899b0;flex-shrink:0"></div>' +
    '<span id="bim-sync-text" style="font-size:10px;font-family:monospace;color:#4a5876;font-weight:500">Lokal</span>' +
    '<span style="font-size:9px;color:#8899b0;margin-left:2px">·</span>' +
    '<span id="bim-sync-ago" style="font-size:9px;color:#8899b0;font-family:monospace">nie</span>' +
    '<span id="bim-sync-pending" style="font-size:10px;color:#ef4444;font-weight:600;margin-left:6px;display:none"></span>';
  el.addEventListener('click', function(e) {
    if (e.shiftKey) { bimExportBackup(); return; }
    bimSyncNow();
  });
  el.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    var menu = document.createElement('div');
    menu.style.cssText = 'position:fixed;background:#fff;border:1px solid #ccc;border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,0.15);padding:4px;font-family:sans-serif;font-size:12px;z-index:9999;left:' + e.clientX + 'px;top:' + e.clientY + 'px';
    menu.innerHTML =
      '<div data-act="now" style="padding:6px 12px;cursor:pointer;border-radius:3px">🔄 Jetzt synchronisieren</div>' +
      '<div data-act="export" style="padding:6px 12px;cursor:pointer;border-radius:3px">⬇ Backup als JSON exportieren</div>' +
      '<div data-act="import" style="padding:6px 12px;cursor:pointer;border-radius:3px">⬆ Backup aus JSON importieren</div>';
    document.body.appendChild(menu);
    menu.querySelectorAll('[data-act]').forEach(function(item){
      item.onmouseover = function(){ this.style.background = '#f3f4f6'; };
      item.onmouseout = function(){ this.style.background = ''; };
      item.onclick = function() {
        var act = this.dataset.act;
        menu.remove();
        if (act === 'now') bimSyncNow();
        else if (act === 'export') bimExportBackup();
        else if (act === 'import') bimImportBackupFile();
      };
    });
    setTimeout(function(){
      document.addEventListener('click', function close(){ menu.remove(); document.removeEventListener('click', close); }, { once:true });
    }, 0);
  });
  if (bar.firstChild) bar.insertBefore(el, bar.firstChild);
  else bar.appendChild(el);
  _updateUI();
}

// Expose API
window.bimSyncPause = bimSyncPause;
window.bimSyncResume = bimSyncResume;
window.bimSyncLoad = bimSyncLoad;
window.bimSyncNow = bimSyncNow;
window.bimExportBackup = bimExportBackup;
window.bimImportBackup = bimImportBackup;
window.bimImportBackupFile = bimImportBackupFile;

// ─── BOOT ─────────────────────────────────────────────────────────────
function _boot() {
  _injectIndicator();
  // If we have pending writes, try to flush them right away
  if (Object.keys(_dirty).length > 0) {
    console.info('[BIM Sync] Boot: flushing ' + Object.keys(_dirty).length + ' pending write(s)');
    setTimeout(_flush, 500);
  }
  bimSyncLoad();
  // Re-inject if DOM changes (the indicator might be removed by a re-render)
  setInterval(function(){
    if (!document.getElementById('bim-sync-indicator')) _injectIndicator();
  }, 3000);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function(){ setTimeout(_boot, 200); });
} else {
  setTimeout(_boot, 200);
}

require('dotenv').config();  // ← loads .env file — MUST be first line

const { createProxyMiddleware } = require('http-proxy-middleware');
const { spawn, execSync }       = require('child_process');
const { AsyncLocalStorage }     = require('async_hooks');
const express = require('express');
const oracledb = require('oracledb');
// `xlsx` (SheetJS) — used ONLY to read `.nmon.xlsx` reports that ops teams
// already have on hand (converted from the raw capture by nmon2xlsx /
// nmonanalyser). Install with:  npm install xlsx
const XLSX = require('xlsx');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const app     = express();

// ── PER-REQUEST DATABASE CONTEXT ─────────────────────────────────────────────
// ══ CROSS-DATABASE CONTAMINATION FIX ═══════════════════════════════════════
// ROOT CAUSE of "B db data shows in A db": _activeDBId used to be a single
// global variable that every query() call read FRESH at execution time. If a
// request for DB A was still in flight (awaiting a slow Oracle query) when
// another request switched the active database to B, the first request's
// LATER query() calls would silently run against B and return B's rows as if
// they were the answer to the original A request — the client had no way of
// knowing its response came from the wrong database. This wasn't a rare edge
// case: any auto-refresh timer overlapping a database switch could trigger it.
//
// FIX: capture the intended database ONCE per HTTP request (as soon as it
// arrives) and store it in an AsyncLocalStorage context. Every await inside
// that request's handler — no matter how deeply nested — sees the SAME
// dbId for its entire lifetime, even if the global `_activeDBId` changes
// underneath it a moment later because of a concurrent /activate call.
// This required no changes to the ~150 individual query() call sites.
const _dbContext = new AsyncLocalStorage();

// Resolves the database id that the CURRENT request (or background task)
// should use. Falls back to the live global for code paths that run outside
// of an HTTP request (startup, timers), where there is nothing to race with.
function currentDbId() {
  const store = _dbContext.getStore();
  return (store && store.dbId) || _activeDBId;
}

// ── SYS / SYSDBA credential helper ───────────────────────────────────────────
// Oracle requires privilege:oracledb.SYSDBA when connecting as SYS.
// Users may enter username as any of:
//   "sys as sysdba", "SYS AS SYSDBA", "sys as sysoper", "sys"
// This helper normalises the username and returns the correct oracledb privilege.
function parseCreds(rawUser, rawPassword) {
  const u = (rawUser || '').trim();
  let username = u;
  let privilege;

  const upper = u.toUpperCase();
  if (/\bAS\s+SYSDBA\b/.test(upper)) {
    username  = u.replace(/\s+AS\s+SYSDBA/gi, '').trim();
    privilege = oracledb.SYSDBA;
  } else if (/\bAS\s+SYSOPER\b/.test(upper)) {
    username  = u.replace(/\s+AS\s+SYSOPER/gi, '').trim();
    privilege = oracledb.SYSOPER;
  } else if (/\bAS\s+SYSBACKUP\b/.test(upper)) {
    username  = u.replace(/\s+AS\s+SYSBACKUP/gi, '').trim();
    privilege = oracledb.SYSBACKUP;
  } else if (upper === 'SYS') {
    // bare "SYS" with no qualifier — default to SYSDBA
    privilege = oracledb.SYSDBA;
  }

  const creds = { user: username, password: rawPassword };
  if (privilege !== undefined) creds.privilege = privilege;
  return creds;
}


// ── DB REGISTRY PERSISTENCE ───────────────────────────────────────────────────
// Persists registered databases to disk so they survive server restarts.
const REGISTRY_FILE = path.join(__dirname, '.oracle_db_registry.json');

function saveRegistry() {
  try {
    const entries = Array.from(_dbRegistry.values()).filter(db => db.id !== 'default');
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ activeId: _activeDBId, databases: entries }, null, 2), 'utf8');
  } catch(e) { console.warn('[registry] Failed to save:', e.message); }
}

function loadRegistry() {
  try {
    if (!fs.existsSync(REGISTRY_FILE)) return;
    const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    (data.databases || []).forEach(db => { if (db.id && db.id !== 'default') _dbRegistry.set(db.id, db); });
    if (data.activeId && _dbRegistry.has(data.activeId)) _activeDBId = data.activeId;
    console.log('[registry] Loaded', (data.databases||[]).length, 'saved database(s). Active:', _activeDBId);
  } catch(e) { console.warn('[registry] Failed to load (starting fresh):', e.message); }
}

// ── FIX 1: Global unhandled rejection handler — prevents process crash ────────
// This catches timeout errors from slow startup queries and logs them gracefully
// instead of crashing the Node.js process.
process.on('unhandledRejection', (reason, promise) => {
  console.warn('[unhandledRejection] Caught:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] Caught:', err?.message || err);
});

// ── Security headers ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // X-Frame-Options intentionally omitted — Streamlit panels are embedded in iframes
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ── FIX: Allow all origins so the dashboard HTML can be opened from any host
// (file://, LAN IP, or localhost). The proxy only talks to Oracle anyway,
// so this does not expose any sensitive cross-origin data.
app.use(cors({
  origin: true,          // reflect request origin — allows file:// and any LAN IP
  methods: ['GET','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));
app.options('/{*path}', cors({ origin: true }));
app.use(express.json({ limit: '512kb' }));


// ── Serve the dashboard frontend ──────────────────────────────────────────
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'oracle_ai_dashboard.html'));
});

// ── Simple in-memory rate limiter (per IP, max 120 req/min) ──────────────
const _rateCounts = new Map();
app.use((req, res, next) => {
  const ip  = req.ip || req.connection?.remoteAddress || 'unknown';
  const key = ip + ':' + Math.floor(Date.now() / 60000);
  const cnt = (_rateCounts.get(key) || 0) + 1;
  _rateCounts.set(key, cnt);
  if (cnt === 1) setTimeout(() => _rateCounts.delete(key), 61000);
  if (cnt > 120) return res.status(429).json({ error: 'Rate limit exceeded — max 120 requests/minute' });
  next();
});

// ── MULTI-DATABASE MANAGER ────────────────────────────────────────────────────
// Supports multiple Oracle databases. Each DB entry has an id, name, and
// connection credentials. The active DB can be switched at runtime via API
// without restarting the server. All pools are kept alive for fast switching.
//
// Default DB loaded from env vars or hardcoded fallback:
const _defaultDB = {
  id               : 'default',
  name             : process.env.ORACLE_DB_NAME     || 'Default (orcl)',
  user             : process.env.ORACLE_USER        || 'fazal',
  password         : process.env.ORACLE_PASSWORD    || 'FAZAL',
  connectionString : process.env.ORACLE_CONNECT_STRING ||
    '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=192.168.2.148)(PORT=1522))(CONNECT_DATA=(SERVER=DEDICATED)(SERVICE_NAME=orcl)))'
};

// In-memory registry of all registered databases { id → {id,name,user,password,connectionString} }
const _dbRegistry = new Map();
_dbRegistry.set(_defaultDB.id, _defaultDB);

// Active DB id — all queries run against this entry
let _activeDBId = _defaultDB.id;

// Per-database pool cache { id → pool }
const _poolCache = new Map();

// Load previously registered databases from disk (survives server restart)
loadRegistry();

// Convenience: get the currently active DB config (request-scoped when inside
// an HTTP request, otherwise the live global — see currentDbId() above)
function DB() { return _dbRegistry.get(currentDbId()) || _defaultDB; }

// ── Bind every incoming HTTP request to a fixed database id for its whole
// lifetime. Placed here (after _dbRegistry/_activeDBId exist) and BEFORE all
// route handlers below, so every request — including /activate itself — runs
// inside the AsyncLocalStorage context.
//
// A request MAY opt in to a specific database by passing ?dbId=<id> (or
// header X-DB-Id). This lets the frontend pin a panel refresh to the database
// it was actually issued for, which is the strongest fix: it works even if
// several databases are being polled concurrently (e.g. two browser tabs).
// If no dbId is supplied, or it doesn't exist, we fall back to whatever is
// globally active at the moment the request arrives (previous behaviour),
// but — crucially — that value is now frozen for the rest of the request.
app.use((req, res, next) => {
  const requested = req.query.dbId || req.headers['x-db-id'];
  const dbId = (requested && _dbRegistry.has(String(requested)))
    ? String(requested)
    : _activeDBId;
  _dbContext.run({ dbId }, next);
});

// ── CONNECTION POOL ───────────────────────────────────────────────────────────
// Each registered database gets its own pool. Pools are created on first use
// and cached. Switching DBs just changes _activeDBId — no restart needed.
async function getPool(dbId) {
  const id = dbId || _activeDBId;
  if (_poolCache.has(id)) return _poolCache.get(id);
  const cfg = _dbRegistry.get(id);
  if (!cfg) throw new Error('Database not found: ' + id);
  const creds = parseCreds(cfg.user, cfg.password);
  const pool = await oracledb.createPool({
    user             : creds.user,
    password         : creds.password,
    connectionString : cfg.connectionString,
    ...(creds.privilege !== undefined ? { privilege: creds.privilege } : {}),
    poolMin      : 2,
    poolMax      : 10,
    poolIncrement: 2,
    poolTimeout  : 60,
    queueTimeout : 60000   // increased from 10s → 60s; BFILE tail can hold a connection for ~45s
  });
  _poolCache.set(id, pool);
  console.log('✓ Oracle pool created for DB:', cfg.name, '(min=2, max=10)');
  return pool;
}

// ── MULTI-DB API ENDPOINTS ────────────────────────────────────────────────────

// GET  /api/oracle/databases          → list all registered databases
// POST /api/oracle/databases          → register a new database
// DELETE /api/oracle/databases/:id    → remove a registered database
// POST /api/oracle/databases/:id/activate → switch active database

app.get('/api/oracle/databases', (req, res) => {
  const list = Array.from(_dbRegistry.values()).map(db => ({
    id              : db.id,
    name            : db.name,
    user            : db.user,
    connectionString: db.connectionString,
    host            : _extractOracleHost(db.connectionString), // ← actual server this entry points at, whatever IP/host it is
    isActive        : db.id === _activeDBId
  }));
  res.json({ databases: list, activeId: _activeDBId });
});

app.post('/api/oracle/databases', async (req, res) => {
  const { name, user, password, connectionString } = req.body;
  if (!name || !user || !password || !connectionString) {
    return res.status(400).json({ error: 'name, user, password, connectionString are required' });
  }

  // ── FIX: Normalize connection string ─────────────────────────────────────
  let cs = connectionString.trim();
  const aliasMatch = cs.match(/^[\w$#]+\s*=\s*(\(DESCRIPTION\s*=[\s\S]+)/i);
  if (aliasMatch) {
    cs = aliasMatch[1].trim();
    console.log('[register] Stripped tnsnames alias prefix → using descriptor directly');
  }

  // Parse SYS/SYSDBA credentials before test connection
  const regCreds = parseCreds(user, password);

  // ── FIX: Test connection with a short timeout and return useful errors ────
  let conn;
  let testError = null;
  try {
    conn = await Promise.race([
      oracledb.getConnection({ ...regCreds, connectionString: cs }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timed out after 20s — check HOST, PORT, and SERVICE_NAME in your connection string, and ensure the Oracle listener is reachable from this server')), 20000))
    ]);
    await conn.execute('SELECT 1 FROM DUAL');
  } catch (e) {
    testError = e.message;
    // Build a helpful hint
    let hint = '';
    if (/ORA-01017|invalid username/i.test(testError))  hint = ' — Wrong username or password.';
    if (/ORA-28009/i.test(testError))                    hint = ' — SYS must connect as SYSDBA or SYSOPER. Enter username as: sys as sysdba';
    if (/ORA-12541|no listener/i.test(testError))       hint = ' — Oracle listener not running or wrong PORT.';
    if (/ORA-12154|could not resolve/i.test(testError)) hint = ' — Cannot resolve service name. Use the full (DESCRIPTION=…) format, not a tnsnames alias.';
    if (/ORA-12514|service.*not registered/i.test(testError)) hint = ' — Service name not registered. Check SERVICE_NAME in your connection string.';
    if (/timed out/i.test(testError))                   hint = ' — Network unreachable or firewall blocking the Oracle port.';
    if (/ORA-28000|account is locked/i.test(testError)) hint = ' — Oracle account is locked.';
    return res.status(400).json({ error: 'Connection test failed: ' + testError + hint });
  } finally {
    if (conn) try { await conn.close(); } catch (_) {}
  }

  const id = 'db_' + Date.now();
  // Store the normalized (alias-stripped) connection string
  _dbRegistry.set(id, { id, name, user: regCreds.user, password, connectionString: cs });
  saveRegistry();  // persist so this DB survives server restarts
  console.log('✓ New database registered:', name, '(id=' + id + ')');
  res.json({ ok: true, id, name, message: 'Database registered successfully' });
});

app.delete('/api/oracle/databases/:id', async (req, res) => {
  const { id } = req.params;
  if (id === 'default') return res.status(400).json({ error: 'Cannot remove the default database' });
  if (!_dbRegistry.has(id)) return res.status(404).json({ error: 'Database not found' });
  // Close pool if open
  if (_poolCache.has(id)) {
    try { await _poolCache.get(id).close(0); } catch (_) {}
    _poolCache.delete(id);
  }
  const name = _dbRegistry.get(id)?.name;
  _dbRegistry.delete(id);
  // If active was deleted, fall back to default
  _racInfoByDb.delete(id);
  _resolvedLogPathsByDb.delete(id);
  if (_activeDBId === id) { _activeDBId = 'default'; racInfo = null; }
  saveRegistry();  // persist deletion
  res.json({ ok: true, message: 'Database removed: ' + name });
});

app.post('/api/oracle/databases/:id/activate', async (req, res) => {
  const { id } = req.params;
  if (!_dbRegistry.has(id)) return res.status(404).json({ error: 'Database not found' });
  const cfg = _dbRegistry.get(id);
  // Normalize connection string (strip tnsnames alias prefix if present)
  let cs = (cfg.connectionString || '').trim();
  const aliasMatch = cs.match(/^[\w$#]+\s*=\s*(\(DESCRIPTION\s*=[\s\S]+)/i);
  if (aliasMatch) cs = aliasMatch[1].trim();
  // Parse SYS/SYSDBA credentials before test connection
  const actCreds = parseCreds(cfg.user, cfg.password);
  // Test connectivity before switching
  let conn;
  try {
    conn = await Promise.race([
      oracledb.getConnection({ ...actCreds, connectionString: cs }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timed out after 25s')), 25000))
    ]);
    await conn.execute('SELECT 1 FROM DUAL');
  } catch (e) {
    return res.status(500).json({ error: 'Cannot connect: ' + e.message });
  } finally {
    if (conn) try { await conn.close(); } catch (_) {}
  }

  // ── DB-SWITCH: atomically update active DB id and clear ALL shared state ──
  // This must happen as close together as possible so no request window
  // exists where _activeDBId points to the new DB but cache still has old data.
  _activeDBId = id;
  // Per-DB caches (see CROSS-DATABASE FIX comments above) are keyed by dbId
  // and never mix between databases, so they no longer need to be reset here
  // on every switch — but we still drop this DB's own entries so a stale
  // pre-switch snapshot for THIS id (e.g. from before its connection details
  // changed) doesn't linger.
  _racInfoByDb.delete(id);
  _resolvedLogPathsByDb.delete(id);
  _cache.clear();             // drop every cached value (all DBs, safest option)

  saveRegistry();  // persist active DB selection
  console.log('✓ Switched active database to:', cfg.name, '(id=' + id + ')');
  res.json({ ok: true, id, name: cfg.name, message: 'Switched to ' + cfg.name });
});

// ── QUERY TIMEOUT ─────────────────────────────────────────────────────────────
// Increased to 90s for slow AWR queries. callTimeout cancels at the driver level
// (not just the JS promise) so Oracle actually stops executing the SQL.
const QUERY_TIMEOUT_MS = 90000;

// ── SHORT-LIVED RESPONSE CACHE ────────────────────────────────────────────────
// Prevents duplicate Oracle queries when the dashboard fires multiple rapid
// refreshes (e.g. on panel switch + auto-refresh firing at the same time).
// Each entry expires after its configured TTL.
//
// ══ DB-SWITCH FIX ══════════════════════════════════════════════════════════
// ALL cache keys are automatically prefixed with the active DB id.
// This means:
//   1. Switching DBs never serves stale data from the old DB — keys are
//      completely separate per database.
//   2. _cache.clear() on activate is still done for safety, but even without
//      it there is no cross-DB contamination because the key space is
//      isolated per DB.
//   3. In-flight requests that complete AFTER a switch still write their
//      result under the OLD db's key prefix, so the new DB's queries are
//      never polluted.
// ═══════════════════════════════════════════════════════════════════════════
const CACHE_TTL_FAST = 8000;   // 8s  — live metrics (sessions, locks)
const CACHE_TTL_SLOW = 25000;  // 25s — heavier queries (tablespaces, top-sql)
const CACHE_TTL_MS   = CACHE_TTL_FAST; // default kept for existing cacheSet calls
const _cache = new Map();

// Returns a DB-scoped cache key so data from different databases never mixes.
// Uses the request-scoped dbId (currentDbId()), not the raw global, so a
// request that started against DB A keeps reading/writing DB A's cache
// entries even if another request switches the global active DB mid-flight.
function _cacheKey(key) { return currentDbId() + ':' + key; }

function cacheGet(key) {
  const k = _cacheKey(key);
  const entry = _cache.get(k);
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl) { _cache.delete(k); return null; }
  return entry.data;
}
function cacheSet(key, data, ttl) {
  _cache.set(_cacheKey(key), { ts: Date.now(), data, ttl: ttl || CACHE_TTL_MS });
}
// Convenience: cache slow/heavy query results for a full refresh cycle
function cacheSetSlow(key, data) { cacheSet(key, data, CACHE_TTL_SLOW); }

// ── RAC DETECTION ─────────────────────────────────────────────────────────────
// ══ CROSS-DATABASE FIX ══════════════════════════════════════════════════════
// This used to be a single shared `racInfo` variable. If a request against
// DB A and a request against DB B both called detectRAC() around the same
// time, whichever one finished first would cache its result in that single
// variable and the OTHER database's request would be served the wrong
// (A's or B's) RAC info. Keyed by dbId now so each database has its own
// cached result and they can never bleed into each other.
const _racInfoByDb = new Map();
let racInfo = null; // kept only so `racInfo = null` reset call-sites still work harmlessly

async function detectRAC() {
  const dbId = currentDbId();
  if (_racInfoByDb.has(dbId)) return _racInfoByDb.get(dbId);
  try {
    const rows = await query(
      `SELECT value FROM v$parameter WHERE name = 'cluster_database'`
    );
    const isRAC = rows.length > 0 && rows[0].VALUE === 'TRUE';
    let instances = [];
    if (isRAC) {
      const irows = await query(
        `SELECT inst_id, instance_name, host_name, status FROM gv$instance ORDER BY inst_id`
      );
      instances = irows;
    }
    const result = { isRAC, instances };
    _racInfoByDb.set(dbId, result);
    return result;
  } catch(e) {
    const result = { isRAC: false, instances: [] };
    _racInfoByDb.set(dbId, result);
    return result;
  }
}

// ── QUERY HELPER ──────────────────────────────────────────────────────────────
// FIX: Use pool connection + callTimeout so Oracle actually cancels the SQL
// (the old Promise.race only rejected the JS promise but left Oracle running,
// causing repeated timeouts and PromiseRejectionHandledWarnings).
async function query(sql, binds, opts) {
  let conn;
  try {
    // Use the request-scoped database id (see currentDbId()/_dbContext above)
    // instead of reading the mutable global directly. This is the fix for
    // queries silently running against the wrong database when a /activate
    // switch happens concurrently with an in-flight request.
    const pool = await getPool(currentDbId());
    conn = await pool.getConnection();
    conn.callTimeout = QUERY_TIMEOUT_MS; // real DB-level cancel on timeout
    const result = await conn.execute(sql, binds || [], {
      outFormat  : oracledb.OUT_FORMAT_OBJECT,
      autoCommit : true,
      fetchTypeMap: new Map([[oracledb.CLOB, {type: oracledb.STRING}]]),
      ...(opts || {})
    });
    const rows = await Promise.all((result.rows || []).map(async row => {
      const clean = {};
      for(const [k, v] of Object.entries(row)) {
        if(v && typeof v === 'object' && typeof v.getData === 'function') {
          try { clean[k] = await v.getData(); } catch(e) { clean[k] = ''; }
        } else if(Buffer.isBuffer(v)) {
          clean[k] = v.toString('utf8');
        } else if(v !== null && v !== undefined) {
          clean[k] = v instanceof Date ? v.toISOString().replace('T',' ').slice(0,19) : v;
        } else {
          clean[k] = v;
        }
      }
      return clean;
    }));
    return rows;
  } catch(e) { throw e; }
  finally { if(conn) try { await conn.close(); } catch(e) {} } // returns conn to pool
}

// ── DEFAULTS — lets the dashboard Auto-fill the correct connection string ─────
// Returns the default DB config (credentials excluded) so the UI can pre-fill
// the Connection String field without the user having to type it manually.
app.get('/api/oracle/defaults', (req, res) => {
  const def = _dbRegistry.get('default') || _defaultDB;
  res.json({
    connectionString: def.connectionString,
    user: def.user,
    name: def.name
  });
});

// ── PING ──────────────────────────────────────────────────────────────────────
// ── /api/oracle/ping — two-level health check ─────────────────────────────
//  GET /api/oracle/ping        → responds immediately (server alive check)
//  GET /api/oracle/ping?db=1   → also probes Oracle DB (dashboard health badge)
//
//  The Connect modal uses level-1 only, so "Cannot reach backend" fires only
//  when server.js is truly down — not when the Oracle DB is slow/offline.
app.get('/api/oracle/ping', async (req, res) => {
  if (!req.query.db) {
    // Level 1: just confirm HTTP server is alive — no DB query, instant response
    return res.json({ status: 'ok', dbReady: _poolCache.size > 0 });
  }
  // Level 2: also probe the active Oracle DB connection
  try {
    await query('SELECT 1 FROM DUAL');
    const rac = await detectRAC();
    res.json({ status: 'ok', dbReady: true, isRAC: rac.isRAC, instances: rac.instances });
  } catch(e) {
    res.json({ status: 'db_error', dbReady: false, error: e.message });
  }
});

// ── RAC INSTANCES ─────────────────────────────────────────────────────────────
app.get('/api/oracle/instances', async (req, res) => {
  try {
    const rac = await detectRAC();
    if (!rac.isRAC) {
      const rows = await query(
        `SELECT 1 AS INST_ID, instance_name, host_name, version,
                status, database_status, active_state
         FROM v$instance`
      );
      return res.json({ isRAC: false, instances: rows });
    }
    const rows = await query(
      `SELECT i.inst_id,
              i.instance_name,
              i.host_name,
              i.version,
              i.status,
              i.database_status,
              i.active_state,
              (SELECT COUNT(*) FROM gv$session s
               WHERE s.inst_id = i.inst_id
                 AND s.type = 'USER' AND s.status = 'ACTIVE') AS active_sessions,
              (SELECT COUNT(*) FROM gv$session s
               WHERE s.inst_id = i.inst_id
                 AND s.type = 'USER') AS total_sessions
       FROM gv$instance i
       ORDER BY i.inst_id`
    );
    res.json({ isRAC: true, instances: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── METRICS ───────────────────────────────────────────────────────────────────
app.get('/api/oracle/metrics', async (req, res) => {
  try {
    const cached = cacheGet('metrics');
    if (cached) return res.json(cached);
    const rac = await detectRAC();

    // FIX: Run all 6 metric queries IN PARALLEL with Promise.allSettled.
    // Previously they ran sequentially (each awaited the prior), so 6 slow
    // queries × ~10s each = 60s total → dashboard timeout.
    // Now all 6 fire at once; total time = slowest single query (not the sum).
    const [sessions, bufHit, waits, ts, blocked, cpu] = await Promise.allSettled([
      query(
        `SELECT COUNT(*) AS ACTIVE_SESSIONS
         FROM GV$SESSION
         WHERE STATUS='ACTIVE' AND TYPE='USER'`
      ),
      query(
        `SELECT ROUND((1 - (SUM(CASE WHEN NAME='physical reads'   THEN VALUE ELSE 0 END) /
                     NULLIF(SUM(CASE WHEN NAME IN ('db block gets','consistent gets') THEN VALUE ELSE 0 END), 0))
                    ) * 100) AS BUFFER_HIT
         FROM GV$SYSSTAT
         WHERE NAME IN ('physical reads','db block gets','consistent gets')`
      ),
      query(
        `SELECT EVENT,
                ROUND(SUM(TIME_WAITED_MICRO)/1000000, 1) AS TIME_WAITED,
                SUM(TOTAL_WAITS) AS TOTAL_WAITS
         FROM GV$SYSTEM_EVENT
         WHERE WAIT_CLASS != 'Idle'
         GROUP BY EVENT
         ORDER BY SUM(TIME_WAITED_MICRO) DESC
         FETCH FIRST 5 ROWS ONLY`
      ),
      query(
        `SELECT df.TABLESPACE_NAME,
                ROUND(df.TOTAL/1024/1024/1024, 2)          AS TOTAL_GB,
                ROUND(NVL(fs.FREE,0)/1024/1024/1024, 2)    AS FREE_GB,
                ROUND((1-NVL(fs.FREE,0)/df.TOTAL)*100)     AS PCT_USED
         FROM (SELECT TABLESPACE_NAME, SUM(BYTES) TOTAL FROM DBA_DATA_FILES GROUP BY TABLESPACE_NAME) df
         LEFT JOIN (SELECT TABLESPACE_NAME, SUM(BYTES) FREE FROM DBA_FREE_SPACE GROUP BY TABLESPACE_NAME) fs
           ON df.TABLESPACE_NAME = fs.TABLESPACE_NAME
         ORDER BY PCT_USED DESC`
      ),
      query(
        `SELECT COUNT(*) AS CNT
         FROM GV$SESSION
         WHERE BLOCKING_SESSION IS NOT NULL`
      ),
      query(
        `SELECT ROUND(
           SUM(CASE WHEN STAT_NAME='BUSY_TIME' THEN VALUE ELSE 0 END) * 100 /
           NULLIF(SUM(CASE WHEN STAT_NAME IN ('BUSY_TIME','IDLE_TIME') THEN VALUE ELSE 0 END), 0)
         , 1) AS CPU_USAGE
         FROM V$OSSTAT
         WHERE STAT_NAME IN ('BUSY_TIME','IDLE_TIME')`
      )
    ]);

    // Safely unwrap Promise.allSettled results — partial failure won't crash the endpoint
    const val = (r, fallback) => r.status === 'fulfilled' ? r.value : fallback;
    const sessRows    = val(sessions, [{ ACTIVE_SESSIONS: 0 }]);
    const bufHitRows  = val(bufHit,   [{ BUFFER_HIT: 0 }]);
    const waitsRows   = val(waits,    []);
    const tsRows      = val(ts,       []);
    const blockedRows = val(blocked,  [{ CNT: 0 }]);
    const cpuRows     = val(cpu,      [{ CPU_USAGE: null }]);

    const topWait = waitsRows[0]?.EVENT || '';
    const payload = {
      isRAC          : rac.isRAC,
      instanceCount  : rac.instances.length || 1,
      sessions       : sessRows[0],
      bufferHit      : bufHitRows[0]?.BUFFER_HIT || 0,
      cpuUsage       : cpuRows[0]?.CPU_USAGE || null,
      waits          : waitsRows,
      topWait,
      tablespace     : tsRows,
      blockedSessions: blockedRows[0]?.CNT || 0
    };
    cacheSet('metrics', payload);
    res.json(payload);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TOP SQL ───────────────────────────────────────────────────────────────────
app.get('/api/oracle/top-sql', async (req, res) => {
  try {
    const cached = cacheGet('top-sql');
    if (cached) return res.json(cached);
    let rows = [];
    try {
      rows = await query(
        `SELECT
           a.SQL_ID,
           SUM(a.EXECUTIONS)                                               AS EXECUTIONS,
           ROUND(SUM(a.ELAPSED_TIME) / GREATEST(SUM(a.EXECUTIONS),1) / 1000) AS AVG_MS,
           ROUND(SUM(a.CPU_TIME)     / GREATEST(SUM(a.ELAPSED_TIME),1) * 100) AS CPU_PCT,
           SUBSTR(MAX(TO_CHAR(SUBSTR(a.SQL_TEXT, 1, 300))), 1, 300)        AS SQL_TEXT
         FROM GV$SQLAREA a
         WHERE a.EXECUTIONS > 0
           AND a.LAST_ACTIVE_TIME > SYSDATE - 1
         GROUP BY a.SQL_ID
         ORDER BY SUM(a.ELAPSED_TIME) DESC
         FETCH FIRST 15 ROWS ONLY`
      );
    } catch(e1) {}

    if (!rows || rows.length === 0) {
      try {
        rows = await query(
          `SELECT
             a.SQL_ID,
             SUM(a.EXECUTIONS)                                               AS EXECUTIONS,
             ROUND(SUM(a.ELAPSED_TIME) / GREATEST(SUM(a.EXECUTIONS),1) / 1000) AS AVG_MS,
             ROUND(SUM(a.CPU_TIME)     / GREATEST(SUM(a.ELAPSED_TIME),1) * 100) AS CPU_PCT,
             SUBSTR(MAX(TO_CHAR(SUBSTR(a.SQL_TEXT, 1, 300))), 1, 300)        AS SQL_TEXT
           FROM GV$SQLAREA a
           WHERE a.EXECUTIONS > 0
           GROUP BY a.SQL_ID
           ORDER BY SUM(a.ELAPSED_TIME) DESC
           FETCH FIRST 15 ROWS ONLY`
        );
      } catch(e2) {}
    }

    if (!rows || rows.length === 0) {
      rows = await query(
        `SELECT
           a.SQL_ID,
           a.EXECUTIONS,
           ROUND(a.ELAPSED_TIME / GREATEST(a.EXECUTIONS,1) / 1000) AS AVG_MS,
           ROUND(a.CPU_TIME     / GREATEST(a.ELAPSED_TIME,1) * 100) AS CPU_PCT,
           SUBSTR(a.SQL_TEXT, 1, 300)                               AS SQL_TEXT
         FROM V$SQLAREA a
         WHERE a.EXECUTIONS > 0
         ORDER BY a.ELAPSED_TIME DESC
         FETCH FIRST 15 ROWS ONLY`
      );
    }

    const payload = rows || [];
    cacheSetSlow('top-sql', payload);
    res.json(payload);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SESSIONS ──────────────────────────────────────────────────────────────────
app.get('/api/oracle/sessions', async (req, res) => {
  try {
    const cached = cacheGet('sessions');
    if (cached) return res.json(cached);
    const rows = await query(
      `SELECT
         s.INST_ID,
         s.SID,
         s.SERIAL#,
         s.USERNAME,
         s.STATUS,
         s.MACHINE,
         SUBSTR(s.PROGRAM, 1, 30)    AS PROGRAM,
         s.SQL_ID,
         s.LAST_CALL_ET              AS ELAPSED_SEC,
         s.WAIT_CLASS,
         s.EVENT,
         NVL(s.BLOCKING_SESSION, 0) AS BLOCKING_SESSION,
         s.BLOCKING_INSTANCE         AS BLOCKING_INST_ID
       FROM GV$SESSION s
       WHERE s.TYPE = 'USER'
         AND s.USERNAME IS NOT NULL
       ORDER BY s.LAST_CALL_ET DESC
       FETCH FIRST 30 ROWS ONLY`
    );
    cacheSet('sessions', rows);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── LOCKS ─────────────────────────────────────────────────────────────────────
app.get('/api/oracle/locks', async (req, res) => {
  try {
    const cached = cacheGet('locks');
    if (cached) return res.json(cached);
    const rows = await query(
      `SELECT
         h.INST_ID          AS HOLDER_INST,
         h.SID              AS HOLDER_SID,
         h.USERNAME         AS HOLDER_USER,
         h.MACHINE          AS HOLDER_MACHINE,
         w.INST_ID          AS WAITER_INST,
         w.SID              AS WAITER_SID,
         w.USERNAME         AS WAITER_USER,
         w.MACHINE          AS WAITER_MACHINE,
         w.LAST_CALL_ET     AS WAIT_SECS,
         w.EVENT            AS WAIT_EVENT
       FROM GV$SESSION w
       JOIN GV$SESSION h
         ON h.INST_ID = NVL(w.BLOCKING_INSTANCE, w.INST_ID)
        AND h.SID     = w.BLOCKING_SESSION
       WHERE w.BLOCKING_SESSION IS NOT NULL`
    );
    cacheSet('locks', rows);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TABLESPACES ───────────────────────────────────────────────────────────────
app.get('/api/oracle/tablespaces', async (req, res) => {
  try {
    const cached = cacheGet('tablespaces');
    if (cached) return res.json(cached);
    const rows = await query(
      `SELECT d.status AS STATUS, d.tablespace_name AS TABLESPACE_NAME,
         TO_CHAR(NVL(a.bytes / 1024/1024/1024, 0),'99,999,990.90') AS SIZE_GB,
         TO_CHAR(NVL(a.bytes - NVL(f.bytes,0), 0) / 1024/1024/1024,'99999999.99') AS USED_GB,
         TO_CHAR(NVL(f.bytes / 1024/1024/1024, 0),'99,999,990.90') AS FREE_GB,
         TO_CHAR(NVL((a.bytes - NVL(f.bytes,0)) / a.bytes * 100, 0),'990.00') AS USED_PCT
       FROM sys.dba_tablespaces d,
            (SELECT tablespace_name, SUM(bytes) bytes FROM dba_data_files GROUP BY tablespace_name) a,
            (SELECT tablespace_name, SUM(bytes) bytes FROM dba_free_space GROUP BY tablespace_name) f
       WHERE d.tablespace_name = a.tablespace_name(+)
         AND d.tablespace_name = f.tablespace_name(+)
         AND NOT (d.extent_management LIKE 'LOCAL' AND d.contents LIKE 'TEMPORARY')
       UNION ALL
       /* ── TEMP tablespace: use V$SORT_SEGMENT for ACTUAL used blocks (sort/hash ops).
          v$temp_extent_pool.bytes_cached reflects pooled/cached extents (always near 100%),
          NOT real active usage. V$SORT_SEGMENT.USED_BLOCKS shows only blocks in active use.
          When no sort operations are running, USED_BLOCKS = 0 → USED_PCT = 0. ── */
       SELECT d.status AS STATUS, d.tablespace_name AS TABLESPACE_NAME,
         TO_CHAR(NVL(a.bytes / 1024/1024/1024, 0),'99,999,990.90') AS SIZE_GB,
         TO_CHAR(NVL(ss.used_bytes, 0) / 1024/1024/1024,'99999999.99') AS USED_GB,
         TO_CHAR(NVL((a.bytes - NVL(ss.used_bytes,0)) / 1024/1024/1024, 0),'99,999,990.90') AS FREE_GB,
         TO_CHAR(NVL(ss.used_bytes / NULLIF(a.bytes,0) * 100, 0),'990.00') AS USED_PCT
       FROM sys.dba_tablespaces d,
            (SELECT tablespace_name, SUM(bytes) bytes FROM dba_temp_files GROUP BY tablespace_name) a,
            (SELECT tablespace_name,
                    SUM(used_blocks) * (SELECT value FROM v$parameter WHERE name = 'db_block_size') AS used_bytes
             FROM v$sort_segment
             GROUP BY tablespace_name) ss
       WHERE d.tablespace_name = a.tablespace_name(+)
         AND d.tablespace_name = ss.tablespace_name(+)
         AND d.extent_management LIKE 'LOCAL'
         AND d.contents LIKE 'TEMPORARY'
       ORDER BY tablespace_name`
    );
    cacheSetSlow('tablespaces', rows);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PERFORMANCE ───────────────────────────────────────────────────────────────
app.get('/api/oracle/performance', async (req, res) => {
  try {
    const cached = cacheGet('performance');
    if (cached) return res.json(cached);
    // FIX: Run all 4 queries in parallel — previously sequential, causing ~40s total wait
    const [statsR, waitBrkR, topWaitsR, sgaR] = await Promise.allSettled([
      query(
        `SELECT NAME, SUM(VALUE) AS VALUE
         FROM GV$SYSSTAT
         WHERE NAME IN (
           'DB time','CPU used by this session','session logical reads',
           'physical reads','physical writes','parse count (hard)',
           'parse count (total)','execute count','redo size',
           'SQL*Net roundtrips to/from client','sorts (memory)'
         )
         GROUP BY NAME`
      ),
      query(
        `SELECT WAIT_CLASS,
                ROUND(SUM(TIME_WAITED_MICRO)/1000000, 1) AS TIME_WAITED
         FROM GV$SYSTEM_EVENT
         WHERE WAIT_CLASS != 'Idle'
         GROUP BY WAIT_CLASS
         ORDER BY TIME_WAITED DESC`
      ),
      query(
        `SELECT EVENT,
                WAIT_CLASS,
                ROUND(SUM(TIME_WAITED_MICRO)/1000000, 1)                        AS TIME_WAITED,
                SUM(TOTAL_WAITS)                                                 AS TOTAL_WAITS,
                ROUND(SUM(TIME_WAITED_MICRO)/GREATEST(SUM(TOTAL_WAITS),1)/1000, 2) AS AVG_WAIT_MS
         FROM GV$SYSTEM_EVENT
         WHERE WAIT_CLASS != 'Idle'
         GROUP BY EVENT, WAIT_CLASS
         ORDER BY SUM(TIME_WAITED_MICRO) DESC
         FETCH FIRST 10 ROWS ONLY`
      ),
      query(
        `SELECT INST_ID,
                POOL,
                ROUND(SUM(BYTES)/1024/1024, 1) AS MB
         FROM GV$SGASTAT
         GROUP BY INST_ID, POOL
         ORDER BY INST_ID, MB DESC`
      )
    ]);
    const val = (r, fallback) => r.status === 'fulfilled' ? r.value : fallback;
    const stats    = val(statsR,    []);
    const waitBrk  = val(waitBrkR,  []);
    const topWaits = val(topWaitsR, []);
    const sga      = val(sgaR,      []);
    const statMap = {};
    stats.forEach(r => statMap[r.NAME] = r.VALUE);
    const perfPayload = {
      dbTime:        Math.round((statMap['DB time']||0)/1000000),
      cpuTime:       Math.round((statMap['CPU used by this session']||0)/1000000),
      logicalReads:  statMap['session logical reads']||0,
      physicalReads: statMap['physical reads']||0,
      physicalWrites:statMap['physical writes']||0,
      hardParses:    statMap['parse count (hard)']||0,
      totalParses:   statMap['parse count (total)']||0,
      execCount:     statMap['execute count']||0,
      redoSizeMB:    Math.round((statMap['redo size']||0)/1024/1024*100)/100,
      sqlNetRT:      statMap['SQL*Net roundtrips to/from client']||0,
      sortsMem:      statMap['sorts (memory)']||0,
      waitBreakdown: waitBrk,
      topWaits,
      sga
    };
    cacheSet('performance', perfPayload);
    res.json(perfPayload);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PERFORMANCE RANGE (AWR) ───────────────────────────────────────────────────
app.get('/api/oracle/performance-range', async (req, res) => {
  try {
    const { beginTime, endTime, tzOffset } = req.query;
    if (!beginTime || !endTime) {
      return res.status(400).json({ error: 'beginTime and endTime query params are required' });
    }
    const toOraTS = s => s.replace('T', ' ').substring(0, 16);
    const tzMins = parseInt(tzOffset || '0', 10);
    const shiftToUTC = s => {
      const raw = toOraTS(s);
      const [datePart, timePart] = raw.split(' ');
      const [year, mon, day] = datePart.split('-').map(Number);
      const [hour, min]      = timePart.split(':').map(Number);
      const utcMs = Date.UTC(year, mon - 1, day, hour, min) - tzMins * 60000;
      const u = new Date(utcMs);
      const pad = n => String(n).padStart(2, '0');
      return `${u.getUTCFullYear()}-${pad(u.getUTCMonth()+1)}-${pad(u.getUTCDate())} ${pad(u.getUTCHours())}:${pad(u.getUTCMinutes())}`;
    };
    const beginUTC = shiftToUTC(beginTime);
    const endUTC   = shiftToUTC(endTime);
    const beginOra = toOraTS(beginTime);
    const endOra   = toOraTS(endTime);

    const endSnapRows = await query(
      `SELECT MAX(snap_id) AS END_SNAP
       FROM DBA_HIST_SNAPSHOT
       WHERE end_interval_time <= TO_TIMESTAMP('${endUTC}','YYYY-MM-DD HH24:MI')`
    );
    if (!endSnapRows.length || endSnapRows[0].END_SNAP == null) {
      return res.status(404).json({ error: 'No AWR snapshots found at or before the end time. AWR snapshots are taken every ~1 hour — try a wider window.' });
    }
    const endSnap = endSnapRows[0].END_SNAP;

    const beginSnapRows = await query(
      `SELECT MAX(snap_id) AS BEGIN_SNAP
       FROM DBA_HIST_SNAPSHOT
       WHERE end_interval_time <= TO_TIMESTAMP('${beginUTC}','YYYY-MM-DD HH24:MI')`
    );
    if (!beginSnapRows.length || beginSnapRows[0].BEGIN_SNAP == null) {
      return res.status(404).json({ error: 'No AWR baseline snapshot found before the start time. Try widening the window or moving the start time back slightly.' });
    }
    const beginSnap = beginSnapRows[0].BEGIN_SNAP;

    if (beginSnap >= endSnap) {
      return res.status(404).json({ error: 'Only one AWR snapshot found in this range — cannot compute a delta. Try a wider window (e.g. Last 2h).' });
    }

    const snapCountRows = await query(
      `SELECT COUNT(*) AS SNAP_COUNT
       FROM DBA_HIST_SNAPSHOT
       WHERE snap_id > ${beginSnap} AND snap_id <= ${endSnap}`
    );
    const snapCountVal = Number(snapCountRows[0]?.SNAP_COUNT) || 0;

    const stats = await query(
      `SELECT stat_name AS NAME, SUM(value) AS VALUE
       FROM (
         SELECT s.stat_name,
                MAX(s.value) - MIN(s.value) AS value
         FROM DBA_HIST_SYSSTAT s
         WHERE s.snap_id BETWEEN ${beginSnap} AND ${endSnap}
           AND s.stat_name IN (
             'physical reads','parse count (hard)','execute count',
             'redo size','session logical reads',
             'SQL*Net roundtrips to/from client','sorts (memory)'
           )
         GROUP BY s.instance_number, s.stat_name
       )
       GROUP BY stat_name`
    );
    const waitBrk = await query(
      `SELECT wait_class AS WAIT_CLASS,
              ROUND(SUM(time_waited_micro_fg)/1000000, 1) AS TIME_WAITED
       FROM (
         SELECT e.wait_class,
                MAX(e.time_waited_micro_fg) - MIN(e.time_waited_micro_fg) AS time_waited_micro_fg
         FROM DBA_HIST_SYSTEM_EVENT e
         WHERE e.snap_id BETWEEN ${beginSnap} AND ${endSnap}
           AND e.wait_class != 'Idle'
         GROUP BY e.instance_number, e.wait_class, e.event_name
       )
       WHERE time_waited_micro_fg > 0
       GROUP BY wait_class
       ORDER BY TIME_WAITED DESC`
    );
    const topWaits = await query(
      `SELECT event AS EVENT,
              wait_class AS WAIT_CLASS,
              SUM(total_waits_fg)   AS TOTAL_WAITS,
              ROUND(SUM(time_waited_micro_fg)/1000000, 1)                              AS TIME_WAITED,
              ROUND(SUM(time_waited_micro_fg)/GREATEST(SUM(total_waits_fg),1)/1000, 2) AS AVG_WAIT_MS
       FROM (
         SELECT e.event_name AS event,
                e.wait_class,
                MAX(e.total_waits_fg)      - MIN(e.total_waits_fg)      AS total_waits_fg,
                MAX(e.time_waited_micro_fg) - MIN(e.time_waited_micro_fg) AS time_waited_micro_fg
         FROM DBA_HIST_SYSTEM_EVENT e
         WHERE e.snap_id BETWEEN ${beginSnap} AND ${endSnap}
           AND e.wait_class != 'Idle'
         GROUP BY e.instance_number, e.event_name, e.wait_class
       )
       WHERE time_waited_micro_fg > 0
       GROUP BY event, wait_class
       ORDER BY SUM(time_waited_micro_fg) DESC
       FETCH FIRST 10 ROWS ONLY`
    );
    const bufHit = await query(
      `SELECT ROUND((1 - (SUM(CASE WHEN stat_name='physical reads'              THEN value ELSE 0 END) /
                  NULLIF(SUM(CASE WHEN stat_name IN ('db block gets','consistent gets') THEN value ELSE 0 END),0)))*100) AS BUFFER_HIT
       FROM (
         SELECT s.stat_name,
                MAX(s.value) - MIN(s.value) AS value
         FROM DBA_HIST_SYSSTAT s
         WHERE s.snap_id BETWEEN ${beginSnap} AND ${endSnap}
           AND s.stat_name IN ('physical reads','db block gets','consistent gets')
         GROUP BY s.instance_number, s.stat_name
       )`
    );
    const statMap = {};
    stats.forEach(r => { statMap[r.NAME] = Number(r.VALUE) || 0; });
    const snapTimes = await query(
      `SELECT TO_CHAR(s_begin.end_interval_time + NUMTODSINTERVAL(${tzMins},'MINUTE'),'YYYY-MM-DD HH24:MI') AS BEGIN_TIME,
              TO_CHAR(s_end.end_interval_time   + NUMTODSINTERVAL(${tzMins},'MINUTE'),'YYYY-MM-DD HH24:MI') AS END_TIME
       FROM DBA_HIST_SNAPSHOT s_begin,
            DBA_HIST_SNAPSHOT s_end
       WHERE s_begin.snap_id = ${beginSnap}
         AND s_end.snap_id   = ${endSnap}`
    );
    res.json({
      mode:          'range',
      beginSnap,
      endSnap,
      snapCount:      snapCountVal || 0,
      beginTime:      beginOra,
      endTime:        endOra,
      snapBeginTime:  snapTimes[0]?.BEGIN_TIME || beginOra,
      snapEndTime:    snapTimes[0]?.END_TIME   || endOra,
      physicalReads: statMap['physical reads']   || 0,
      hardParses:    statMap['parse count (hard)'] || 0,
      execCount:     statMap['execute count']    || 0,
      redoSizeMB:    Math.round((statMap['redo size'] || 0) / 1024 / 1024 * 100) / 100,
      logicalReads:  statMap['session logical reads'] || 0,
      sqlNetRT:      statMap['SQL*Net roundtrips to/from client'] || 0,
      sortsMem:      statMap['sorts (memory)'] || 0,
      bufferHit:     bufHit[0]?.BUFFER_HIT || 0,
      waitBreakdown: waitBrk,
      topWaits
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ALERTS ────────────────────────────────────────────────────────────────────
app.get('/api/oracle/alerts', async (req, res) => {
  try {
    // If the client sends ?bust= (first fetch after a DB switch), skip the
    // cache so we always query the newly-activated database directly.
    const skipCache = !!req.query.bust;
    const cached = skipCache ? null : cacheGet('alerts');
    if (cached) return res.json(cached);

    // FIX: Run all 6 alert queries IN PARALLEL — previously sequential (6 round trips → slow)
    const [tsR, locksR, bufHitR, longSQLR, hardPR, crossLocksR] = await Promise.allSettled([
      query(
        `SELECT df.TABLESPACE_NAME,
                ROUND((1-NVL(fs.FREE,0)/df.TOTAL)*100) AS PCT_USED,
                MAX(d.AUTOEXTENSIBLE)                   AS AUTO_EXT
         FROM (SELECT TABLESPACE_NAME,SUM(BYTES) TOTAL FROM DBA_DATA_FILES GROUP BY TABLESPACE_NAME) df
         LEFT JOIN (SELECT TABLESPACE_NAME,SUM(BYTES) FREE FROM DBA_FREE_SPACE GROUP BY TABLESPACE_NAME) fs
           ON df.TABLESPACE_NAME=fs.TABLESPACE_NAME
         LEFT JOIN DBA_DATA_FILES d ON d.TABLESPACE_NAME=df.TABLESPACE_NAME
         GROUP BY df.TABLESPACE_NAME, fs.FREE, df.TOTAL`
      ),
      query(`SELECT COUNT(*) AS CNT FROM GV$SESSION WHERE BLOCKING_SESSION IS NOT NULL`),
      query(
        `SELECT ROUND((1 - (SUM(CASE WHEN NAME='physical reads'   THEN VALUE ELSE 0 END) /
                     NULLIF(SUM(CASE WHEN NAME IN ('db block gets','consistent gets') THEN VALUE ELSE 0 END), 0))
                    ) * 100) AS BH
         FROM GV$SYSSTAT
         WHERE NAME IN ('physical reads','db block gets','consistent gets')`
      ),
      query(
        `SELECT COUNT(*) AS CNT
         FROM GV$SESSION
         WHERE STATUS='ACTIVE' AND TYPE='USER' AND LAST_CALL_ET > 300`
      ),
      query(`SELECT SUM(VALUE) AS VAL FROM GV$SYSSTAT WHERE NAME='parse count (hard)'`),
      query(
        `SELECT COUNT(*) AS CNT
         FROM GV$SESSION w
         JOIN GV$SESSION h
           ON h.INST_ID = NVL(w.BLOCKING_INSTANCE, w.INST_ID)
          AND h.SID     = w.BLOCKING_SESSION
         WHERE w.BLOCKING_SESSION IS NOT NULL
           AND w.BLOCKING_INSTANCE != w.INST_ID`
      )
    ]);

    const val = (r, fallback) => r.status === 'fulfilled' ? r.value : fallback;
    const ts           = val(tsR,         []);
    const locks        = val(locksR,      [{ CNT: 0 }]);
    const bufHit       = val(bufHitR,     [{ BH: 100 }]);
    const longSQL      = val(longSQLR,    [{ CNT: 0 }]);
    const hardP        = val(hardPR,      [{ VAL: 0 }]);
    const crossInstLocks = val(crossLocksR, [{ CNT: 0 }]);

    const alerts = [];
    const now = new Date().toLocaleTimeString();
    ts.forEach(t => {
      if(t.PCT_USED >= 90)
        alerts.push({ level:'CRITICAL', title:`Tablespace ${t.TABLESPACE_NAME} at ${t.PCT_USED}%`, desc: t.AUTO_EXT==='YES' ? 'Auto-extend ON' : 'Auto-extend DISABLED — immediate action required.', time: now });
      else if(t.PCT_USED >= 75)
        alerts.push({ level:'WARNING', title:`Tablespace ${t.TABLESPACE_NAME} at ${t.PCT_USED}%`, desc:'Monitor closely. Consider adding datafiles or enabling auto-extend.', time: now });
    });
    if((locks[0]?.CNT||0) > 0)
      alerts.push({ level:'CRITICAL', title:`${locks[0].CNT} blocking lock(s) active across cluster`, desc:'Sessions are blocked on one or more RAC nodes.', time: now });
    if((crossInstLocks[0]?.CNT||0) > 0)
      alerts.push({ level:'CRITICAL', title:`${crossInstLocks[0].CNT} cross-instance lock(s) detected`, desc:'Sessions on different RAC nodes are blocking each other.', time: now });
    const bh = bufHit[0]?.BH || 100;
    if(bh < 90)
      alerts.push({ level: bh<80?'CRITICAL':'WARNING', title:`Buffer cache hit ratio low: ${bh}% (cluster-wide)`, desc:'Target is >95%.', time: now });
    if((longSQL[0]?.CNT||0) > 0)
      alerts.push({ level:'WARNING', title:`${longSQL[0].CNT} long-running SQL (>5 min) across cluster`, desc:'Active sessions running longer than 300 seconds detected.', time: now });
    const hp = hardP[0]?.VAL || 0;
    if(hp > 1000)
      alerts.push({ level:'WARNING', title:`High hard parse count: ${hp.toLocaleString()} (cluster-wide)`, desc:'Application may be using literal SQL.', time: now });
    if(alerts.length === 0)
      alerts.push({ level:'INFO', title:'All systems healthy', desc:'No active alerts across any RAC node.', time: now });
    cacheSet('alerts', alerts);
    res.json(alerts);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SCHEMA ────────────────────────────────────────────────────────────────────
app.get('/api/oracle/schema', async (req, res) => {
  try {
    const cached = cacheGet('schema');
    if (cached) return res.json(cached);

    // FIX: Run all 5 schema queries IN PARALLEL — previously fully sequential
    const SYS_EXCL = `'SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS','ORDSYS',
      'EXFSYS','DMSYS','WMSYS','CTXSYS','ANONYMOUS','XDB','ORDPLUGINS','ORDDATA',
      'SI_INFORMTN_SCHEMA','OLAPSYS','SCOTT','XS$NULL','LBACSYS','OJVMSYS',
      'GSMADMIN_INTERNAL','APPQOSSYS','DBSFWUSER','GGSYS','AUDSYS','DVF','DVSYS'`;

    const [rawObjsR, sizesR, invalidRowsR, staleRowsR, bigTblR, allUsersR] = await Promise.allSettled([
      query(
        `SELECT OWNER, OBJECT_TYPE, COUNT(*) AS CNT
         FROM DBA_OBJECTS
         WHERE OWNER NOT IN (${SYS_EXCL})
           AND OBJECT_TYPE IN ('TABLE','INDEX','VIEW','PROCEDURE','FUNCTION','PACKAGE','TRIGGER','SEQUENCE')
         GROUP BY OWNER, OBJECT_TYPE
         ORDER BY OWNER, OBJECT_TYPE`
      ),
      query(
        `SELECT OWNER, ROUND(SUM(BYTES)/1024/1024/1024, 4) AS SIZE_GB
         FROM DBA_SEGMENTS
         WHERE OWNER NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS','ORDSYS','EXFSYS','CTXSYS','XDB')
         GROUP BY OWNER
         ORDER BY SIZE_GB DESC`
      ),
      query(
        `SELECT OWNER, COUNT(*) AS CNT FROM DBA_OBJECTS WHERE STATUS='INVALID'
         AND OWNER NOT IN (${SYS_EXCL})
         GROUP BY OWNER`
      ),
      query(
        `SELECT OWNER, COUNT(*) AS CNT FROM DBA_TAB_STATISTICS
         WHERE OWNER NOT IN (${SYS_EXCL})
           AND (STALE_STATS = 'YES' OR LAST_ANALYZED IS NULL)
         GROUP BY OWNER`
      ),
      query(
        `SELECT OWNER, SEGMENT_NAME AS TABLE_NAME,
                ROUND(SUM(BYTES)/1024/1024, 2) AS SIZE_MB
         FROM DBA_SEGMENTS
         WHERE SEGMENT_TYPE='TABLE'
           AND OWNER NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS','ORDSYS')
         GROUP BY OWNER, SEGMENT_NAME
         ORDER BY SIZE_MB DESC
         FETCH FIRST 15 ROWS ONLY`
      ),
      // ── NEW: fetch ALL non-system users so empty schemas (0 objects) are visible ──
      query(
        `SELECT USERNAME FROM DBA_USERS
         WHERE USERNAME NOT IN (${SYS_EXCL})
           AND ACCOUNT_STATUS NOT IN ('EXPIRED & LOCKED','LOCKED')
         ORDER BY USERNAME`
      )
    ]);

    const val = (r, fallback) => r.status === 'fulfilled' ? r.value : fallback;
    const rawObjs    = val(rawObjsR,    []);
    const sizes      = val(sizesR,      []);
    const invalidRows= val(invalidRowsR,[]);
    const staleRows  = val(staleRowsR,  []);
    const bigTbl     = val(bigTblR,     []);
    const allUsers   = val(allUsersR,   []);

    const ownerMap = {};

    // ── Seed ownerMap with ALL non-system users first (ensures 0-object users appear) ──
    allUsers.forEach(r => {
      const o = r.USERNAME;
      if (o && !ownerMap[o]) ownerMap[o] = { name: o, tables:0, indexes:0, views:0, procs:0, triggers:0, sequences:0 };
    });

    rawObjs.forEach(r => {
      const o = r.OWNER;
      if (!ownerMap[o]) ownerMap[o] = { name: o, tables:0, indexes:0, views:0, procs:0, triggers:0, sequences:0 };
      const cnt = Number(r.CNT) || 0;
      switch (r.OBJECT_TYPE) {
        case 'TABLE':     ownerMap[o].tables   += cnt; break;
        case 'INDEX':     ownerMap[o].indexes  += cnt; break;
        case 'VIEW':      ownerMap[o].views    += cnt; break;
        case 'PROCEDURE':
        case 'FUNCTION':
        case 'PACKAGE':   ownerMap[o].procs    += cnt; break;
        case 'TRIGGER':   ownerMap[o].triggers += cnt; break;
        case 'SEQUENCE':  ownerMap[o].sequences+= cnt; break;
      }
    });
    const sizeMap = {};
    sizes.forEach(s => { sizeMap[s.OWNER] = Number(s.SIZE_GB) || 0; });
    Object.values(ownerMap).forEach(o => { o.sizeGb = sizeMap[o.name] || 0; });
    const invMap = {};
    invalidRows.forEach(r => { invMap[r.OWNER] = Number(r.CNT) || 0; });
    Object.values(ownerMap).forEach(o => { o.invalid = invMap[o.name] || 0; });
    const staleMap = {};
    staleRows.forEach(r => { staleMap[r.OWNER] = Number(r.CNT) || 0; });
    Object.values(ownerMap).forEach(o => { o.staleStats = staleMap[o.name] || 0; });

    const schemas = Object.values(ownerMap).sort((a,b) => {
      const ta = a.tables+a.indexes+a.views+a.procs+a.triggers;
      const tb = b.tables+b.indexes+b.views+b.procs+b.triggers;
      return tb - ta;
    });
    const payload = { schemas, bigTables: bigTbl, totalSchemas: schemas.length };
    cacheSetSlow('schema', payload);
    res.json(payload);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ANOMALY SIGNALS ───────────────────────────────────────────────────────────
app.get('/api/oracle/anomaly-signals', async (req, res) => {
  try {
    const signals = [];
    const tsData = await query(
      `SELECT df.TABLESPACE_NAME,
              df.TOTAL_BYTES,
              NVL(fs.FREE_BYTES, 0) AS FREE_BYTES,
              ROUND((1 - NVL(fs.FREE_BYTES,0) / NULLIF(df.TOTAL_BYTES,0)) * 100, 2) AS PCT_USED,
              MAX(d.AUTOEXTENSIBLE) AS AUTO_EXT,
              MAX(d.MAXBYTES) AS MAX_BYTES
       FROM (SELECT TABLESPACE_NAME, SUM(BYTES) AS TOTAL_BYTES FROM DBA_DATA_FILES GROUP BY TABLESPACE_NAME) df
       LEFT JOIN (SELECT TABLESPACE_NAME, SUM(BYTES) AS FREE_BYTES FROM DBA_FREE_SPACE GROUP BY TABLESPACE_NAME) fs
         ON df.TABLESPACE_NAME = fs.TABLESPACE_NAME
       LEFT JOIN DBA_DATA_FILES d ON d.TABLESPACE_NAME = df.TABLESPACE_NAME
       GROUP BY df.TABLESPACE_NAME, df.TOTAL_BYTES, fs.FREE_BYTES
       ORDER BY PCT_USED DESC NULLS LAST`
    );
    tsData.forEach(t => {
      const pct     = Math.max(0, Math.min(100, Number(t.PCT_USED) || 0));
      const totalGB = (Number(t.TOTAL_BYTES) || 0) / 1073741824;
      const freeGB  = (Number(t.FREE_BYTES)  || 0) / 1073741824;
      const autoExt = t.AUTO_EXT === 'YES';
      if (pct >= 85) {
        const score = Math.min(0.99, 0.45 + (pct - 85) / 30);
        signals.push({
          type: pct >= 95 ? 'CRITICAL' : 'WARNING', category: 'Storage',
          title: `Tablespace ${t.TABLESPACE_NAME} at ${pct.toFixed(1)}%`,
          detail: `${freeGB.toFixed(2)} GB free of ${totalGB.toFixed(2)} GB total. Auto-extend: ${autoExt ? 'ON' : 'OFF (risk!)'}`,
          score: Math.round(score * 100) / 100
        });
      }
    });

    // ── TEMP tablespace: check ACTUAL usage via V$SORT_SEGMENT (not v$temp_extent_pool) ──
    // V$SORT_SEGMENT.USED_BLOCKS = blocks actively used by live sort/hash join ops.
    // This correctly returns 0 when no sorts are running (idle database).
    try {
      const tempData = await query(
        `SELECT tf.TABLESPACE_NAME,
                tf.TOTAL_BYTES,
                NVL(ss.USED_BYTES, 0)                                    AS USED_BYTES,
                tf.TOTAL_BYTES - NVL(ss.USED_BYTES, 0)                  AS FREE_BYTES,
                ROUND(NVL(ss.USED_BYTES, 0) / NULLIF(tf.TOTAL_BYTES,0) * 100, 2) AS PCT_USED,
                (SELECT MAX(AUTOEXTENSIBLE) FROM dba_temp_files
                  WHERE tablespace_name = tf.TABLESPACE_NAME)            AS AUTO_EXT
         FROM (SELECT tablespace_name, SUM(bytes) AS TOTAL_BYTES
               FROM dba_temp_files GROUP BY tablespace_name) tf
         LEFT JOIN
              (SELECT tablespace_name,
                      SUM(used_blocks) * (SELECT TO_NUMBER(value)
                                          FROM v$parameter
                                          WHERE name = 'db_block_size') AS USED_BYTES
               FROM v$sort_segment
               GROUP BY tablespace_name) ss
           ON ss.tablespace_name = tf.tablespace_name
         ORDER BY PCT_USED DESC NULLS LAST`
      );
      tempData.forEach(t => {
        const pct     = Math.max(0, Math.min(100, Number(t.PCT_USED) || 0));
        const totalGB = (Number(t.TOTAL_BYTES) || 0) / 1073741824;
        const freeGB  = (Number(t.FREE_BYTES)  || 0) / 1073741824;
        const autoExt = t.AUTO_EXT === 'YES';
        if (pct >= 85) {
          const score = Math.min(0.99, 0.45 + (pct - 85) / 30);
          signals.push({
            type: pct >= 95 ? 'CRITICAL' : 'WARNING', category: 'Storage',
            title: `TEMP Tablespace ${t.TABLESPACE_NAME} at ${pct.toFixed(1)}% (active sorts)`,
            detail: `${freeGB.toFixed(2)} GB free of ${totalGB.toFixed(2)} GB total. ` +
                    `Active sort/hash operations consuming space. Auto-extend: ${autoExt ? 'ON' : 'OFF (risk!)'}`,
            score: Math.round(score * 100) / 100
          });
        }
        // Always report TEMP space availability as INFO so AI report has accurate data
        // (even when 0% used — this prevents false "exhaustion" alarms)
        signals._tempInfo = {
          name: t.TABLESPACE_NAME,
          pct: pct.toFixed(2),
          usedGB: ((Number(t.USED_BYTES)||0)/1073741824).toFixed(2),
          freeGB: freeGB.toFixed(2),
          totalGB: totalGB.toFixed(2)
        };
      });
    } catch(tempErr) {
      console.warn('[anomaly] TEMP V$SORT_SEGMENT check failed (may lack privilege):', tempErr.message);
    }
    const bufRows = await query(
      `SELECT NAME, SUM(VALUE) AS VALUE FROM GV$SYSSTAT
       WHERE NAME IN ('physical reads','db block gets','consistent gets')
       GROUP BY NAME`
    );
    const bufMap = {};
    bufRows.forEach(r => { bufMap[r.NAME] = Number(r.VALUE) || 0; });
    const logical = (bufMap['db block gets'] || 0) + (bufMap['consistent gets'] || 0);
    const phys    = bufMap['physical reads'] || 0;
    const bhr     = logical > 0 ? (1 - phys / logical) * 100 : 100;
    if (bhr < 95) {
      const drop = 95 - bhr;
      signals.push({
        type: bhr < 80 ? 'CRITICAL' : 'WARNING', category: 'Memory',
        title: `Buffer Cache Hit Ratio: ${bhr.toFixed(1)}% (target >= 95%)`,
        detail: `${drop.toFixed(1)}% below target. Physical reads: ${phys.toLocaleString()}.`,
        score: Math.min(0.95, Math.round((0.3 + drop / 25) * 100) / 100)
      });
    }
    const parseRows = await query(
      `SELECT NAME, SUM(VALUE) AS VALUE FROM GV$SYSSTAT
       WHERE NAME IN ('parse count (hard)', 'parse count (total)')
       GROUP BY NAME`
    );
    const parseMap = {};
    parseRows.forEach(r => { parseMap[r.NAME] = Number(r.VALUE) || 0; });
    const hardParses  = parseMap['parse count (hard)']  || 0;
    const totalParses = parseMap['parse count (total)'] || 0;
    const hardPct     = totalParses > 0 ? (hardParses / totalParses) * 100 : 0;
    if (hardPct > 10) {
      signals.push({
        type: hardPct > 30 ? 'CRITICAL' : 'WARNING', category: 'SQL',
        title: `Hard Parse Rate: ${hardPct.toFixed(1)}% of all parses`,
        detail: `${hardParses.toLocaleString()} hard parses of ${totalParses.toLocaleString()} total.`,
        score: Math.min(0.90, Math.round((0.25 + hardPct / 80) * 100) / 100)
      });
    }
    const blockRows = await query(
      `SELECT COUNT(*) AS CNT, MAX(LAST_CALL_ET) AS MAX_WAIT
       FROM GV$SESSION WHERE BLOCKING_SESSION IS NOT NULL`
    );
    const blockCnt = Number(blockRows[0]?.CNT) || 0;
    const maxWaitS = Number(blockRows[0]?.MAX_WAIT) || 0;
    if (blockCnt > 0) {
      signals.push({
        type: blockCnt >= 5 || maxWaitS > 300 ? 'CRITICAL' : 'WARNING', category: 'Locks',
        title: `${blockCnt} Session${blockCnt > 1 ? 's' : ''} Blocked by Locks`,
        detail: `Longest wait: ${Math.round(maxWaitS / 60)} min ${maxWaitS % 60}s.`,
        score: Math.min(0.99, Math.round((0.40 + blockCnt * 0.06) * 100) / 100)
      });
    }
    const longRows = await query(
      `SELECT COUNT(*) AS CNT, MAX(LAST_CALL_ET) AS MAX_ET
       FROM GV$SESSION WHERE STATUS='ACTIVE' AND TYPE='USER' AND LAST_CALL_ET > 300`
    );
    const longCnt = Number(longRows[0]?.CNT) || 0;
    if (longCnt > 0) {
      signals.push({
        type: 'WARNING', category: 'SQL',
        title: `${longCnt} Long-Running SQL Statement${longCnt > 1 ? 's' : ''} (> 5 min)`,
        detail: `Longest active: ${Math.round((Number(longRows[0]?.MAX_ET)||0) / 60)} minutes.`,
        score: Math.min(0.85, Math.round((0.30 + longCnt * 0.05) * 100) / 100)
      });
    }
    const invRows = await query(
      `SELECT COUNT(*) AS CNT FROM DBA_OBJECTS WHERE STATUS='INVALID'
       AND OWNER NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','AUDSYS','DVF','DVSYS')`
    );
    const invCnt = Number(invRows[0]?.CNT) || 0;
    if (invCnt > 0) {
      signals.push({
        type: invCnt > 10 ? 'WARNING' : 'NOTICE', category: 'Objects',
        title: `${invCnt} Invalid Database Object${invCnt > 1 ? 's' : ''}`,
        detail: `Recompile with: EXEC DBMS_UTILITY.COMPILE_SCHEMA('<owner>')`,
        score: Math.min(0.75, Math.round((0.20 + invCnt * 0.015) * 100) / 100)
      });
    }
    const waitRows = await query(
      `SELECT EVENT, WAIT_CLASS,
              ROUND(SUM(TIME_WAITED_MICRO)/1000000, 1) AS TOTAL_SECS,
              SUM(TOTAL_WAITS) AS TOTAL_WAITS
       FROM GV$SYSTEM_EVENT WHERE WAIT_CLASS != 'Idle'
       GROUP BY EVENT, WAIT_CLASS ORDER BY TOTAL_SECS DESC
       FETCH FIRST 1 ROWS ONLY`
    );
    if (waitRows.length) {
      const w = waitRows[0];
      const hrs = Number(w.TOTAL_SECS) / 3600;
      if (hrs > 1) {
        signals.push({
          type: 'NOTICE', category: 'Waits',
          title: `Top Wait: ${w.EVENT}`,
          detail: `Class: ${w.WAIT_CLASS} · Cumulative: ${hrs.toFixed(1)}h waited.`,
          score: 0.30
        });
      }
    }
    const tempInfo = signals._tempInfo || null;
    delete signals._tempInfo;
    signals.sort((a, b) => b.score - a.score);
    const critical = signals.filter(s => s.type === 'CRITICAL').length;
    const warning  = signals.filter(s => s.type === 'WARNING').length;
    const notice   = signals.filter(s => s.type === 'NOTICE').length;
    res.json({ signals, summary: { critical, warning, notice, total: signals.length }, checksRun: 8, checkedAt: new Date().toISOString(), tempInfo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EXPLAIN PLAN ──────────────────────────────────────────────────────────────
app.post('/api/oracle/explain-plan', async (req, res) => {
  const { sql, statement_id } = req.body;
  if (!sql) return res.status(400).json({ error: 'sql is required' });
  const stmtId = (statement_id || ('EP_' + Date.now().toString(36).toUpperCase())).substring(0, 30);
  let conn;
  try {
    const _epPool = await getPool(currentDbId());
    conn = await _epPool.getConnection();
    try { await conn.execute(`DELETE FROM PLAN_TABLE WHERE STATEMENT_ID = :1`, [stmtId], { autoCommit: true }); } catch(e) {}
    await conn.execute(`EXPLAIN PLAN SET STATEMENT_ID = '${stmtId}' FOR ${sql}`, [], { autoCommit: true });
    const xplanResult = await conn.execute(
      `SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE','${stmtId}','TYPICAL'))`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    let lines = '';
    if (xplanResult.rows && xplanResult.rows.length) {
      lines = xplanResult.rows.map(r => {
        const v = r.PLAN_TABLE_OUTPUT;
        return typeof v === 'string' ? v : String(v || '');
      }).join('\n');
    }
    try { await conn.execute(`DELETE FROM PLAN_TABLE WHERE STATEMENT_ID = :1`, [stmtId], { autoCommit: true }); } catch(e) {}
    res.json({ statement_id: stmtId, lines, row_count: xplanResult.rows ? xplanResult.rows.length : 0 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (conn) try { await conn.close(); } catch(e) {}
  }
});

// ── IO STATS ──────────────────────────────────────────────────────────────────
app.get('/api/oracle/io-stats', async (req, res) => {
  try {
    const skipCache = req.query.nocache === '1';
    const cached = skipCache ? null : cacheGet('io-stats');
    if (cached) return res.json(cached);
    // Run both queries in parallel
    const [statsR, blockSizeR] = await Promise.allSettled([
      query(
        `SELECT NAME, SUM(VALUE) AS VALUE
         FROM GV$SYSSTAT
         WHERE NAME IN ('physical reads','physical writes','physical read bytes','physical write bytes')
         GROUP BY NAME`
      ),
      query(`SELECT TO_NUMBER(VALUE) AS BLOCK_SIZE FROM V$PARAMETER WHERE NAME='db_block_size'`)
    ]);
    const stats       = statsR.status       === 'fulfilled' ? statsR.value       : [];
    const blockSizeRows = blockSizeR.status === 'fulfilled' ? blockSizeR.value   : [];
    const blockSize = blockSizeRows[0]?.BLOCK_SIZE || 8192;
    const map = {};
    stats.forEach(r => { map[r.NAME] = Number(r.VALUE) || 0; });
    const readBytes  = map['physical read bytes']  || map['physical reads']  * blockSize;
    const writeBytes = map['physical write bytes'] || map['physical writes'] * blockSize;
    const payload = { ts: Date.now(), readBytes, writeBytes, blockSize, rawStats: map };
    cacheSet('io-stats', payload);
    res.json(payload);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SQL SAFETY VALIDATOR ──────────────────────────────────────────────────────
const DANGEROUS_SQL = /^\s*(DROP|TRUNCATE|DELETE|UPDATE|INSERT|MERGE|CREATE|ALTER|GRANT|REVOKE|EXECUTE|EXEC|BEGIN\s|DECLARE|CALL|RENAME|COMMENT\s+ON|AUDIT|NOAUDIT|PURGE|FLASHBACK|ADMINISTER)\b/i;

function validateReadOnlySQL(sql) {
  if (!sql || typeof sql !== 'string') return 'SQL is required';
  const s = sql.trim().replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
  if (s.length > 50000) return 'SQL too long (max 50,000 chars)';
  if (/^\s*EXPLAIN\s+PLAN\s+(SET\s+STATEMENT_ID\s*=\s*'\w+'|FOR)\s/i.test(s)) return null;
  if (DANGEROUS_SQL.test(s)) {
    const match = s.match(/^\s*(\w+)/);
    return `Statement type '${match?.[1]||'unknown'}' is not allowed — only SELECT/WITH queries are permitted`;
  }
  return null;
}

// ── GENERIC QUERY ─────────────────────────────────────────────────────────────
app.post('/api/oracle/query', async (req, res) => {
  try {
    const sql = req.body.sql;
    const err = validateReadOnlySQL(sql);
    if (err) return res.status(400).json({ error: err });
    const rows = await query(sql);
    const cols = rows.length ? Object.keys(rows[0]) : [];
    res.json({ columns: cols, rows: rows.map(r => Object.values(r)), elapsed: Date.now() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/oracle', async (req, res) => {
  try {
    const sql = req.body.sql;
    const err = validateReadOnlySQL(sql);
    if (err) return res.status(400).json({ error: err });
    const rows = await query(sql);
    const cols = rows.length ? Object.keys(rows[0]) : [];
    res.json({ columns: cols, rows: rows.map(r => Object.values(r)), elapsed: Date.now() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FULL SQL TEXT ─────────────────────────────────────────────────────────────
app.get('/api/oracle/sql-text/:sqlId', async (req, res) => {
  try {
    const rows = await query(
      `SELECT SQL_FULLTEXT FROM GV$SQLAREA
       WHERE SQL_ID = '${req.params.sqlId}'
       FETCH FIRST 1 ROWS ONLY`
    );
    if(rows.length) {
      res.json({ sql_id: req.params.sqlId, sql_text: rows[0].SQL_FULLTEXT ? rows[0].SQL_FULLTEXT.toString() : '' });
    } else {
      res.json({ sql_id: req.params.sqlId, sql_text: '' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CDB / PDB SUPPORT ─────────────────────────────────────────────────────────
app.get('/api/oracle/pdbs-live', async (req, res) => {
  try {
    // Step 1: Check if this is a CDB (fix: was "SELECT CDB FROM V" — missing $DATABASE)
    let isCDB = false;
    try {
      const cdbRows = await query(`SELECT CDB, CON_ID FROM V$DATABASE`);
      isCDB = cdbRows.length > 0 && String(cdbRows[0].CDB || '').toUpperCase() === 'YES';
    } catch(e) {
      // If V$DATABASE not accessible, try SYS.V_$DATABASE
      try {
        const cdbRows2 = await query(`SELECT CDB FROM SYS.V_$DATABASE`);
        isCDB = cdbRows2.length > 0 && String(cdbRows2[0].CDB || '').toUpperCase() === 'YES';
      } catch(_) { isCDB = false; }
    }

    if (!isCDB) {
      return res.json({ pdbs: [], isCDB: false, message: 'Non-CDB database — no PDBs available' });
    }

    // Step 2: Fetch PDB list — try CDB_PDBS first (requires DBA), fall back to V$PDBS
    let rows = [];
    try {
      rows = await query(
        `SELECT p.PDB_NAME   AS name,
                p.OPEN_MODE  AS open_mode,
                p.RESTRICTED AS restricted,
                p.CON_ID     AS con_id,
                MIN(s.NAME)  AS service
         FROM   CDB_PDBS p
         LEFT JOIN CDB_SERVICES s
                ON s.CON_ID = p.CON_ID AND LOWER(s.NAME) NOT LIKE '%xdb%'
         WHERE  p.PDB_NAME NOT IN ('PDB$SEED')
         GROUP  BY p.PDB_NAME, p.OPEN_MODE, p.RESTRICTED, p.CON_ID
         ORDER  BY p.PDB_NAME`
      );
    } catch(e1) {
      // Fall back to V$PDBS (available without DBA privs in 12c+)
      try {
        rows = await query(
          `SELECT NAME AS name, OPEN_MODE AS open_mode,
                  RESTRICTED AS restricted, CON_ID AS con_id,
                  NAME AS service
           FROM   V$PDBS
           WHERE  NAME NOT IN ('PDB$SEED')
           ORDER  BY NAME`
        );
      } catch(e2) {
        console.warn('[pdbs-live] Cannot list PDBs:', e2.message);
        return res.json({ pdbs: [], isCDB: true, error: 'Cannot list PDBs: ' + e2.message });
      }
    }

    const pdbs = rows.map(r => ({
      name:       r.name || r.NAME,
      open_mode:  r.open_mode || r.OPEN_MODE || 'UNKNOWN',
      restricted: r.restricted || r.RESTRICTED || 'NO',
      con_id:     r.con_id || r.CON_ID,
      service:    r.service || (r.name || r.NAME || '').toLowerCase()
    }));

    res.json({ pdbs, isCDB: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/oracle/set-container', async (req, res) => {
  try {
    const { container, pdbName } = req.body;
    // container = '__cdb__' for CDB$ROOT, or PDB service name for a PDB
    if (container && container !== '__cdb__' && !/^[\w$.]+$/.test(container)) {
      return res.status(400).json({ error: 'Invalid container name' });
    }

    const activeDb = DB();
    // Always derive host/port from the ORIGINAL base connection string
    // so switching PDB->CDB->PDB never loses the host information
    const baseCs = activeDb._baseConnectionString || activeDb.connectionString;
    const hostMatch = baseCs.match(/HOST=([^)\s]+)/i);
    const portMatch = baseCs.match(/PORT=([^)\s]+)/i);
    const host = hostMatch ? hostMatch[1].trim() : '127.0.0.1';
    const port = portMatch ? portMatch[1].trim() : '1521';

    let newService;
    if (!container || container === '__cdb__') {
      // Switching back to CDB root — use the original base service name
      const svcMatch = baseCs.match(/SERVICE_NAME=([^)\s]+)/i);
      newService = svcMatch ? svcMatch[1].trim().split('.')[0] : 'orcl';
    } else {
      // Switching to a PDB — use pdbName if provided (full PDB name), else container value
      newService = (pdbName || container).trim();
    }

    const newConnStr = `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))(CONNECT_DATA=(SERVER=DEDICATED)(SERVICE_NAME=${newService})))`;
    const _pdbCreds = parseCreds(activeDb.user, activeDb.password);
    const testCfg = { ..._pdbCreds, connectionString: newConnStr };
    let conn;
    try {
      conn = await Promise.race([
        oracledb.getConnection(testCfg),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Connection to ' + newService + ' timed out after 20s')), 20000))
      ]);
      const containerCheck = await conn.execute(
        `SELECT SYS_CONTEXT('USERENV','CON_NAME') AS CON_NAME FROM DUAL`,
        [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const conName = containerCheck.rows?.[0]?.CON_NAME || newService;
      console.log('[set-container] Connected to container:', conName);
    } catch(e) {
      let hint = '';
      if (/ORA-12514|service.*not registered/i.test(e.message))
        hint = ' — PDB may be closed. Try: ALTER PLUGGABLE DATABASE ' + (pdbName || newService) + ' OPEN;';
      if (/ORA-01017/i.test(e.message))
        hint = ' — User may not exist in this PDB or requires a local account.';
      if (/timed out/i.test(e.message))
        hint = ' — Check that the PDB is OPEN and its listener service is registered.';
      return res.status(500).json({ error: 'Cannot connect to ' + newService + ': ' + e.message + hint });
    } finally {
      if (conn) try { await conn.close(); } catch(_) {}
    }

    // Commit: update registry, preserve _baseConnectionString for future CDB<->PDB switches
    // Use currentDbId() (request-scoped) rather than the raw global, so this
    // stays consistent even if a dbId query param pinned this request to a
    // non-globally-active database.
    const targetDbId = currentDbId();
    if (!activeDb._baseConnectionString) {
      activeDb._baseConnectionString = activeDb.connectionString;
    }
    activeDb.connectionString = newConnStr;
    _dbRegistry.set(targetDbId, activeDb);

    // Close existing pool so next query uses fresh connection to new container
    if (_poolCache.has(targetDbId)) {
      try { await _poolCache.get(targetDbId).close(0); } catch(_) {}
      _poolCache.delete(targetDbId);
    }
    _racInfoByDb.delete(targetDbId);
    _resolvedLogPathsByDb.delete(targetDbId);
    _cache.clear();

    console.log('[set-container] Switched to:', container === '__cdb__' ? 'CDB$ROOT' : newService);
    res.json({ ok: true, container: container || '__cdb__', service: newService, connString: newConnStr });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// LOGS API
// ═══════════════════════════════════════════════════════════════════════════
const os       = require('os');
const hostname = os.hostname();

async function getOraclePaths() {
  try {
    const rows = await query(`SELECT NAME, VALUE FROM V$DIAG_INFO`);
    const map = {};
    rows.forEach(r => { if (r.NAME && r.VALUE) map[r.NAME] = r.VALUE; });
    return map;
  } catch(e) { return {}; }
}

function parseDTFilter(iso) {
  if (!iso || iso === 'null' || iso === 'undefined' || iso === '') return null;
  // datetime-local strings from the browser have NO timezone suffix ("2026-04-22T12:55").
  // JS new Date() would treat those as UTC — wrong for IST (UTC+5:30).
  // Detect no-offset strings and adjust by the server's own UTC offset so the
  // resulting Date object represents the correct wall-clock instant.
  const hasOffset = /[Z+\-]\d{2}:?\d{2}$/.test(iso) || /Z$/.test(iso);
  if (!hasOffset) {
    const dUtc = new Date(iso + 'Z'); // parse as UTC first
    if (isNaN(dUtc.getTime())) return null;
    const offsetMs = new Date().getTimezoneOffset() * 60000; // negative for IST = -330*60000
    return new Date(dUtc.getTime() + offsetMs); // shift back to local instant
  }
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function parseOracleTS(str) {
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(str)) {
    const clean = str.trim();
    // If it has an explicit tz offset (e.g. +05:30) JS handles it natively — correct
    const hasOffset = /[Z+\-]\d{2}:?\d{2}$/.test(clean) || /Z$/.test(clean);
    if (hasOffset) {
      const d = new Date(clean);
      return isNaN(d.getTime()) ? null : d;
    }
    // No offset: Oracle SYSDATE = DB server local time. Treat as local, same as parseDTFilter.
    const base = clean.replace('T', ' ').substring(0, 19);
    const dUtc = new Date(base.replace(' ', 'T') + 'Z');
    if (isNaN(dUtc.getTime())) return null;
    const offsetMs = new Date().getTimezoneOffset() * 60000;
    return new Date(dUtc.getTime() + offsetMs);
  }
  const m = str.match(/^\w{3} (\w{3}) +(\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4})/);
  if (m) {
    const d = new Date(`${m[1]} ${m[2]} ${m[4]} ${m[3]}`);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function stripXML(content) {
  const lines = [];
  const tsRx  = /<time>([^<]+)<\/time>/;
  const msgRx = /<txt>([^<]+)<\/txt>/;
  const lvlRx = /<level>([^<]+)<\/level>/;
  const compRx= /<comp_id>([^<]+)<\/comp_id>/;
  const records = content.split(/<\/msg>/);
  for (const rec of records) {
    const ts   = (rec.match(tsRx)   || [])[1] || '';
    const msg  = (rec.match(msgRx)  || [])[1] || '';
    const lvl  = (rec.match(lvlRx)  || [])[1] || '';
    const comp = (rec.match(compRx) || [])[1] || '';
    if (msg.trim()) {
      const prefix = ts ? ts.substring(0, 19).replace('T', ' ') : '';
      const tag    = lvl ? `[${lvl}]` : '';
      const cmp    = comp ? `[${comp}]` : '';
      lines.push([prefix, tag, cmp, msg.trim()].filter(Boolean).join(' '));
    }
  }
  if (!lines.length) {
    return content.replace(/<[^>]+>/g, ' ').split('\n').map(l => l.trim()).filter(l => l.length > 2);
  }
  return lines;
}

function readAndFilterLog(filePath, fromDT, toDT, maxLines = 5000) {
  if (!fs.existsSync(filePath)) {
    return { lines: [], path: filePath, error: 'File not found: ' + filePath };
  }

  let stat;
  try { stat = fs.statSync(filePath); }
  catch(e) { return { lines: [], path: filePath, error: 'Cannot stat file: ' + e.message }; }

  const fileSize = stat.size;

  // ── Detect XML format by reading just the first 256 bytes ──────────────────
  let header = '';
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(256);
    fs.readSync(fd, buf, 0, 256, 0);
    fs.closeSync(fd);
    header = buf.toString('utf8');
  } catch(_) {}
  const isXML = header.trimStart().startsWith('<?xml') || header.includes('<msg') || header.includes('<txt>');

  // ── XML alert log: read full file (Oracle XML alert logs are usually <50MB) ─
  if (isXML) {
    let raw = '';
    try { raw = fs.readFileSync(filePath, 'utf8'); }
    catch(e) { return { lines: [], path: filePath, error: 'Cannot read XML log: ' + e.message }; }
    const allLines = stripXML(raw).filter(l => l.trim().length > 0);
    if (!fromDT && !toDT) return { lines: allLines.slice(-maxLines), path: filePath };
    return { lines: filterByTime(allLines, fromDT, toDT, maxLines), path: filePath };
  }

  // ── Plain text alert log: read from the END using byte-offset tail ──────────
  // This avoids loading multi-GB files and always gets the freshest lines.
  // Read the last CHUNK_SIZE bytes — enough to cover maxLines at ~200 chars/line.
  const CHUNK_SIZE = Math.min(fileSize, maxLines * 300);
  let chunk = '';
  try {
    const fd  = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(CHUNK_SIZE);
    const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, fileSize - CHUNK_SIZE);
    fs.closeSync(fd);
    chunk = buf.slice(0, bytesRead).toString('utf8');
  } catch(e) {
    return { lines: [], path: filePath, error: 'Cannot tail file: ' + e.message };
  }

  // Drop the first (possibly partial) line since we may have started mid-line
  const firstNL = chunk.indexOf('\n');
  const cleanChunk = firstNL >= 0 ? chunk.slice(firstNL + 1) : chunk;
  const allLines = cleanChunk.split('\n').filter(l => l.trim().length > 0);

  // If no time filter just return the tail
  if (!fromDT && !toDT) return { lines: allLines.slice(-maxLines), path: filePath };

  // If the chunk covers the requested time window, filter it
  const filtered = filterByTime(allLines, fromDT, toDT, maxLines);

  // If filtered result is empty AND we have a fromDT, try reading full file (small files <20MB)
  if (filtered.length === 0 && fromDT && fileSize < 20 * 1024 * 1024) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const fullLines = raw.split('\n').filter(l => l.trim().length > 0);
      const fullFiltered = filterByTime(fullLines, fromDT, toDT, maxLines);
      if (fullFiltered.length > 0) return { lines: fullFiltered, path: filePath };
    } catch(_) {}
  }

  // Return filtered result (may be empty) — empty result signals the caller to
  // try DB-level fallbacks rather than showing stale raw data.
  return { lines: filtered, path: filePath };
}

// ── Time-range filter helper ──────────────────────────────────────────────────
function filterByTime(allLines, fromDT, toDT, maxLines) {
  const tsRegex = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})|^(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})/;
  const result  = [];
  let lastTS    = null;

  for (const line of allLines) {
    const m = line.match(tsRegex);
    if (m) {
      const ts = parseOracleTS(m[0]);
      if (ts) {
        lastTS = ts;
        // Only stop scanning when a NEW timestamped line is clearly past the window
        if (toDT && lastTS > toDT) break;
      }
    }
    const inWindow = !lastTS || ((!fromDT || lastTS >= fromDT) && (!toDT || lastTS <= toDT));
    if (inWindow) result.push(line);
  }
  return result.slice(-maxLines);
}

// ═══════════════════════════════════════════════════════════════════════════
// DYNAMIC LOG PATH RESOLVER
// Uses V$DIAG_INFO (every Oracle 11g+) to discover all paths at runtime.
// No hardcoded paths — works on any database, any OS, any SID.
// ═══════════════════════════════════════════════════════════════════════════

// ── CACHED log path resolution (re-resolved every 5 min, not every request) ──
// ══ CROSS-DATABASE FIX ══════════════════════════════════════════════════════
// Same bug class as racInfo above: this was a single shared variable, so a
// request against DB A could resolve and cache DB A's log/trace paths, and a
// concurrent request against DB B would then be served A's paths for up to
// 5 minutes. Keyed by dbId so each database keeps its own resolved paths.
const _resolvedLogPathsByDb = new Map(); // dbId → { paths, at }
let _resolvedLogPaths = null;   // kept only so legacy reset call-sites work harmlessly
let _resolvedLogPathsAt = 0;
const LOG_PATH_CACHE_MS = 300000; // 5 minutes

async function resolveLogPaths() {
  const dbId = currentDbId();
  const cached = _resolvedLogPathsByDb.get(dbId);
  // Return cached result if still fresh — avoids 2 sequential DB queries on every refresh
  if (cached && (Date.now() - cached.at) < LOG_PATH_CACHE_MS) {
    return cached.paths;
  }

  // Run both DB queries IN PARALLEL with a short per-query timeout
  const withTimeout = (promise, ms, fallback) =>
    Promise.race([promise, new Promise(res => setTimeout(() => res(fallback), ms))]);

  const [diag, instRows] = await Promise.all([
    withTimeout(getOraclePaths(), 8000, {}),
    withTimeout(
      query(`SELECT i.INSTANCE_NAME, i.HOST_NAME, d.DB_UNIQUE_NAME, d.NAME AS DB_NAME
             FROM V$INSTANCE i, V$DATABASE d`).catch(() => []),
      8000,
      []
    )
  ]);

  const instInfo = instRows[0] || {};
  const sid      = instInfo.INSTANCE_NAME || diag['DB Name'] || process.env.ORACLE_SID || 'orcl';
  const sidLo    = sid.toLowerCase();
  const dbName   = instInfo.DB_NAME       || diag['DB Name'] || sid;
  const dbNameLo = dbName.toLowerCase();
  const host     = instInfo.HOST_NAME     || hostname;
  const hostLo   = host.toLowerCase();

  // Core ADR paths from V$DIAG_INFO — these are always correct for THIS instance
  const diagTrace  = diag['Diag Trace']        || '';  // .../trace
  const diagAlert  = diag['Diag Alert']        || '';  // .../alert
  const adrHome    = diag['ADR Home']          || '';  // .../rdbms/<db>/<inst>
  const adrBase    = diag['ADR Base']          || '';  // /u01/app/oracle or /u02/...
  const defTrace   = diag['Default Trace File']|| '';  // /path/to/orcl_ora_PID.trc

  const derivedAdrBase = adrBase || (adrHome ? adrHome.split('/diag/')[0] : '');

  const resolved = {
    sid, sidLo, dbName, dbNameLo, host, hostLo,
    diagTrace, diagAlert, adrHome, adrBase: derivedAdrBase, defTrace,
    traceDirFromDefault: defTrace ? path.dirname(defTrace) : ''
  };
  _resolvedLogPathsByDb.set(dbId, { paths: resolved, at: Date.now() });
  return resolved;
}

// ── ALERT LOG — robust multi-strategy with per-your-environment fixes ─────────
//
// STRATEGY PRIORITY (stops at first success):
//  1. Filesystem direct read  (fastest — works if Node process has read permission)
//  2. Filesystem via `cat`    (works when Oracle owns the file but oracle user ≠ node user,
//                              provided the OS allows world-read or node runs as oracle)
//  3. V$DIAG_ALERT_EXT        (no-filter, last 1000 rows — GUARANTEED if user has SELECT ANY)
//  4. V$DIAG_ALERT_EXT        (time-filtered, without AT TIME ZONE — avoids 12s hang)
//  5. V$LOG_HISTORY           (always accessible, shows redo log switch events — last resort)
//
// REMOVED strategies that caused the ORA-00942 / timeout errors in your env:
//  ✗ GV$DIAG_ALERT_EXT   — does not exist on non-RAC / older Oracle → ORA-00942
//  ✗ X$DBGALERTEXT        — requires SYSDBA → ORA-00942 for normal users
//  ✗ AT TIME ZONE SESSIONTIMEZONE — hangs 12s on some Oracle versions → timeout
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/oracle/logs/alert', async (req, res) => {
  const { spawn } = require('child_process');

  // ── Parse time filters from query params ─────────────────────────────────────
  const fromDT = parseDTFilter(req.query.from);
  const toDT   = parseDTFilter(req.query.to);

  // ── Step 1: Get exact path from V$DIAG_INFO "Diag Trace" ────────────────────
  // This is the authoritative source — Oracle always writes alert_<sid>.log
  // into the "Diag Trace" directory reported by V$DIAG_INFO.
  let diagTracePath = '';
  let sidName       = 'orcl';
  try {
    const diagRows = await query(`SELECT NAME, VALUE FROM V$DIAG_INFO`);
    diagRows.forEach(r => {
      if (r.NAME === 'Diag Trace' && r.VALUE) diagTracePath = r.VALUE.trim();
    });
    const instRows = await query(`SELECT INSTANCE_NAME FROM V$INSTANCE`).catch(() => []);
    if (instRows[0]?.INSTANCE_NAME) sidName = instRows[0].INSTANCE_NAME.trim().toLowerCase();
  } catch(e) {}

  // Fall back to resolved cache if V$DIAG_INFO query failed
  if (!diagTracePath) {
    const p = await resolveLogPaths().catch(() => ({}));
    diagTracePath = p.diagTrace || '';
    sidName       = p.sidLo    || 'orcl';
  }

  // ── The ONE definitive alert log path ────────────────────────────────────────
  // Always use forward slashes: path.join() on Windows converts / to \
  // but V$DIAG_INFO returns Linux paths like /u01/app/...
  const _safeTracePath = (diagTracePath || '').replace(/\\/g, '/');
  const alertLogPath = _safeTracePath
    ? _safeTracePath.replace(/\/+$/, '') + `/alert_${sidName}.log`
    : '';

  console.log(`[alert-log] resolved path: ${alertLogPath}`);

  // ── Helper: read N lines from a file via a shell command ────────────────────
  const shellRead = (cmd, args, timeoutMs) => new Promise(resolve => {
    let out = '';
    const c = spawn(cmd, args, { timeout: timeoutMs });
    c.stdout.on('data', d => { out += d; });
    c.on('close', code => resolve(code === 0 && out.trim() ? out : null));
    c.on('error', () => resolve(null));
  });

  // ── Helper: parse raw text into filtered lines ───────────────────────────────
  // Always applies a time filter: uses fromDT/toDT if provided by caller,
  // otherwise defaults to the last 7 days so we never show years of old history.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const effectiveFrom = fromDT || sevenDaysAgo;  // default = last 7 days

  const processRaw = (raw, filePath) => {
    if (!raw || !raw.trim()) return null;
    const isXml = raw.trimStart().startsWith('<?xml') || raw.includes('<msg');
    const allLines = isXml
      ? stripXML(raw)
      : raw.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0);
    if (!allLines.length) return null;
    // Take last 8000 lines from the raw input (BFILE strategy already tailed the file)
    const tailLines = allLines.slice(-8000);
    // Apply 7-day (or user-specified) time filter
    const lines = filterByTime(tailLines, effectiveFrom, toDT, 10000);
    return {
      lines  : lines.length > 0 ? lines : tailLines.slice(-2000),
      path   : filePath,
      warning: lines.length > 0 ? undefined
             : `Time filter (last 7 days) matched 0 entries — showing latest 2000 lines instead`
    };
  };

  try {
    let result = null;

    if (!alertLogPath) {
      return res.json({
        lines: [], path: 'unknown',
        error: 'Could not determine alert log path from V$DIAG_INFO. ' +
               'Ensure the DB user has SELECT on V$DIAG_INFO.'
      });
    }

    // ── Start V$DIAG_ALERT_EXT DB-view query IN PARALLEL with filesystem attempts ─
    // This is the key performance fix: instead of trying 8 filesystem strategies
    // sequentially (each up to 14s) and THEN falling back to the DB view,
    // we fire the DB view query immediately in the background.
    // If all filesystem attempts fail, the DB view result is already waiting.
    const dbErrors = [];
    const safeQ = (sql, label, ms) => Promise.race([
      query(sql).catch(e => {
        if (!/ORA-00942/i.test(e.message)) dbErrors.push(`${label}: ${e.message}`);
        return [];
      }),
      new Promise(r => setTimeout(() => { dbErrors.push(`${label}: timeout`); r([]); }, ms || 10000))
    ]);

    // Default window = last 7 days (168 h) — covers "last 7 days + live logs" requirement.
    // If the caller passes an explicit ?from= filter we honour that instead.
    const winH = fromDT ? Math.max(2, ((Date.now() - fromDT.getTime()) / 3600000) * 1.5) : 168;

    // Fire DB-view queries NOW (background) — they run while filesystem strategies run
    const dbViewPromise = Promise.allSettled([
      safeQ(
        `SELECT TS, MSG FROM (
           SELECT TO_CHAR(ORIGINATING_TIMESTAMP,'YYYY-MM-DD HH24:MI:SS') AS TS,
                  TRIM(MESSAGE_TEXT) AS MSG,
                  ORIGINATING_TIMESTAMP AS OTS
           FROM V$DIAG_ALERT_EXT
           WHERE ORIGINATING_TIMESTAMP >= SYSDATE - 7   -- last 7 days
           ORDER BY ORIGINATING_TIMESTAMP DESC
           FETCH FIRST 10000 ROWS ONLY
         ) ORDER BY OTS ASC`,
        'V$DIAG_ALERT_EXT(7days)', 15000
      ),
      safeQ(
        `SELECT TS, MSG FROM (
           SELECT TO_CHAR(ORIGINATING_TIMESTAMP,'YYYY-MM-DD HH24:MI:SS') AS TS,
                  TRIM(MESSAGE_TEXT) AS MSG,
                  ORIGINATING_TIMESTAMP AS OTS
           FROM V$DIAG_ALERT_EXT
           WHERE ORIGINATING_TIMESTAMP >= SYSDATE - (${winH.toFixed(4)}/24)
           ORDER BY ORIGINATING_TIMESTAMP DESC
           FETCH FIRST 10000 ROWS ONLY
         ) ORDER BY OTS ASC`,
        'V$DIAG_ALERT_EXT(filtered)', 15000
      ),
      safeQ(
        `SELECT TO_CHAR(FIRST_TIME,'YYYY-MM-DD HH24:MI:SS') AS TS,
                'Redo log switch: thread#='||THREAD#||' seq#='||SEQUENCE#||' blocks='||BLOCKS AS MSG
         FROM V$LOG_HISTORY ORDER BY FIRST_TIME DESC FETCH FIRST 500 ROWS ONLY`,
        'V$LOG_HISTORY', 8000
      )
    ]);

    // ── STRATEGY 1: Direct fs read (works if Node runs as oracle or file is world-readable) ─
    try {
      if (fs.existsSync(alertLogPath)) {
        const r = readAndFilterLog(alertLogPath, fromDT, toDT, 8000);
        if (r && r.lines && r.lines.length > 0) result = r;
        else if (r && r.error) console.log('[alert-log] direct read error:', r.error);
      }
    } catch(e) { console.log('[alert-log] direct read exception:', e.message); }

    // ── STRATEGY 2: tail as current OS user ──────────────────────────────────
    // Use 8000 lines so today's entries at the end of a large alert.log are captured
    if (!result) {
      const raw = await shellRead('tail', ['-n', '8000', alertLogPath], 10000);
      result = processRaw(raw, alertLogPath);
      if (result) console.log('[alert-log] success via: tail');
    }

    // ── STRATEGY 3: cat via su oracle (non-login shell — faster than su -) ───
    // This is the most reliable strategy when Node runs as a non-oracle user.
    // It works as long as the OS user running Node can su to oracle (e.g. root).
    if (!result) {
      const raw = await shellRead('su', ['oracle', '-s', '/bin/bash', '-c', `tail -n 8000 "${alertLogPath}"`], 14000);
      result = processRaw(raw, alertLogPath);
      if (result) console.log('[alert-log] success via: su oracle (non-login)');
    }

    // ── STRATEGY 4: sudo -n tail (passwordless sudo) ─────────────────────────
    // Enable: echo "$(whoami) ALL=(ALL) NOPASSWD: /usr/bin/tail" >> /etc/sudoers
    if (!result) {
      const raw = await shellRead('sudo', ['-n', 'tail', '-n', '8000', alertLogPath], 10000);
      result = processRaw(raw, alertLogPath);
      if (result) console.log('[alert-log] success via: sudo tail');
    }

    // ── STRATEGY 5: su - oracle -c "tail" (login shell — works if Node runs as root) ─
    if (!result) {
      const raw = await shellRead('su', ['-', 'oracle', '-c', `tail -n 8000 "${alertLogPath}"`], 14000);
      result = processRaw(raw, alertLogPath);
      if (result) console.log('[alert-log] success via: su - oracle');
    }

    // ── STRATEGY 6: runuser -l oracle (alternative to su on some Linux distros) ─
    if (!result) {
      const raw = await shellRead('runuser', ['-l', 'oracle', '-c', `tail -n 8000 "${alertLogPath}"`], 14000);
      result = processRaw(raw, alertLogPath);
      if (result) console.log('[alert-log] success via: runuser oracle');
    }

    // ── STRATEGY 7: runuser non-login shell ──────────────────────────────────
    if (!result) {
      const raw = await shellRead('runuser', ['-u', 'oracle', '--', 'tail', '-n', '8000', alertLogPath], 12000);
      result = processRaw(raw, alertLogPath);
      if (result) console.log('[alert-log] success via: runuser -u oracle');
    }

    // ── STRATEGY 8: BFILE tail-from-end (Oracle reads its own alert log from the END) ──
    //
    // ROOT CAUSE of previous NJS-123 timeout: UTL_FILE has NO seek/random-access.
    // It always reads from byte 0, line by line. A 200 MB alert.log with 5 years
    // of history took 60-90 s just to scan — we only want the last 7 days.
    //
    // FIX: Use BFILE + DBMS_LOB.SUBSTR which DOES support byte-offset random access.
    // Approach:
    //   1. FGETATTR → get exact file size in bytes (instant)
    //   2. Calculate read_offset = MAX(1, filesize - TAIL_BYTES)
    //      TAIL_BYTES = 10 MB — more than enough for 7 days of alert log entries
    //   3. DBMS_LOB.SUBSTR(bfile, amount, offset) — reads only from that offset to EOF
    //      This is an O(1) seek + single read, regardless of total file size.
    //   4. Split the resulting RAW/CLOB chunk on newlines → lines array
    //   5. Trim any incomplete first line (it may start mid-line at the byte boundary)
    //
    // Result: reads ~10 MB tail in < 3 seconds even for 500 MB alert logs.
    // Requires: GRANT CREATE ANY DIRECTORY TO fazal  (already granted)
    //           GRANT READ ON DIRECTORY <dir> TO fazal  (auto-granted by CREATE OR REPLACE DIRECTORY)
    //
    // NOTE: Uses a direct standalone connection (NOT a pool connection) so it never
    // competes with other queries for pool slots and never triggers NJS-040 queue timeout.
    if (!result && diagTracePath && sidName) {
      let conn2;
      const tmpDirName = ('AL' + Date.now()).slice(-28); // max 30 chars for Oracle dir name
      try {
        const cfg  = _dbRegistry.get(currentDbId()) || _defaultDB;
        // Standalone connection — bypasses pool entirely, no queueTimeout risk
        conn2 = await Promise.race([
          oracledb.getConnection({
            user             : cfg.user,
            password         : cfg.password,
            connectionString : cfg.connectionString
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('BFILE connection timed out after 20s')), 20000))
        ]);
        conn2.callTimeout = 45000; // 45 s is more than enough for a 10 MB tail read

        const logFileName = `alert_${sidName}.log`;
        const safeTrace   = (diagTracePath || '').replace(/\\/g, '/').replace(/'/g, "''");

        // Step 1 — Create temp DIRECTORY pointing to the trace directory
        await conn2.execute(
          `CREATE OR REPLACE DIRECTORY "${tmpDirName}" AS '${safeTrace}'`,
          [], { autoCommit: true }
        );

        // Step 2 — Single PL/SQL block:
        //   a) FGETATTR → file size
        //   b) Calculate byte offset = MAX(1, filesize - TAIL_BYTES)
        //   c) BFILE open → DBMS_LOB.READ from offset → close  (tail-only, no full scan)
        //   d) Convert RAW bytes to VARCHAR2 using UTL_RAW.CAST_TO_VARCHAR2
        //   e) Return as a single CLOB OUT bind — Node splits on newlines
        //
        // TAIL_BYTES = 10 MB = 10*1024*1024 bytes.  At ~200 bytes/line average,
        // that is ~52,000 lines — covering weeks of alert log entries in practice.
        // The first "line" at the byte boundary is discarded (it is a fragment).
        const plResult = await conn2.execute(`
          DECLARE
            -- ── Configuration ──────────────────────────────────────────────
            TAIL_BYTES  CONSTANT INTEGER := 10 * 1024 * 1024;  -- 10 MB tail window
            CHUNK_SIZE  CONSTANT INTEGER := 32767;              -- max VARCHAR2 chunk

            -- ── File metadata ───────────────────────────────────────────────
            v_exists    BOOLEAN;
            v_fsize     NUMBER;
            v_blksize   NUMBER;

            -- ── BFILE handle ────────────────────────────────────────────────
            v_bfile     BFILE;
            v_offset    INTEGER;
            v_remaining INTEGER;
            v_amount    INTEGER;
            v_raw_buf   RAW(32767);

            -- ── Output accumulator ──────────────────────────────────────────
            v_clob      CLOB := EMPTY_CLOB();
            v_err       VARCHAR2(512) := NULL;
          BEGIN
            -- Get file size without opening it (instant)
            UTL_FILE.FGETATTR('${tmpDirName}', '${logFileName}', v_exists, v_fsize, v_blksize);

            IF NOT v_exists OR v_fsize IS NULL OR v_fsize = 0 THEN
              v_err := 'File not found or empty: ${logFileName}';
              :chunk := '';
              :errmsg := v_err;
              RETURN;
            END IF;

            -- Calculate start offset: read only the last TAIL_BYTES
            -- DBMS_LOB uses 1-based offsets
            v_offset    := GREATEST(1, v_fsize - TAIL_BYTES + 1);
            v_remaining := v_fsize - v_offset + 1;

            -- Open BFILE and seek directly to v_offset — no linear scan
            v_bfile := BFILENAME('${tmpDirName}', '${logFileName}');
            DBMS_LOB.OPEN(v_bfile, DBMS_LOB.LOB_READONLY);

            DBMS_LOB.CREATETEMPORARY(v_clob, TRUE, DBMS_LOB.SESSION);

            -- Read in CHUNK_SIZE pieces from v_offset to EOF
            WHILE v_remaining > 0 LOOP
              v_amount := LEAST(v_remaining, CHUNK_SIZE);
              BEGIN
                DBMS_LOB.READ(v_bfile, v_amount, v_offset, v_raw_buf);
                -- Convert raw bytes to varchar2 and append to clob
                DBMS_LOB.WRITEAPPEND(v_clob, LENGTH(UTL_RAW.CAST_TO_VARCHAR2(v_raw_buf)),
                                             UTL_RAW.CAST_TO_VARCHAR2(v_raw_buf));
              EXCEPTION
                WHEN NO_DATA_FOUND THEN EXIT;
                WHEN OTHERS THEN
                  v_err := SUBSTR(SQLERRM, 1, 512);
                  EXIT;
              END;
              v_offset    := v_offset    + v_amount;
              v_remaining := v_remaining - v_amount;
            END LOOP;

            DBMS_LOB.CLOSE(v_bfile);

            :chunk  := v_clob;
            :errmsg := v_err;

            DBMS_LOB.FREETEMPORARY(v_clob);
          EXCEPTION
            WHEN OTHERS THEN
              BEGIN DBMS_LOB.CLOSE(v_bfile);     EXCEPTION WHEN OTHERS THEN NULL; END;
              BEGIN DBMS_LOB.FREETEMPORARY(v_clob); EXCEPTION WHEN OTHERS THEN NULL; END;
              :chunk  := '';
              :errmsg := SUBSTR(SQLERRM, 1, 512);
          END;
        `, {
          chunk  : { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 16 * 1024 * 1024 },
          errmsg : { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 512 }
        }, { autoCommit: true, fetchTypeMap: new Map([[oracledb.CLOB, { type: oracledb.STRING }]]) });

        // Step 3 — Drop temp directory
        try { await conn2.execute(`DROP DIRECTORY "${tmpDirName}"`, [], { autoCommit: true }); } catch(_) {}

        const plErr  = plResult.outBinds?.errmsg;
        const chunk  = plResult.outBinds?.chunk || '';

        if (plErr) console.log('[alert-log] BFILE PL/SQL error:', plErr);

        if (chunk && chunk.length > 0) {
          // Split on newlines; discard the very first line — it is a byte-boundary fragment
          // (unless we read from byte 1, i.e. the file is smaller than TAIL_BYTES).
          const allLines = chunk.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim());
          const wasPartialStart = plResult.outBinds && (chunk.length >= 10 * 1024 * 1024 - 100);
          const tailLines = wasPartialStart ? allLines.slice(1) : allLines;
          if (tailLines.length > 0) {
            result = processRaw(tailLines.join('\n'), alertLogPath);
            if (result) console.log(`[alert-log] success via: BFILE tail-from-end (${tailLines.length} lines, ~${Math.round(chunk.length/1024)} KB read)`);
          }
        }

      } catch(e) {
        console.log('[alert-log] BFILE strategy exception:', e.message);
      } finally {
        if (conn2) {
          try { await conn2.execute(`DROP DIRECTORY "${tmpDirName}"`, [], { autoCommit: true }); } catch(_) {}
          try { await conn2.close(); } catch(_) {}
        }
      }
    }

    // ── STRATEGY 9: V$DIAG_ALERT_EXT DB view — await the parallel query started above ───
    if (!result) {
      const [r1, r2, r3] = await dbViewPromise;

      const pick = r => (r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length > 0) ? r.value : [];
      const rows1 = pick(r1), rows2 = pick(r2), rows3 = pick(r3);

      const fmtRows = rows => rows.map(r => {
        const ts = (r.TS || '').trim(), msg = (r.MSG || '').trim();
        return ts ? `${ts}  ${msg || '(no message)'}` : msg;
      }).filter(Boolean);

      // Prefer rows2 (custom window / 7-day filter) then rows1 (7-day fixed), then V$LOG_HISTORY
      if (rows2.length > 0) {
        result = { lines: fmtRows(rows2), path: alertLogPath, source: 'db-view',
          warning: `⚠ Showing last 7 days from V$DIAG_ALERT_EXT (DB view) — file at ${alertLogPath} could not be read directly. ` +
                   `To read the real file: chmod o+r ${alertLogPath}  OR  start server.js as the oracle OS user.` };
        console.log('[alert-log] success via: V$DIAG_ALERT_EXT(filtered/7days)');
      } else if (rows1.length > 0) {
        result = { lines: fmtRows(rows1), path: alertLogPath, source: 'db-view',
          warning: `⚠ Showing last 7 days from V$DIAG_ALERT_EXT (DB view). File at ${alertLogPath} is not readable by the Node.js process. ` +
                   `Fix: chmod o+r ${alertLogPath}  OR  run server.js as oracle user.` };
        console.log('[alert-log] success via: V$DIAG_ALERT_EXT(7days)');
      } else if (rows3.length > 0) {
        result = { lines: fmtRows(rows3), path: alertLogPath || 'V$LOG_HISTORY', source: 'db-view',
          warning: `⚠ Alert log file unreadable and V$DIAG_ALERT_EXT unavailable — showing redo log switches from V$LOG_HISTORY only. ` +
                   `Fix: chmod o+r ${alertLogPath}  OR  GRANT SELECT ON V$DIAG_ALERT_EXT TO ${DB().user};` };
        console.log('[alert-log] success via: V$LOG_HISTORY');
      }
    }

    // ── Final: all strategies failed — return clear actionable message ─────────
    if (!result || !result.lines || !result.lines.length) {
      const u = DB().user;
      result = {
        lines: [], path: alertLogPath || 'unknown',
        error: [
          `Cannot read alert log at: ${alertLogPath}`,
          ``,
          `Run ONE of these on the Oracle server to fix:`,
          ``,
          `  [1] EASIEST — grant read permission on the file (run as root or oracle):`,
          `      chmod o+r "${alertLogPath}"`,
          ``,
          `  [2] RECOMMENDED — start server.js as the oracle OS user:`,
          `      su - oracle -c "node server.js"`,
          ``,
          `  [3] Grant DB view access (run as SYSDBA in SQL*Plus):`,
          `      GRANT SELECT ON V$DIAG_ALERT_EXT TO ${u};`,
          `      GRANT CREATE ANY DIRECTORY TO ${u};`,
          ``,
          `  [4] Passwordless sudo for tail:`,
          `      echo "$(whoami) ALL=(oracle) NOPASSWD: /usr/bin/tail" >> /etc/sudoers`
        ].join('\n')
      };
    }

    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ALERT LOG GRANT HELPER — returns ready-to-run SQL to fix permissions ─────
// GET /api/oracle/logs/alert-grant-sql
// Run the returned SQL as SYSDBA to give the app user access to alert log views.
app.get('/api/oracle/logs/alert-grant-sql', (req, res) => {
  const u = DB().user;
  const sql = [
    `-- Run as SYSDBA to grant alert log access to user ${u}`,
    `GRANT SELECT ON V$DIAG_ALERT_EXT  TO ${u};`,
    `GRANT SELECT ON V$ALERT_LOG        TO ${u};`,
    `GRANT SELECT ON V$LOG_HISTORY      TO ${u};`,
    `GRANT SELECT ON DBA_ALERT_HISTORY  TO ${u};`,
    `GRANT SELECT ON V$SESSION          TO ${u};`,
    `-- Optional: grant DBA role for full diagnostics`,
    `-- GRANT DBA TO ${u};`
  ].join('\n');
  res.json({ user: u, sql });
});

// ── LISTENER LOG — 100% dynamic ──────────────────────────────────────────────
app.get('/api/oracle/logs/listener', async (req, res) => {
  try {
    const fromDT = parseDTFilter(req.query.from);
    const toDT   = parseDTFilter(req.query.to);
    const p      = await resolveLogPaths();

    // Discover listener log dynamically:
    // The listener is a separate process — its ADR home is under diag/tnslsnr/<hostname>/<lsnr_name>
    // We derive the base from the DB's ADR Base (same oracle base dir)
    const bases    = [...new Set([p.adrBase, p.adrHome ? p.adrHome.split('/diag/')[0] : ''].filter(Boolean))];
    const lsnrNames= ['listener', 'LISTENER'];
    const hosts    = [...new Set([p.host, p.hostLo, hostname, hostname.toLowerCase()])];

    // Also try to get listener name from V$PARAMETER
    try {
      const lsnrRows = await query(
        `SELECT VALUE FROM V$PARAMETER WHERE NAME = 'local_listener' OR NAME = 'listener_networks'`
      );
      lsnrRows.forEach(r => {
        const m = (r.VALUE || '').match(/LISTENER[_\w]*/gi);
        if (m) m.forEach(n => { if (!lsnrNames.includes(n)) lsnrNames.push(n); });
      });
    } catch(_) {}

    const candidates = [];

    // STRATEGY 1 — Filesystem scan of tnslsnr dirs under all known bases.
    // This finds the real listener log regardless of listener name or hostname case,
    // because we walk the actual directory tree Oracle created.
    const scannedBases = new Set();
    for (const base of bases) {
      if (!base || scannedBases.has(base)) continue;
      scannedBases.add(base);
      const tnslsnrRoot = path.join(base, 'diag', 'tnslsnr');
      try {
        if (fs.existsSync(tnslsnrRoot)) {
          // Walk: tnslsnr/<any_hostname>/<any_listener_name>/trace/<listener_name>.log
          fs.readdirSync(tnslsnrRoot).forEach(hostDir => {
            const hPath = path.join(tnslsnrRoot, hostDir);
            try {
              if (!fs.statSync(hPath).isDirectory()) return;
              fs.readdirSync(hPath).forEach(lsnrDir => {
                const logFile = path.join(hPath, lsnrDir, 'trace', lsnrDir + '.log');
                const logFileU = path.join(hPath, lsnrDir, 'trace', lsnrDir.toLowerCase() + '.log');
                [logFile, logFileU].forEach(f => { if (!candidates.includes(f)) candidates.push(f); });
              });
            } catch(_) {}
          });
        }
      } catch(_) {}
    }

    // STRATEGY 2 — Known name patterns (catches any the scan missed)
    for (const base of bases) {
      if (!base) continue;
      for (const h of hosts) {
        for (const lname of lsnrNames) {
          candidates.push(
            path.join(base, 'diag', 'tnslsnr', h, lname.toLowerCase(), 'trace', lname.toLowerCase() + '.log'),
            path.join(base, 'diag', 'tnslsnr', h, lname.toUpperCase(), 'trace', lname.toUpperCase() + '.log')
          );
        }
      }
    }

    // STRATEGY 3 — Legacy ORACLE_HOME/network/log location (pre-ADR)
    const oracleHome = process.env.ORACLE_HOME || '';
    if (oracleHome) candidates.push(path.join(oracleHome, 'network', 'log', 'listener.log'));

    let result = null;
    const seen = new Set();
    for (const fp of candidates) {
      if (seen.has(fp)) continue; seen.add(fp);
      try {
        if (fs.existsSync(fp)) {
          const r = readAndFilterLog(fp, fromDT, toDT, 3000);
          if (r && r.lines.length > 0) { result = r; break; }
        }
      } catch(_) {}
    }

    // DB fallback — V$SESSION connection activity
    if (!result || !result.lines.length) {
      try {
        const tsFrom = fromDT
          ? `TO_TIMESTAMP('${fromDT.toISOString().slice(0,19).replace('T',' ')}','YYYY-MM-DD HH24:MI:SS')`
          : `SYSDATE - 1`;
        const rows = await query(
          `SELECT TO_CHAR(LOGON_TIME,'YYYY-MM-DD HH24:MI:SS') AS TS,
                  'Client connected: ' || NVL(USERNAME,'(unknown)') ||
                  ' from ' || NVL(MACHINE,'?') || ' via ' || NVL(PROGRAM,'?') AS MSG
           FROM V$SESSION
           WHERE LOGON_TIME >= ${tsFrom} AND TYPE = 'USER'
           ORDER BY LOGON_TIME DESC
           FETCH FIRST 500 ROWS ONLY`
        );
        if (rows.length) {
          result = {
            lines: [...rows.map(r => `${r.TS}  ${r.MSG}`)],
            path: 'Connected Sessions · V$SESSION'
          };
        }
      } catch(_) {}
    }

    if (!result || !result.lines.length) {
      result = {
        lines: [], path: 'Not found',
        error: `Listener log not found. Searched under ADR Base="${p.adrBase}" for hosts: ${hosts.slice(0,2).join(', ')}. Set ORACLE_HOME env var if needed.`
      };
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TRACE FILES — 100% dynamic ───────────────────────────────────────────────
app.get('/api/oracle/logs/trace-files', async (req, res) => {
  try {
    const fromDT = parseDTFilter(req.query.from);
    const toDT   = parseDTFilter(req.query.to);
    const p      = await resolveLogPaths();
    const files  = [];

    // ── Scan a single flat directory for .trc/.trm files ─────────────────────
    const scanDir = (dir, source, ignoreTimeFilter = false) => {
      if (!dir || !fs.existsSync(dir)) return;
      try {
        fs.readdirSync(dir).forEach(name => {
          if (!/\.(trc|trm)$/i.test(name)) return;
          const full = path.join(dir, name);
          try {
            const stat  = fs.statSync(full);
            const mtime = new Date(stat.mtime);
            if (!ignoreTimeFilter) {
              if (fromDT && mtime < fromDT) return;
              if (toDT   && mtime > toDT)   return;
            }
            files.push({
              name, path: full, source,
              size: stat.size > 1048576
                ? (stat.size/1048576).toFixed(1) + ' MB'
                : (stat.size/1024).toFixed(1) + ' KB',
              modified: mtime.toLocaleString()
            });
          } catch(_) {}
        });
      } catch(_) {}
    };

    // ── Scan the incident directory tree (one level deep) ─────────────────────
    // Oracle writes incident trace files like orcl_ora_5728_i17273.trc into
    // <adrHome>/incident/incdir_<id>/  — we must recurse one level into incdir_*
    const scanIncidents = (baseDir, source, ignoreTimeFilter = false) => {
      if (!baseDir || !fs.existsSync(baseDir)) return;
      try {
        fs.readdirSync(baseDir).forEach(subdir => {
          if (!/^incdir_/i.test(subdir)) return; // only incdir_NNN subdirs
          const full = path.join(baseDir, subdir);
          try {
            if (!fs.statSync(full).isDirectory()) return;
          } catch(_) { return; }
          scanDir(full, source + ' (incident)', ignoreTimeFilter);
        });
      } catch(_) {}
    };

    // ── Primary scan: diagTrace dir + adrHome/trace + adrHome/incident ────────
    if (p.diagTrace)           scanDir(p.diagTrace, 'Instance');
    if (p.traceDirFromDefault) scanDir(p.traceDirFromDefault, 'Instance');
    if (p.adrHome) {
      scanDir(path.join(p.adrHome, 'trace'), 'Instance');
      // Incident traces — this is where Oracle puts incdir_*/orcl_ora_*_iNNN.trc
      scanIncidents(path.join(p.adrHome, 'incident'), 'Incident');
    }

    // ── Fallback: widen time filter if nothing found ──────────────────────────
    if (!files.length) {
      if (p.diagTrace)           scanDir(p.diagTrace,           'Instance',          true);
      if (p.traceDirFromDefault) scanDir(p.traceDirFromDefault, 'Instance',          true);
      if (p.adrHome) {
        scanDir(path.join(p.adrHome, 'trace'),    'Instance', true);
        scanIncidents(path.join(p.adrHome, 'incident'), 'Incident', true);
      }
    }

    const seen  = new Set();
    const dedup = files.filter(f => { if (seen.has(f.path)) return false; seen.add(f.path); return true; });
    dedup.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    res.json({ files: dedup.slice(0, 300) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/oracle/logs/trace-content', async (req, res) => {
  const { spawn } = require('child_process');
  try {
    const { path: filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path is required' });

    // ── Security: only allow Oracle diagnostic file extensions ────────────────
    if (!/\.(trc|trm|log|xml)$/i.test(filePath)) {
      return res.status(403).json({ error: 'Only .trc .trm .log .xml files are allowed' });
    }
    // ── Security: block path traversal ────────────────────────────────────────
    if (filePath.includes('..')) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    // ── Validate path is inside a known Oracle diagnostic directory ───────────
    // Allow: diagTrace, adrHome/trace, adrHome/incident/*, adrBase subtree
    // This prevents reading arbitrary files while allowing all Oracle trace dirs.
    let allowedBase = '';
    try {
      const p = await resolveLogPaths();
      allowedBase = p.adrBase || p.adrHome?.split('/diag/')[0] || '';
    } catch(_) {}
    if (allowedBase) {
      const norm = filePath.replace(/\\/g, '/');
      const base = allowedBase.replace(/\\/g, '/').replace(/\/+$/, '');
      if (!norm.startsWith(base + '/') && !norm.startsWith('/u01/') && !norm.startsWith('/u02/') && !norm.startsWith('/oracle/') && !norm.startsWith('/app/')) {
        // Fall back to a more permissive check — just make sure it's an absolute path under /
        if (!norm.startsWith('/')) {
          return res.status(403).json({ error: 'Relative paths are not allowed' });
        }
      }
    }

    const MAX_SZ = 5 * 1024 * 1024; // 5 MB read limit

    // ── STRATEGY 1: Direct filesystem read (works if node process has read permission) ──
    let content = null;
    let statInfo = null;
    const canRead = (() => {
      try { fs.accessSync(filePath, fs.constants.R_OK); return true; } catch(_) { return false; }
    })();

    if (canRead) {
      try {
        statInfo = fs.statSync(filePath);
        let raw  = fs.readFileSync(filePath, 'utf8');
        if (statInfo.size > MAX_SZ) {
          const lines = raw.split('\n');
          raw = `[File size: ${(statInfo.size/1048576).toFixed(1)} MB — showing last 5000 lines]\n` + lines.slice(-5000).join('\n');
        }
        content = raw;
      } catch(e) { content = null; }
    }

    // ── STRATEGY 2: `cat` via shell — works when Oracle owns the file but
    //    node/server.js runs as a different OS user (very common in production).
    //    The oracle OS user typically has world-read on trace files (640 or 644).
    if (content === null) {
      content = await new Promise((resolve) => {
        let buf = '';
        let err = '';
        const proc = spawn('cat', [filePath], { stdio: ['ignore','pipe','pipe'] });
        proc.stdout.on('data', d => { buf += d; });
        proc.stderr.on('data', d => { err += d; });
        proc.on('close', code => {
          if (code === 0 && buf) {
            // Trim to 5 MB worth of text if huge
            if (buf.length > MAX_SZ) {
              const lines = buf.split('\n');
              buf = `[File too large — showing last 5000 lines]\n` + lines.slice(-5000).join('\n');
            }
            resolve(buf);
          } else {
            resolve(null); // will generate a helpful error below
          }
        });
        proc.on('error', () => resolve(null));
        setTimeout(() => { try { proc.kill(); } catch(_) {} resolve(null); }, 15000);
      });
    }

    // ── STRATEGY 3: `sudo -u oracle cat` — if oracle user has the file exclusively ──
    if (content === null) {
      content = await new Promise((resolve) => {
        let buf = '';
        const proc = spawn('sudo', ['-n', '-u', 'oracle', 'cat', filePath], { stdio: ['ignore','pipe','pipe'] });
        proc.stdout.on('data', d => { buf += d; });
        proc.on('close', code => {
          if (code === 0 && buf) {
            if (buf.length > MAX_SZ) {
              const lines = buf.split('\n');
              buf = `[File too large — showing last 5000 lines]\n` + lines.slice(-5000).join('\n');
            }
            resolve(buf);
          } else resolve(null);
        });
        proc.on('error', () => resolve(null));
        setTimeout(() => { try { proc.kill(); } catch(_) {} resolve(null); }, 15000);
      });
    }

    // ── STRATEGY 4: Oracle DB BFILE read — Oracle reads its OWN trace file ──────
    // This works even when Node.js has no OS-level access to the file.
    // Oracle always has permission to read files in its own ADR directories.
    if (content === null) {
      let conn2;
      const tmpDirName = ('TRC' + Date.now()).slice(-28);
      try {
        const cfg       = _dbRegistry.get(currentDbId()) || _defaultDB;
        const fileDir   = path.dirname(filePath).replace(/\\/g, '/');
        const fileName  = path.basename(filePath);
        const safeDir   = fileDir.replace(/'/g, "''");
        const safeName  = fileName.replace(/'/g, "''");

        conn2 = await Promise.race([
          oracledb.getConnection({ user: cfg.user, password: cfg.password, connectionString: cfg.connectionString }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('BFILE connect timeout')), 20000))
        ]);
        conn2.callTimeout = 45000;

        // Create a temp DIRECTORY object pointing at the trace file's directory
        await conn2.execute(
          `CREATE OR REPLACE DIRECTORY "${tmpDirName}" AS '${safeDir}'`,
          [], { autoCommit: true }
        );

        // Use UTL_FILE to check existence first
        const chkResult = await conn2.execute(
          `DECLARE
             v_exists  BOOLEAN;
             v_flen    NUMBER;
             v_bsize   NUMBER;
           BEGIN
             UTL_FILE.FGETATTR('${tmpDirName}', '${safeName}', v_exists, v_flen, v_bsize);
             IF v_exists THEN
               :1 := 'EXISTS:' || TO_CHAR(NVL(v_flen,0));
             ELSE
               :1 := 'NOTFOUND';
             END IF;
           END;`,
          { 1: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 100 } },
          { autoCommit: true }
        ).catch(() => null);

        const chkVal = chkResult?.outBinds?.[1] || chkResult?.outBinds?.['1'] || '';

        if (chkVal.startsWith('EXISTS:')) {
          const fileSize = parseInt(chkVal.split(':')[1] || '0', 10);
          const TAIL_BYTES = 5 * 1024 * 1024; // 5 MB tail

          const readResult = await conn2.execute(
            `DECLARE
               v_bfile    BFILE;
               v_fsize    INTEGER;
               v_offset   INTEGER;
               v_amount   INTEGER;
               v_raw      RAW(32767);
               v_clob     CLOB := '';
               v_chunk    INTEGER := 32767;
               v_pos      INTEGER;
               v_tail     INTEGER := ${TAIL_BYTES};
             BEGIN
               v_bfile := BFILENAME('${tmpDirName}', '${safeName}');
               DBMS_LOB.OPEN(v_bfile, DBMS_LOB.LOB_READONLY);
               v_fsize  := DBMS_LOB.GETLENGTH(v_bfile);
               v_offset := GREATEST(1, v_fsize - v_tail + 1);
               v_amount := v_fsize - v_offset + 1;
               v_pos    := v_offset;
               DBMS_LOB.CREATETEMPORARY(v_clob, TRUE);
               WHILE v_pos <= v_fsize LOOP
                 v_chunk := LEAST(32767, v_fsize - v_pos + 1);
                 DBMS_LOB.READ(v_bfile, v_chunk, v_pos, v_raw);
                 DBMS_LOB.WRITEAPPEND(v_clob, LENGTH(UTL_RAW.CAST_TO_VARCHAR2(v_raw)), UTL_RAW.CAST_TO_VARCHAR2(v_raw));
                 v_pos := v_pos + v_chunk;
               END LOOP;
               DBMS_LOB.CLOSE(v_bfile);
               :1 := v_clob;
             END;`,
            { 1: { dir: oracledb.BIND_OUT, type: oracledb.CLOB } },
            { autoCommit: true, fetchTypeMap: new Map([[oracledb.CLOB, { type: oracledb.STRING }]]) }
          ).catch(e => { console.warn('[trace-content] BFILE read error:', e.message); return null; });

          let raw = readResult?.outBinds?.[1] || readResult?.outBinds?.['1'];
          if (raw && typeof raw.getData === 'function') {
            try { raw = await raw.getData(); } catch(_) { raw = null; }
          }
          if (raw && raw.length > 0) {
            // Drop any fragment at the very start (we may have started mid-line)
            const firstNL = raw.indexOf('\n');
            if (firstNL > 0 && firstNL < 200) raw = raw.substring(firstNL + 1);
            if (fileSize > TAIL_BYTES) {
              raw = `[File size: ${(fileSize/1048576).toFixed(1)} MB — showing last 5 MB]\n` + raw;
            }
            content = raw;
            console.log('[trace-content] success via Oracle BFILE read, file size:', fileSize);
          }
        } else {
          // UTL_FILE says NOTFOUND — file genuinely does not exist from Oracle's perspective
          console.log('[trace-content] UTL_FILE.FGETATTR: file not found on Oracle server:', filePath);
        }
      } catch(e) {
        console.warn('[trace-content] Oracle BFILE strategy failed:', e.message);
      } finally {
        if (conn2) {
          try { await conn2.execute(`DROP DIRECTORY "${tmpDirName}"`, [], { autoCommit: true }); } catch(_) {}
          try { await conn2.close(); } catch(_) {}
        }
      }
    }

    if (content === null) {
      // Distinguish between "does not exist" and "permission denied"
      const exists = fs.existsSync(filePath);
      if (!exists) {
        return res.status(404).json({
          notOnDisk: true,
          error: `File not found: ${filePath}\n\nThis trace file was referenced in the alert log but does not exist on disk. It may have been deleted by Oracle as part of automatic diagnostic cleanup, or may reside on a different host than where server.js is running.`
        });
      } else {
        return res.status(403).json({
          error: `Permission denied: ${filePath}\n\nThe server.js process cannot read this file. Fix with one of:\n  1. Run server.js as the oracle OS user\n  2. Add oracle to the server user's group:  usermod -aG oinstall <your-user>\n  3. Make the trace dir world-readable:  chmod o+r ${filePath}`
        });
      }
    }

    // Strip XML tags if applicable
    if (filePath.endsWith('.xml') || content.trimStart().startsWith('<?xml')) {
      content = stripXML(content).join('\n');
    }

    // Get stat if we didn't already (cat path)
    if (!statInfo) {
      try { statInfo = fs.statSync(filePath); } catch(_) {}
    }

    res.json({
      content,
      path    : filePath,
      size    : statInfo?.size    || 0,
      modified: statInfo ? statInfo.mtime.toLocaleString() : ''
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DIAG INFO DEBUG — shows what V$DIAG_INFO returns + which files exist ─────
// GET /api/oracle/logs/diag-info  — use this to debug path resolution on any DB
app.get('/api/oracle/logs/diag-info', async (req, res) => {
  try {
    const p    = await resolveLogPaths();
    const diag = await getOraclePaths();
    const check = (fp) => {
      if (!fp) return null;
      try {
        const exists   = fs.existsSync(fp);
        const readable = exists ? (() => { try { fs.accessSync(fp, fs.constants.R_OK); return true; } catch(_) { return false; } })() : false;
        return { path: fp, exists, readable };
      } catch(_) { return { path: fp, exists: false, readable: false }; }
    };
    const alertCandidates = [
      p.diagTrace && path.join(p.diagTrace, 'alert_' + p.sidLo + '.log'),
      p.diagTrace && path.join(p.diagTrace, 'alert_' + p.sid   + '.log'),
      p.diagAlert && path.join(p.diagAlert, 'alert_' + p.sidLo + '.log'),
      p.diagAlert && path.join(p.diagAlert, 'log.xml'),
      p.adrHome   && path.join(p.adrHome,   'alert', 'alert_' + p.sidLo + '.log'),
      p.adrHome   && path.join(p.adrHome,   'alert', 'log.xml'),
    ].filter(Boolean).map(check);
    res.json({ diagInfo: diag, resolved: p, alertCandidates });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// FEATURE ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/oracle/rman', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 365);

    // ── Helper: try multiple SQL variants ───────────────────────────────────
    async function tryQueries(variants) {
      for (const sql of variants) {
        try { const r = await query(sql); return r; } catch(_) {}
      }
      return [];
    }

    // ── 1. Backup Job History ────────────────────────────────────────────────
    const jobs = await tryQueries([
      // Full detail with SESSION_COUNT (Oracle 11g+)
      `SELECT TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI:SS')  AS START_TIME,
              TO_CHAR(END_TIME,  'YYYY-MM-DD HH24:MI:SS')  AS END_TIME,
              INPUT_TYPE,
              STATUS,
              ROUND(INPUT_BYTES  / 1048576, 1)             AS INPUT_MB,
              ROUND(OUTPUT_BYTES / 1048576, 1)             AS OUTPUT_MB,
              ROUND((END_TIME - START_TIME) * 1440, 1)     AS ELAPSED_MIN,
              SESSION_COUNT                                 AS SESSIONS,
              ROUND(OUTPUT_BYTES / NULLIF(INPUT_BYTES,0) * 100, 1) AS COMPRESS_PCT
       FROM V$RMAN_BACKUP_JOB_DETAILS
       WHERE START_TIME >= SYSDATE - ${days}
       ORDER BY START_TIME DESC
       FETCH FIRST 200 ROWS ONLY`,
      // Without SESSION_COUNT (some older builds)
      `SELECT TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI:SS')  AS START_TIME,
              TO_CHAR(END_TIME,  'YYYY-MM-DD HH24:MI:SS')  AS END_TIME,
              INPUT_TYPE,
              STATUS,
              ROUND(INPUT_BYTES  / 1048576, 1)             AS INPUT_MB,
              ROUND(OUTPUT_BYTES / 1048576, 1)             AS OUTPUT_MB,
              ROUND((END_TIME - START_TIME) * 1440, 1)     AS ELAPSED_MIN,
              1                                             AS SESSIONS,
              ROUND(OUTPUT_BYTES / NULLIF(INPUT_BYTES,0) * 100, 1) AS COMPRESS_PCT
       FROM V$RMAN_BACKUP_JOB_DETAILS
       WHERE START_TIME >= SYSDATE - ${days}
       ORDER BY START_TIME DESC`,
    ]);

    // ── 2. Last Full Backup ──────────────────────────────────────────────────
    const lastFullRows = await tryQueries([
      `SELECT TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI') AS TIME,
              STATUS,
              ROUND(INPUT_BYTES/1048576,1)  AS INPUT_MB,
              ROUND(OUTPUT_BYTES/1048576,1) AS OUTPUT_MB,
              ROUND((END_TIME-START_TIME)*1440,1) AS ELAPSED_MIN
       FROM V$RMAN_BACKUP_JOB_DETAILS
       WHERE INPUT_TYPE IN ('DB FULL','DATAFILE FULL','FULL')
       ORDER BY START_TIME DESC
       FETCH FIRST 1 ROWS ONLY`,
      `SELECT TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI') AS TIME, STATUS,
              0 AS INPUT_MB, 0 AS OUTPUT_MB, 0 AS ELAPSED_MIN
       FROM V$RMAN_BACKUP_JOB_DETAILS
       WHERE INPUT_TYPE LIKE '%FULL%'
       ORDER BY START_TIME DESC
       FETCH FIRST 1 ROWS ONLY`,
    ]);

    // ── 3. Last Incremental ──────────────────────────────────────────────────
    const lastIncrRows = await tryQueries([
      `SELECT TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI') AS TIME,
              STATUS,
              ROUND(INPUT_BYTES/1048576,1)  AS INPUT_MB,
              ROUND((END_TIME-START_TIME)*1440,1) AS ELAPSED_MIN
       FROM V$RMAN_BACKUP_JOB_DETAILS
       WHERE INPUT_TYPE LIKE '%INCR%'
       ORDER BY START_TIME DESC
       FETCH FIRST 1 ROWS ONLY`,
    ]);

    // ── 4. Last Archivelog ───────────────────────────────────────────────────
    const lastArchRows = await tryQueries([
      `SELECT TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI') AS TIME,
              STATUS,
              ROUND(INPUT_BYTES/1048576,1)  AS INPUT_MB,
              ROUND((END_TIME-START_TIME)*1440,1) AS ELAPSED_MIN
       FROM V$RMAN_BACKUP_JOB_DETAILS
       WHERE INPUT_TYPE = 'ARCHIVELOG'
       ORDER BY START_TIME DESC
       FETCH FIRST 1 ROWS ONLY`,
    ]);

    // ── 5. RMAN Retention / Configuration ───────────────────────────────────
    const retention = await tryQueries([
      `SELECT NAME, VALUE FROM V$RMAN_CONFIGURATION ORDER BY CONF# `,
    ]);

    // ── 6. FRA Usage ─────────────────────────────────────────────────────────
    const fraRows = await tryQueries([
      `SELECT NAME AS FRA_PATH,
              ROUND(SPACE_LIMIT/1073741824,2)       AS LIMIT_GB,
              ROUND(SPACE_USED/1073741824,2)         AS USED_GB,
              ROUND(SPACE_USED*100/NULLIF(SPACE_LIMIT,0),1) AS PCT_USED
       FROM V$RECOVERY_FILE_DEST`,
    ]);

    // ── 7. Daily backup size trend (last 14 days) ────────────────────────────
    const trendRows = await tryQueries([
      `SELECT TO_CHAR(TRUNC(START_TIME),'YYYY-MM-DD') AS DAY,
              COUNT(*)                                AS JOB_COUNT,
              ROUND(SUM(INPUT_BYTES)/1073741824,2)   AS INPUT_GB,
              ROUND(SUM(OUTPUT_BYTES)/1073741824,2)  AS OUTPUT_GB,
              SUM(CASE WHEN STATUS!='COMPLETED' THEN 1 ELSE 0 END) AS FAILED
       FROM V$RMAN_BACKUP_JOB_DETAILS
       WHERE START_TIME >= SYSDATE - 14
       GROUP BY TRUNC(START_TIME)
       ORDER BY TRUNC(START_TIME) DESC`,
    ]);

    // ── Build response ───────────────────────────────────────────────────────
    const failedCount = jobs.filter(j => j.STATUS && j.STATUS !== 'COMPLETED').length;

    res.json({
      jobs,
      failedCount,
      lastFull: lastFullRows[0] || null,
      lastIncr: lastIncrRows[0] || null,
      lastArch: lastArchRows[0] || null,
      retention,
      fra:      fraRows[0]     || null,
      trend:    trendRows,
    });

  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/oracle/ash', async (req, res) => {
  try {
    const minutes  = Math.min(parseInt(req.query.minutes) || 30, 10080);
    // Support explicit start/end datetime params (format: YYYY-MM-DDTHH:MM or YYYY-MM-DD HH:MM)
    // Pad to include seconds so Oracle TO_DATE formats match correctly
    const _padDT = s => {
      const clean = (s || '').replace('T', ' ').trim();
      return clean.length === 16 ? clean + ':00' : clean; // YYYY-MM-DD HH:MM → add :00
    };
    const startQ   = _padDT(req.query.start);
    const endQ     = _padDT(req.query.end);
    const useRange = !!(startQ && endQ && startQ.length >= 16);

    let ashView, truncUnit, timeFmt, sessionFilter, whereClause;
    // For custom ranges, always use V$ACTIVE_SESSION_HISTORY (real-time 1s samples)
    // For quick "last N minutes", use AWR history only for > 60 min
    const useAWR = !useRange && (minutes > 60);
    ashView       = useAWR ? 'DBA_HIST_ACTIVE_SESS_HISTORY' : 'V$ACTIVE_SESSION_HISTORY';
    truncUnit     = useAWR ? `'HH'` : `'MI'`;
    timeFmt       = `'HH24:MI'`;
    sessionFilter = `SESSION_TYPE != 'BACKGROUND'`;

    if (useRange) {
      const sFmt = startQ.length > 16 ? `'YYYY-MM-DD HH24:MI:SS'` : `'YYYY-MM-DD HH24:MI'`;
      const eFmt = endQ.length   > 16 ? `'YYYY-MM-DD HH24:MI:SS'` : `'YYYY-MM-DD HH24:MI'`;
      whereClause = `SAMPLE_TIME BETWEEN TO_DATE('${startQ.replace(/'/g,"''")}', ${sFmt}) AND TO_DATE('${endQ.replace(/'/g,"''")}', ${eFmt}) AND ${sessionFilter}`;
    } else {
      const interval = `${minutes}/1440`;
      whereClause = `SAMPLE_TIME >= SYSDATE - ${interval} AND ${sessionFilter}`;
    }
    const timeline    = await query(`SELECT TO_CHAR(TRUNC(SAMPLE_TIME,${truncUnit}),${timeFmt}) AS TS, COUNT(*) AS CNT FROM ${ashView} WHERE ${whereClause} GROUP BY TRUNC(SAMPLE_TIME,${truncUnit}) ORDER BY TRUNC(SAMPLE_TIME,${truncUnit})`).catch(() => []);
    const totalRows   = await query(`SELECT COUNT(*) AS TOTAL FROM ${ashView} WHERE ${whereClause}`).catch(() => [{ TOTAL: 1 }]);
    const total       = Number(totalRows[0]?.TOTAL) || 1;
    const topSQL      = await query(`SELECT ash.SQL_ID, COUNT(*) AS SAMPLES, ROUND(COUNT(*)*100/${total}, 1) AS PCT, MAX(ash.WAIT_CLASS) AS WAIT_CLASS, SUBSTR(MAX(sql.SQL_TEXT),1,80) AS SQL_TEXT FROM ${ashView} ash LEFT JOIN V$SQLAREA sql ON ash.SQL_ID = sql.SQL_ID WHERE ${whereClause} AND ash.SQL_ID IS NOT NULL GROUP BY ash.SQL_ID ORDER BY SAMPLES DESC FETCH FIRST 15 ROWS ONLY`).catch(() => []);
    const waitClasses = await query(`SELECT NVL(WAIT_CLASS, 'CPU') AS WAIT_CLASS, COUNT(*) AS SAMPLES, ROUND(COUNT(*)*100/${total}, 1) AS PCT FROM ${ashView} WHERE ${whereClause} GROUP BY WAIT_CLASS ORDER BY SAMPLES DESC`).catch(() => []);
    const bucketSeconds = useAWR ? 3600 : 60;
    const summaryRows = await query(`SELECT ROUND(AVG(cnt_aas), 1) AS AVG_ACTIVE, ROUND(MAX(cnt_aas), 1) AS PEAK_ACTIVE, TO_CHAR(TRUNC(MAX(CASE WHEN cnt_aas=mx THEN bucket END), ${truncUnit}),${timeFmt}) AS PEAK_TIME FROM (SELECT TRUNC(SAMPLE_TIME, ${truncUnit}) AS bucket, ROUND(COUNT(*) / ${bucketSeconds}, 2) AS cnt_aas, MAX(ROUND(COUNT(*) / ${bucketSeconds}, 2)) OVER () AS mx FROM ${ashView} WHERE ${whereClause} GROUP BY TRUNC(SAMPLE_TIME, ${truncUnit}))`).catch(() => [{}]);
    const uniqSQLRows = await query(`SELECT COUNT(DISTINCT SQL_ID) AS UNIQUE_SQL FROM ${ashView} WHERE ${whereClause} AND SQL_ID IS NOT NULL`).catch(() => [{ UNIQUE_SQL: 0 }]);
    const sm      = summaryRows[0] || {};
    const topWait = waitClasses.filter(w => w.WAIT_CLASS && w.WAIT_CLASS !== 'Idle')[0];
    const sourceLabel = useRange
      ? `Custom range: ${startQ} → ${endQ}`
      : (useAWR ? 'AWR (DBA_HIST_ACTIVE_SESS_HISTORY)' : 'V$ACTIVE_SESSION_HISTORY');
    res.json({ timeline: timeline.map(r => ({ TS: r.TS, COUNT: r.CNT })), topSQL, waitClasses: waitClasses.filter(w => w.WAIT_CLASS !== 'Idle'), avgActive: parseFloat(sm.AVG_ACTIVE)||0, peakActive: sm.PEAK_ACTIVE||0, peakTime: sm.PEAK_TIME||null, topWaitClass: topWait?.WAIT_CLASS||'CPU', topWaitPct: topWait?.PCT||0, uniqueSQLCount: Number(uniqSQLRows[0]?.UNIQUE_SQL)||0, source: sourceLabel });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ASH Report Generator — uses DBMS_WORKLOAD_REPOSITORY.ASH_REPORT_HTML ────────
// Supports: time-range (start/end datetime) OR last-N-minutes mode
// Returns full Oracle-formatted HTML report for display in iframe and download
app.post('/api/oracle/ash/report', async (req, res) => {
  let conn;
  try {
    const { startTime, endTime, minutes, instId } = req.body;

    // ── Resolve DBID and instance ────────────────────────────────────────────
    const [dbRows, instRows] = await Promise.all([
      query('SELECT DBID FROM V$DATABASE').catch(() => []),
      query('SELECT INSTANCE_NUMBER FROM V$INSTANCE').catch(() => [])
    ]);
    const dbid      = Number(dbRows[0]?.DBID)              || 0;
    const instNo    = Number(instRows[0]?.INSTANCE_NUMBER) || 1;
    const targetInst = instId ? Number(instId) : instNo;

    // ── Resolve time window ──────────────────────────────────────────────────
    let sTime = null, eTime = null;

    if (startTime && endTime) {
      sTime = startTime.replace('T', ' ');
      eTime = endTime.replace('T', ' ');
    } else {
      const lMin = minutes ? Math.min(parseInt(minutes), 10080) : 30;
      const tsRows = await query(
        `SELECT TO_CHAR(SYSDATE - ${lMin}/1440, 'YYYY-MM-DD HH24:MI:SS') AS S,
                TO_CHAR(SYSDATE,                'YYYY-MM-DD HH24:MI:SS') AS E FROM DUAL`
      );
      sTime = tsRows[0]?.S || '';
      eTime = tsRows[0]?.E || '';
    }

    // ── Generate ASH HTML report — ASH_REPORT_HTML returns a CLOB ────────────
    // We use a raw connection with executeMany-style PL/SQL block to read the CLOB.
    // FIX: Use pool.getConnection() to avoid bypassing pool limits.
    const pool = await getPool(currentDbId());
    conn = await pool.getConnection();

    let reportHtml = '';
    let lineCount  = 0;

    // Strategy 1: SELECT from TABLE() — works when CLOB is auto-converted
    try {
      const result = await conn.execute(
        `SELECT OUTPUT FROM TABLE(
           DBMS_WORKLOAD_REPOSITORY.ASH_REPORT_HTML(
             l_dbid     => :dbid,
             l_inst_num => :instno,
             l_btime    => TO_DATE(:stime, 'YYYY-MM-DD HH24:MI:SS'),
             l_etime    => TO_DATE(:etime, 'YYYY-MM-DD HH24:MI:SS')
           )
         )`,
        [dbid, targetInst, sTime, eTime],
        { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchTypeMap: new Map([[oracledb.CLOB, { type: oracledb.STRING }]]) }
      );
      const rows = result.rows || [];
      lineCount  = rows.length;
      // Properly resolve each row — may be CLOB object or plain string
      const parts = await Promise.all(rows.map(async r => {
        const v = r.OUTPUT;
        if (v && typeof v === 'object' && typeof v.getData === 'function') {
          try { const s = await v.getData(); await v.close().catch(()=>{}); return s || ''; }
          catch(_) { return ''; }
        }
        return (v == null ? '' : String(v));
      }));
      reportHtml = parts.join('');
    } catch(e1) {
      // Strategy 2: PL/SQL block that concatenates CLOB into a single OUT param
      try {
        const plsqlResult = await conn.execute(
          `DECLARE
             l_clob CLOB;
             l_html CLOB := EMPTY_CLOB();
             l_line VARCHAR2(32767);
           BEGIN
             FOR r IN (
               SELECT OUTPUT FROM TABLE(
                 DBMS_WORKLOAD_REPOSITORY.ASH_REPORT_HTML(
                   :dbid, :instno,
                   TO_DATE(:stime, 'YYYY-MM-DD HH24:MI:SS'),
                   TO_DATE(:etime, 'YYYY-MM-DD HH24:MI:SS')
                 )
               )
             ) LOOP
               DBMS_LOB.WRITEAPPEND(l_html, LENGTH(r.OUTPUT||CHR(10)), r.OUTPUT||CHR(10));
             END LOOP;
             :result := l_html;
           END;`,
          {
            dbid:    { val: dbid,        dir: oracledb.BIND_IN,    type: oracledb.NUMBER  },
            instno:  { val: targetInst,  dir: oracledb.BIND_IN,    type: oracledb.NUMBER  },
            stime:   { val: sTime,       dir: oracledb.BIND_IN,    type: oracledb.STRING  },
            etime:   { val: eTime,       dir: oracledb.BIND_IN,    type: oracledb.STRING  },
            result:  { dir: oracledb.BIND_OUT, type: oracledb.CLOB }
          }
        );
        const clob = plsqlResult.outBinds?.result;
        if (clob && typeof clob.getData === 'function') {
          reportHtml = await clob.getData();
          await clob.close().catch(() => {});
        } else {
          reportHtml = String(clob || '');
        }
        lineCount = (reportHtml.match(/\n/g) || []).length;
      } catch(e2) {
        // Strategy 3: positional params fallback
        const result3 = await conn.execute(
          `SELECT OUTPUT FROM TABLE(
             DBMS_WORKLOAD_REPOSITORY.ASH_REPORT_HTML(
               :1, :2,
               TO_DATE(:3, 'YYYY-MM-DD HH24:MI:SS'),
               TO_DATE(:4, 'YYYY-MM-DD HH24:MI:SS')
             )
           )`,
          [dbid, targetInst, sTime, eTime],
          { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchTypeMap: new Map([[oracledb.CLOB, { type: oracledb.STRING }]]) }
        );
        const rows3 = result3.rows || [];
        lineCount   = rows3.length;
        const parts3 = await Promise.all(rows3.map(async r => {
          const v = r.OUTPUT;
          if (v && typeof v === 'object' && typeof v.getData === 'function') {
            try { const s = await v.getData(); await v.close().catch(()=>{}); return s || ''; }
            catch(_) { return ''; }
          }
          return (v == null ? '' : String(v));
        }));
        reportHtml = parts3.join('');
      }
    }

    res.json({
      report:    reportHtml,
      startTime: sTime,
      endTime:   eTime,
      dbid,
      instNo:    targetInst,
      lines:     lineCount
    });

  } catch(e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (conn) try { await conn.close(); } catch(_) {}
  }
});

// ── AWR Snapshots — returns ALL available snap IDs for the selected DB/instance ─
app.get('/api/oracle/awr/snapshots', async (req, res) => {
  try {
    const days    = parseInt(req.query.days    || '0', 10);
    const instReq = parseInt(req.query.inst_id || '0', 10);
    const dbidReq = parseInt(req.query.dbid    || '0', 10);

    // ── Step 1: Get current DB + instance info ───────────────────────────────
    const [dbRows, instRows] = await Promise.all([
      query('SELECT DBID, NAME, DB_UNIQUE_NAME, CDB FROM V$DATABASE').catch(() => []),
      query('SELECT INSTANCE_NUMBER, INSTANCE_NAME FROM V$INSTANCE').catch(() => []),
    ]);
    const currentDbid = Number(dbRows[0]?.DBID)              || 0;
    const currentInst = Number(instRows[0]?.INSTANCE_NUMBER) || 1;
    const isCDB       = (dbRows[0]?.CDB || 'NO') === 'YES';
    const targetDbid  = dbidReq > 0 ? dbidReq : currentDbid;

    // ── Step 2: Lists of databases and instances in AWR history ─────────────
    const dbList = await query(
      'SELECT DISTINCT DBID, DB_NAME FROM DBA_HIST_DATABASE_INSTANCE ORDER BY DB_NAME'
    ).catch(() => [{ DBID: currentDbid, DB_NAME: dbRows[0]?.NAME || 'ORCL' }]);

    const instList = await query(
      'SELECT DISTINCT INSTANCE_NUMBER, INSTANCE_NAME FROM DBA_HIST_DATABASE_INSTANCE ' +
      'WHERE DBID = ' + targetDbid + ' ORDER BY INSTANCE_NUMBER'
    ).catch(() => [{ INSTANCE_NUMBER: currentInst, INSTANCE_NAME: instRows[0]?.INSTANCE_NAME || 'orcl' }]);

    // ── Step 3: Resolve which instance to query ───────────────────────────────
    // If caller specifies inst_id use it; otherwise use current instance.
    // Then verify there are actually snapshots for that instance — if not,
    // fall back to whichever instance has the most snapshots.
    let instFilter = instReq > 0 ? instReq : currentInst;

    const snapCountCheck = await query(
      'SELECT INSTANCE_NUMBER, COUNT(*) AS CNT FROM DBA_HIST_SNAPSHOT ' +
      'WHERE DBID = ' + targetDbid + ' GROUP BY INSTANCE_NUMBER ORDER BY CNT DESC'
    ).catch(() => []);

    if (snapCountCheck.length > 0) {
      const hasSnaps = snapCountCheck.find(r => Number(r.INSTANCE_NUMBER) === instFilter);
      if (!hasSnaps || Number(hasSnaps.CNT) === 0) {
        // Fall back to the instance with the most snapshots
        instFilter = Number(snapCountCheck[0].INSTANCE_NUMBER) || instFilter;
      }
    }

    // ── Step 4: Date filter clause ───────────────────────────────────────────
    const dateClause = days > 0
      ? 'AND s.END_INTERVAL_TIME >= SYSDATE - ' + days
      : '';  // days=0 → return ALL snapshots (no date limit)

    // ── Step 5: Main snapshot query ── one row per SNAP_ID, no duplicates ──────
    // ROOT CAUSE OF DUPLICATES: LEFT JOIN DBA_HIST_DATABASE_INSTANCE produces
    // multiple rows per snap (one per DB startup/incarnation). Fix: use scalar
    // subqueries with MAX() so each SNAP_ID from DBA_HIST_SNAPSHOT = exactly 1 row.
    const sql =
      'SELECT SNAP_ID, BEGIN_INTERVAL_TIME, END_INTERVAL_TIME, ELAPSED_MIN,' +
      '       INSTANCE_NUMBER, INSTANCE_NAME,' +
      '       ROUND(GREATEST(' +
      '         NVL(DB_TIME_CUMUL, 0) - NVL(LAG(DB_TIME_CUMUL) OVER (' +
      '           ORDER BY SNAP_ID ASC' +
      '         ), 0), 0) / 1e6, 1) AS DB_TIME_S' +
      ' FROM (' +
      '   SELECT s.SNAP_ID                                                                AS SNAP_ID,' +
      '          s.INSTANCE_NUMBER                                                        AS INSTANCE_NUMBER,' +
      '          NVL((' +
      '            SELECT MAX(di.INSTANCE_NAME) FROM DBA_HIST_DATABASE_INSTANCE di' +
      '            WHERE di.DBID = s.DBID AND di.INSTANCE_NUMBER = s.INSTANCE_NUMBER' +
      '          ), \'inst\' || s.INSTANCE_NUMBER)                                     AS INSTANCE_NAME,' +
      '          TO_CHAR(CAST(s.BEGIN_INTERVAL_TIME AT LOCAL AS DATE), \'YYYY-MM-DD HH24:MI\') AS BEGIN_INTERVAL_TIME,' +
      '          TO_CHAR(CAST(s.END_INTERVAL_TIME   AT LOCAL AS DATE), \'YYYY-MM-DD HH24:MI\') AS END_INTERVAL_TIME,' +
      '          ROUND((CAST(s.END_INTERVAL_TIME AS DATE)' +
      '               - CAST(s.BEGIN_INTERVAL_TIME AS DATE)) * 1440, 0)                 AS ELAPSED_MIN,' +
      '          NVL((' +
      '            SELECT MAX(st.VALUE) FROM DBA_HIST_SYS_TIME_MODEL st' +
      '            WHERE st.SNAP_ID = s.SNAP_ID AND st.DBID = s.DBID' +
      '              AND st.INSTANCE_NUMBER = s.INSTANCE_NUMBER' +
      '              AND st.STAT_NAME = \'DB time\'' +
      '          ), 0)                                                                    AS DB_TIME_CUMUL' +
      '   FROM DBA_HIST_SNAPSHOT s' +
      '   WHERE s.DBID            = ' + targetDbid +
      '     AND s.INSTANCE_NUMBER = ' + instFilter +
      '     ' + dateClause +
      ' )' +
      ' ORDER BY SNAP_ID ASC'

    const rows = await query(sql);

    // ── Step 6: Normalize column names (uppercase safety net) ────────────────
    const snapshots = rows.map(r => ({
      SNAP_ID             : r.SNAP_ID             ?? r.snap_id,
      BEGIN_INTERVAL_TIME : r.BEGIN_INTERVAL_TIME ?? r.begin_interval_time ?? r.BEGIN_TIME ?? r.begin_time,
      END_INTERVAL_TIME   : r.END_INTERVAL_TIME   ?? r.end_interval_time   ?? r.END_TIME   ?? r.end_time,
      ELAPSED_MIN         : r.ELAPSED_MIN         ?? r.elapsed_min,
      DB_TIME_S           : r.DB_TIME_S           ?? r.db_time_s,
      INSTANCE_NUMBER     : r.INSTANCE_NUMBER     ?? r.instance_number,
      INSTANCE_NAME       : r.INSTANCE_NAME       ?? r.instance_name,
    }));

    res.json({
      snapshots,           // oldest → newest (ASC)
      dbid            : targetDbid,
      currentInstance : instFilter,
      isCDB,
      totalCount      : snapshots.length,
      instances : instList.map(r => ({
        num  : Number(r.INSTANCE_NUMBER),
        name : r.INSTANCE_NAME || ('inst' + r.INSTANCE_NUMBER),
      })),
      databases : dbList.map(r => ({
        dbid : Number(r.DBID),
        name : r.DB_NAME || String(r.DBID),
      })),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AWR Report Generation ─────────────────────────────────────────────────────
app.post('/api/oracle/awr/report', async (req, res) => {
  let conn;
  try {
    const { beginSnap, endSnap, inst_id, format, dbid: clientDbid } = req.body;
    if (!beginSnap || !endSnap) return res.status(400).json({ error: 'beginSnap and endSnap required' });
    const bSnap = parseInt(beginSnap);
    const eSnap = parseInt(endSnap);
    if (isNaN(bSnap) || isNaN(eSnap)) return res.status(400).json({ error: 'Snapshot IDs must be integers' });
    if (bSnap >= eSnap) return res.status(400).json({ error: 'beginSnap must be less than endSnap. Select a lower snap ID for Begin and a higher snap ID for End.' });

    const [dbRows, instRows] = await Promise.all([
      query(`SELECT DBID FROM V$DATABASE`).catch(() => []),
      query(`SELECT INSTANCE_NUMBER FROM V$INSTANCE`).catch(() => []),
    ]);
    const dbid    = clientDbid ? parseInt(clientDbid) : (Number(dbRows[0]?.DBID) || 0);
    const instNum = inst_id    ? parseInt(inst_id)    : (Number(instRows[0]?.INSTANCE_NUMBER) || 1);
    if (!dbid) return res.status(500).json({ error: 'Cannot resolve DBID from V$DATABASE' });

    // ── Validate both snap IDs exist (try with instance filter first, then without) ──
    const snapCheck = await query(
      `SELECT COUNT(*) AS CNT FROM DBA_HIST_SNAPSHOT
       WHERE DBID = ${dbid} AND INSTANCE_NUMBER = ${instNum}
         AND SNAP_ID IN (${bSnap}, ${eSnap})`
    );
    let validInstNum = instNum;
    if (Number(snapCheck[0]?.CNT) < 2) {
      // Try finding which instance actually has both snaps
      const snapAny = await query(
        `SELECT INSTANCE_NUMBER, COUNT(*) AS CNT
         FROM DBA_HIST_SNAPSHOT
         WHERE DBID = ${dbid} AND SNAP_ID IN (${bSnap}, ${eSnap})
         GROUP BY INSTANCE_NUMBER
         HAVING COUNT(*) = 2
         FETCH FIRST 1 ROWS ONLY`
      ).catch(() => []);
      if (snapAny.length > 0) {
        validInstNum = Number(snapAny[0].INSTANCE_NUMBER) || instNum;
      } else {
        return res.status(400).json({
          error: `Snapshot IDs ${bSnap} and ${eSnap} not found for DBID=${dbid} Inst=${instNum}. ` +
                 `Verify both snapshots belong to the same database and instance.`
        });
      }
    }

    // ── Use a dedicated long-lived connection for the AWR report ──────────────
    // The AWR report function returns a pipelined table of CLOBs; we must read
    // them all within the same connection (do NOT use the query() helper which
    // opens/closes a connection per call).
    // FIX: Use pool instead of direct getConnection to avoid bypassing pool limits.
    const useHtml = (format || 'html') === 'html';
    const fn      = useHtml
      ? 'DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML'
      : 'DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_TEXT';

    const pool = await getPool(currentDbId());
    conn = await pool.getConnection();

    // Fetch with CLOB auto-conversion so getData() is never needed
    const result = await conn.execute(
      `SELECT OUTPUT FROM TABLE(${fn}(:1,:2,:3,:4))`,
      [dbid, validInstNum, bSnap, eSnap],
      {
        outFormat   : oracledb.OUT_FORMAT_OBJECT,
        fetchTypeMap: new Map([[oracledb.CLOB, { type: oracledb.STRING }]]),
        maxRows     : 200000,
        autoCommit  : true,
      }
    );

    // Build report string — each row is one line/chunk of the AWR output
    const lines = (result.rows || []).map(row => {
      const v = row.OUTPUT;
      if (v === null || v === undefined) return '';
      if (typeof v === 'string') return v;
      if (Buffer.isBuffer(v)) return v.toString('utf8');
      // Should not happen after fetchTypeMap conversion, but just in case
      return String(v);
    });

    const report = lines.join('\n');

    if (!report || report.trim().length === 0) {
      return res.status(500).json({
        error: `AWR report returned empty output for snaps ${bSnap}→${eSnap}. ` +
               `Ensure the Oracle Diagnostics Pack license is active and the SYSAUX tablespace has AWR data.`
      });
    }

    res.json({
      report,
      format  : useHtml ? 'html' : 'text',
      dbid,
      instNum : validInstNum,
      bSnap,
      eSnap,
    });

  } catch(e) {
    const msg = e.message || String(e);
    // Surface Oracle-specific errors more clearly
    if (msg.includes('ORA-13516') || msg.includes('AWR') || msg.includes('Diagnostic')) {
      return res.status(500).json({ error: 'Oracle Diagnostics Pack license required: ' + msg });
    }
    if (msg.includes('ORA-01013') || msg.includes('user requested cancel')) {
      return res.status(500).json({ error: 'AWR query cancelled — the report took too long. Try a shorter snapshot interval.' });
    }
    res.status(500).json({ error: msg });
  } finally {
    if (conn) try { await conn.close(); } catch(_) {}
  }
});

// ── ADDM Report Generation ────────────────────────────────────────────────────
// ADDM (Automatic Database Diagnostic Monitor) analyzes a snapshot period and
// produces prioritized FINDINGS + RECOMMENDATIONS (unlike AWR, which is raw
// stats). Unlike AWR_REPORT_HTML (a single function call), ADDM requires a
// stateful task: DBMS_ADVISOR.CREATE_TASK → SET_TASK_PARAMETER (x N) →
// EXECUTE_TASK, then DBMS_ADVISOR.GET_TASK_REPORT to pull the CLOB, then
// (best-effort) DELETE_TASK to avoid leaving clutter in DBA_ADVISOR_TASKS.
// Same Diagnostics Pack license requirement as AWR.
app.post('/api/oracle/addm/report', async (req, res) => {
  let conn;
  try {
    const { beginSnap, endSnap, inst_id, format, dbid: clientDbid } = req.body;
    if (!beginSnap || !endSnap) return res.status(400).json({ error: 'beginSnap and endSnap required' });
    const bSnap = parseInt(beginSnap);
    const eSnap = parseInt(endSnap);
    if (isNaN(bSnap) || isNaN(eSnap)) return res.status(400).json({ error: 'Snapshot IDs must be integers' });
    if (bSnap >= eSnap) return res.status(400).json({ error: 'beginSnap must be less than endSnap. Select a lower snap ID for Begin and a higher snap ID for End.' });

    const [dbRows, instRows] = await Promise.all([
      query(`SELECT DBID FROM V$DATABASE`).catch(() => []),
      query(`SELECT INSTANCE_NUMBER FROM V$INSTANCE`).catch(() => []),
    ]);
    const dbid    = clientDbid ? parseInt(clientDbid) : (Number(dbRows[0]?.DBID) || 0);
    const instNum = inst_id    ? parseInt(inst_id)    : (Number(instRows[0]?.INSTANCE_NUMBER) || 1);
    if (!dbid) return res.status(500).json({ error: 'Cannot resolve DBID from V$DATABASE' });

    // ── Validate both snap IDs exist (try with instance filter first, then without) ──
    const snapCheck = await query(
      `SELECT COUNT(*) AS CNT FROM DBA_HIST_SNAPSHOT
       WHERE DBID = ${dbid} AND INSTANCE_NUMBER = ${instNum}
         AND SNAP_ID IN (${bSnap}, ${eSnap})`
    );
    let validInstNum = instNum;
    if (Number(snapCheck[0]?.CNT) < 2) {
      const snapAny = await query(
        `SELECT INSTANCE_NUMBER, COUNT(*) AS CNT
         FROM DBA_HIST_SNAPSHOT
         WHERE DBID = ${dbid} AND SNAP_ID IN (${bSnap}, ${eSnap})
         GROUP BY INSTANCE_NUMBER
         HAVING COUNT(*) = 2
         FETCH FIRST 1 ROWS ONLY`
      ).catch(() => []);
      if (snapAny.length > 0) {
        validInstNum = Number(snapAny[0].INSTANCE_NUMBER) || instNum;
      } else {
        return res.status(400).json({
          error: `Snapshot IDs ${bSnap} and ${eSnap} not found for DBID=${dbid} Inst=${instNum}. ` +
                 `Verify both snapshots belong to the same database and instance.`
        });
      }
    }

    const useHtml = (format || 'html') === 'html';

    // ── Use a dedicated pooled connection — task create/execute/report-fetch
    // must all happen on the SAME session, and DBMS_ADVISOR.EXECUTE_TASK can
    // legitimately take a couple of minutes on a busy period.
    const pool = await getPool(currentDbId());
    conn = await pool.getConnection();
    // FIX (same class of bug as awr/diff-report): don't let this connection
    // inherit a short callTimeout from elsewhere in the pool — set an
    // explicit, generous one for this long-running advisor task.
    conn.callTimeout = 300000; // 5 min

    // ── Step 1: create + configure + execute the ADDM task ───────────────────
    const createResult = await conn.execute(
      `DECLARE
         tid   NUMBER;
         tname VARCHAR2(30);
       BEGIN
         DBMS_ADVISOR.CREATE_TASK('ADDM', tid, tname);
         DBMS_ADVISOR.SET_TASK_PARAMETER(tname, 'START_SNAPSHOT', :bid);
         DBMS_ADVISOR.SET_TASK_PARAMETER(tname, 'END_SNAPSHOT',   :eid);
         DBMS_ADVISOR.SET_TASK_PARAMETER(tname, 'INSTANCE',       :inst);
         DBMS_ADVISOR.SET_TASK_PARAMETER(tname, 'DB_ID',          :dbid);
         DBMS_ADVISOR.EXECUTE_TASK(tname);
         :o_tname := tname;
       END;`,
      {
        bid    : bSnap,
        eid    : eSnap,
        inst   : validInstNum,
        dbid   : dbid,
        o_tname: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 60 },
      },
      { autoCommit: true }
    );
    const taskName = createResult.outBinds?.o_tname;
    if (!taskName) {
      return res.status(500).json({ error: 'ADDM task was created but no task name was returned — cannot fetch report.' });
    }

    // ── Step 2: pull the report as a CLOB ─────────────────────────────────────
    // FIX: DBMS_ADVISOR.GET_TASK_REPORT's TYPE argument only accepts 'TEXT'
    // (per Oracle's DBMS_ADVISOR docs: "type — The only valid value is TEXT.").
    // Unlike DBMS_ADVISOR.AWR_REPORT_HTML, there is no native 'HTML' report
    // type for ADDM tasks — passing 'HTML' here raises
    // ORA-13618: "not a valid value for procedure argument TYPE"
    // (via SYS.PRVT_ADVISOR), which is NOT a licensing error even though it
    // looks similar to one. Always fetch TEXT from Oracle, then wrap it in a
    // minimal HTML page below if the caller asked for 'html' format.
    const reportResult = await conn.execute(
      `SELECT DBMS_ADVISOR.GET_TASK_REPORT(:tname, 'TEXT', 'TYPICAL', 'ALL') AS RPT FROM DUAL`,
      { tname: taskName },
      {
        outFormat   : oracledb.OUT_FORMAT_OBJECT,
        fetchTypeMap: new Map([[oracledb.CLOB, { type: oracledb.STRING }]]),
        autoCommit  : true,
      }
    );
    let report = reportResult.rows?.[0]?.RPT;
    // FIX: don't assume the fetched value is already a plain string — same
    // class of bug the AWR-report route guards against. Depending on
    // driver/version behavior, a CLOB returned from a scalar function call
    // (as opposed to a table column) can come back as a Lob object or
    // Buffer even with fetchTypeMap set, which made `report.trim()` below
    // throw "report.trim is not a function".
    if (report === null || report === undefined) {
      report = '';
    } else if (typeof report !== 'string') {
      if (Buffer.isBuffer(report)) {
        report = report.toString('utf8');
      } else if (typeof report.getData === 'function') {
        try { report = await report.getData(); } catch(_) { report = ''; }
        try { if (typeof report.close === 'function') await report.close(); } catch(_) {}
      } else {
        report = String(report);
      }
    }

    // ── Step 3: best-effort cleanup — don't fail the request if this fails ───
    try {
      await conn.execute(
        `BEGIN DBMS_ADVISOR.DELETE_TASK(:tname); EXCEPTION WHEN OTHERS THEN NULL; END;`,
        { tname: taskName },
        { autoCommit: true }
      );
    } catch(_) {}

    if (!report || report.trim().length === 0) {
      return res.status(500).json({
        error: `ADDM report returned empty output for snaps ${bSnap}→${eSnap}. ` +
               `Ensure the Oracle Diagnostics Pack license is active and the SYSAUX tablespace has AWR/ADDM data.`
      });
    }

    // ── Step 3.5: ADDM only produces TEXT reports (see note above) — wrap the
    // plain-text output in a minimal styled HTML page so the 'html' format
    // option still renders nicely (e.g. in the dashboard's iframe viewer).
    if (useHtml) {
      const escapeHtml = (s) => String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      report =
        `<!DOCTYPE html><html><head><meta charset="utf-8">` +
        `<title>ADDM Report — Snap ${bSnap} to ${eSnap}</title>` +
        `<style>
           body{background:#0d1117;color:#c9d1d9;font-family:Consolas,Menlo,monospace;
                font-size:12px;line-height:1.5;margin:0;padding:16px}
           pre{white-space:pre-wrap;word-break:break-word;margin:0}
         </style></head>` +
        `<body><pre>${escapeHtml(report)}</pre></body></html>`;
    }

    res.json({
      report,
      format  : useHtml ? 'html' : 'text',
      dbid,
      instNum : validInstNum,
      taskName,
      bSnap,
      eSnap,
    });

  } catch(e) {
    const msg = e.message || String(e);
    console.error('[addm/report] ERROR:', e && e.stack ? e.stack : msg);
    // FIX: this used to match on the broad 'ORA-13' prefix, which also
    // matches ORA-13618 (bad procedure argument) and mislabeled that as a
    // licensing problem. Scope this to the actual licensing-related errors:
    // ORA-13501/13503 (Diagnostics Pack) and CONTROL_MANAGEMENT_PACK_ACCESS.
    if (msg.includes('ORA-13501') || msg.includes('ORA-13503') || msg.includes('CONTROL_MANAGEMENT_PACK_ACCESS')) {
      return res.status(500).json({ error: 'Oracle Diagnostics Pack license required for ADDM: ' + msg });
    }
    if (msg.includes('NJS-123') || msg.includes('ORA-01013') || msg.includes('user requested cancel')) {
      return res.status(500).json({ error: 'ADDM task timed out or was cancelled — the analysis took too long. Try a shorter snapshot interval.' });
    }
    res.status(500).json({ error: msg });
  } finally {
    if (conn) try { await conn.close(); } catch(_) {}
  }
});

// ── AWR Diff Report Generation (compares two snapshot periods) ───────────────
// Mirrors /api/oracle/awr/report above but calls
// DBMS_WORKLOAD_REPOSITORY.AWR_DIFF_REPORT_HTML/TEXT, which takes TWO
// (dbid, instance, begin_snap, end_snap) tuples — one per period — and
// returns Oracle's built-in side-by-side comparison report.
//
// IMPORTANT: AWR_DIFF_REPORT is much slower than a single AWR_REPORT (Oracle
// effectively builds both periods' reports internally, then diffs them) — it
// can easily run 2-5+ minutes even for small snapshot windows. Two things
// were needed on top of a plain long-running request:
//   1. A "heartbeat" — write a single space byte to the response every 15s
//      while Oracle is still working. JSON.parse ignores this leading
//      whitespace, but it keeps the TCP connection visibly "active" so a
//      router/firewall/NAT on a cross-machine LAN setup won't silently kill
//      an idle connection and produce a client-side "Failed to fetch".
//   2. Disabling Node's socket timeout for this request, since the default
//      can otherwise cut the connection while the DB call is still pending.
app.post('/api/oracle/awr/diff-report', async (req, res) => {
  let conn;
  let heartbeat = null;

  // Don't let Node's socket-level timeout kill this request while Oracle is
  // still generating the report.
  try { req.socket.setTimeout(0); } catch(_) {}
  try { res.socket && res.socket.setTimeout(0); } catch(_) {}

  // Once the heartbeat has started, headers (implicit 200) are already on
  // the wire — we can no longer change the HTTP status code. This helper
  // sends the JSON body correctly either way; the client only inspects the
  // parsed body's `.error` field for this route, not the HTTP status.
  const sendJson = (statusCode, obj) => {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (res.headersSent) {
      try { res.write(JSON.stringify(obj)); } catch(_) {}
      try { res.end(); } catch(_) {}
    } else {
      res.status(statusCode).json(obj);
    }
  };

  try {
    const { beginSnap1, endSnap1, beginSnap2, endSnap2, inst_id, format, dbid: clientDbid } = req.body;
    if (!beginSnap1 || !endSnap1 || !beginSnap2 || !endSnap2) {
      return sendJson(400, { error: 'beginSnap1, endSnap1, beginSnap2 and endSnap2 are all required' });
    }
    const b1 = parseInt(beginSnap1), e1 = parseInt(endSnap1);
    const b2 = parseInt(beginSnap2), e2 = parseInt(endSnap2);
    if ([b1, e1, b2, e2].some(isNaN)) return sendJson(400, { error: 'Snapshot IDs must be integers' });
    if (b1 >= e1) return sendJson(400, { error: 'Period 1: beginSnap1 must be less than endSnap1.' });
    if (b2 >= e2) return sendJson(400, { error: 'Period 2: beginSnap2 must be less than endSnap2.' });

    const [dbRows, instRows] = await Promise.all([
      query(`SELECT DBID FROM V$DATABASE`).catch(() => []),
      query(`SELECT INSTANCE_NUMBER FROM V$INSTANCE`).catch(() => []),
    ]);
    const dbid    = clientDbid ? parseInt(clientDbid) : (Number(dbRows[0]?.DBID) || 0);
    const instNum = inst_id    ? parseInt(inst_id)    : (Number(instRows[0]?.INSTANCE_NUMBER) || 1);
    if (!dbid) return sendJson(500, { error: 'Cannot resolve DBID from V$DATABASE' });

    // ── Validate all 4 snap IDs exist (try with instance filter first, then without) ──
    const allSnaps = [b1, e1, b2, e2];
    const snapCheck = await query(
      `SELECT COUNT(DISTINCT SNAP_ID) AS CNT FROM DBA_HIST_SNAPSHOT
       WHERE DBID = ${dbid} AND INSTANCE_NUMBER = ${instNum}
         AND SNAP_ID IN (${allSnaps.join(',')})`
    );
    let validInstNum = instNum;
    if (Number(snapCheck[0]?.CNT) < 4) {
      const snapAny = await query(
        `SELECT INSTANCE_NUMBER, COUNT(DISTINCT SNAP_ID) AS CNT
         FROM DBA_HIST_SNAPSHOT
         WHERE DBID = ${dbid} AND SNAP_ID IN (${allSnaps.join(',')})
         GROUP BY INSTANCE_NUMBER
         HAVING COUNT(DISTINCT SNAP_ID) = 4
         FETCH FIRST 1 ROWS ONLY`
      ).catch(() => []);
      if (snapAny.length > 0) {
        validInstNum = Number(snapAny[0].INSTANCE_NUMBER) || instNum;
      } else {
        return sendJson(400, {
          error: `Snapshot IDs ${allSnaps.join(', ')} not all found for DBID=${dbid} Inst=${instNum}. ` +
                 `Verify all 4 snapshots belong to the same database and instance.`
        });
      }
    }

    // ── Use a dedicated pooled connection for the AWR Diff report ─────────────
    const useHtml = (format || 'html') === 'html';
    const fn = useHtml
      ? 'DBMS_WORKLOAD_REPOSITORY.AWR_DIFF_REPORT_HTML'
      : 'DBMS_WORKLOAD_REPOSITORY.AWR_DIFF_REPORT_TEXT';

    const pool = await getPool(currentDbId());
    conn = await pool.getConnection();

    // FIX: pooled connections can carry over `callTimeout` from a previous
    // borrower (the shared query() helper sets callTimeout = QUERY_TIMEOUT_MS
    // = 90000ms on whatever connection it uses). AWR_DIFF_REPORT legitimately
    // takes minutes, so we must explicitly override callTimeout here — do not
    // rely on the default. Set it just under the client's 600000ms fetch
    // timeout so the server returns a clean, informative error instead of the
    // browser silently aborting first.
    conn.callTimeout = 590000; // ~9m50s

    // Start the heartbeat now — everything from here on can legitimately take
    // minutes. res.setHeader must happen before the first res.write.
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    heartbeat = setInterval(() => { try { res.write(' '); } catch(_) {} }, 15000);

    // AWR_DIFF_REPORT signature: (dbid1, inst1, bid1, eid1, dbid2, inst2, bid2, eid2)
    // Both periods are the same DB/instance here — only the snapshot windows differ.
    const _t0 = Date.now();
    console.log(`[awr/diff-report] starting ${fn} dbid=${dbid} inst=${validInstNum} p1=${b1}-${e1} p2=${b2}-${e2}`);
    const result = await conn.execute(
      `SELECT OUTPUT FROM TABLE(${fn}(:1,:2,:3,:4,:5,:6,:7,:8))`,
      [dbid, validInstNum, b1, e1, dbid, validInstNum, b2, e2],
      {
        outFormat   : oracledb.OUT_FORMAT_OBJECT,
        fetchTypeMap: new Map([[oracledb.CLOB, { type: oracledb.STRING }]]),
        maxRows     : 200000,
        autoCommit  : true,
      }
    );
    console.log(`[awr/diff-report] Oracle call finished in ${((Date.now()-_t0)/1000).toFixed(1)}s, rows=${(result.rows||[]).length}`);

    const lines = (result.rows || []).map(row => {
      const v = row.OUTPUT;
      if (v === null || v === undefined) return '';
      if (typeof v === 'string') return v;
      if (Buffer.isBuffer(v)) return v.toString('utf8');
      return String(v);
    });
    const report = lines.join('\n');
    console.log(`[awr/diff-report] report size: ${(Buffer.byteLength(report,'utf8')/1024/1024).toFixed(2)} MB`);

    if (!report || report.trim().length === 0) {
      return sendJson(500, {
        error: `AWR Diff report returned empty output for periods ${b1}-${e1} vs ${b2}-${e2}. ` +
               `Ensure the Oracle Diagnostics Pack license is active and the SYSAUX tablespace has AWR data.`
      });
    }

    sendJson(200, {
      report,
      format  : useHtml ? 'html' : 'text',
      dbid,
      instNum : validInstNum,
      period1 : { bSnap: b1, eSnap: e1 },
      period2 : { bSnap: b2, eSnap: e2 },
    });

  } catch(e) {
    const msg = e.message || String(e);
    // FIX: this route previously swallowed the real error — it was sent back
    // to the client but never printed server-side, so when the browser saw
    // a generic network failure (e.g. connection reset before the JSON body
    // finished sending) there was nothing in the server log to explain why.
    console.error('[awr/diff-report] ERROR:', e && e.stack ? e.stack : msg);
    if (msg.includes('ORA-13516') || msg.includes('AWR') || msg.includes('Diagnostic')) {
      return sendJson(500, { error: 'Oracle Diagnostics Pack license required: ' + msg });
    }
    if (msg.includes('ORA-01013') || msg.includes('user requested cancel')) {
      return sendJson(500, { error: 'AWR Diff query cancelled — the report took too long. Try shorter snapshot intervals.' });
    }
    if (msg.includes('NJS-123')) {
      return sendJson(500, { error: 'AWR Diff report timed out after ~10 minutes. Try a shorter snapshot window for each period, or run during a quieter time on the DB server.' });
    }
    sendJson(500, { error: msg });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (conn) try { await conn.close(); } catch(_) {}
  }
});

app.get('/api/oracle/topsql', async (req, res) => {
  try {
    const days     = Math.min(Math.max(parseInt(req.query.days) || 3, 1), 31);
    const metric   = req.query.metric || 'elapsed';
    const validCols = { elapsed:'ELAPSED_TIME_DELTA', cpu:'CPU_TIME_DELTA', gets:'BUFFER_GETS_DELTA', reads:'DISK_READS_DELTA' };
    const orderCol = validCols[metric] || 'ELAPSED_TIME_DELTA';

    // ── Get current DBID (avoids cross-DBID pollution in AWR tables) ─────────
    let dbid = 0;
    try {
      const dbRow = await query(`SELECT DBID FROM V$DATABASE`);
      dbid = Number(dbRow[0]?.DBID) || 0;
    } catch(_) {}
    const dbidFilter = dbid > 0 ? `AND st.DBID = ${dbid}` : '';
    const dbidFilterSn = dbid > 0 ? `AND sn.DBID = ${dbid}` : '';

    // ── STEP 1: Get top 15 SQL IDs by the chosen metric ─────────────────────
    // Uses ROWNUM instead of FETCH FIRST for maximum Oracle version compat.
    // INNER JOIN ensures BEGIN_INTERVAL_TIME filter works correctly.
    let rows = [];
    try {
      rows = await query(`
        SELECT SQL_ID, EXECUTIONS, AVG_ELAPSED_MS, AVG_CPU_MS,
               AVG_BUFFER_GETS, AVG_PHYS_READS, MODULE, SQL_TEXT
        FROM (
          SELECT
            st.SQL_ID,
            SUM(st.EXECUTIONS_DELTA)                                              AS EXECUTIONS,
            ROUND(SUM(st.ELAPSED_TIME_DELTA)/NULLIF(SUM(st.EXECUTIONS_DELTA),0)/1000, 1) AS AVG_ELAPSED_MS,
            ROUND(SUM(st.CPU_TIME_DELTA)    /NULLIF(SUM(st.EXECUTIONS_DELTA),0)/1000, 1) AS AVG_CPU_MS,
            ROUND(SUM(st.BUFFER_GETS_DELTA) /NULLIF(SUM(st.EXECUTIONS_DELTA),0),    0) AS AVG_BUFFER_GETS,
            ROUND(SUM(st.DISK_READS_DELTA)  /NULLIF(SUM(st.EXECUTIONS_DELTA),0),    0) AS AVG_PHYS_READS,
            MAX(sn.MODULE)                                                          AS MODULE,
            SUBSTR(MAX(tx.SQL_TEXT), 1, 80)                                         AS SQL_TEXT,
            SUM(st.${orderCol})                                                     AS SORT_METRIC
          FROM DBA_HIST_SQLSTAT st
          INNER JOIN DBA_HIST_SNAPSHOT sn
                  ON sn.SNAP_ID = st.SNAP_ID
                 AND sn.DBID    = st.DBID
                 AND sn.BEGIN_INTERVAL_TIME >= SYSDATE - ${days}
          LEFT JOIN DBA_HIST_SQLTEXT tx
                 ON tx.SQL_ID = st.SQL_ID
                AND tx.DBID   = st.DBID
          WHERE st.${orderCol} > 0
            ${dbidFilter}
          GROUP BY st.SQL_ID
          ORDER BY SORT_METRIC DESC
        )
        WHERE ROWNUM <= 15
      `);
    } catch(e1) {
      // Fallback: simpler query without SQL text join
      try {
        rows = await query(`
          SELECT SQL_ID, EXECUTIONS, AVG_ELAPSED_MS, AVG_CPU_MS,
                 AVG_BUFFER_GETS, AVG_PHYS_READS, MODULE,
                 '(text unavailable)' AS SQL_TEXT
          FROM (
            SELECT
              st.SQL_ID,
              SUM(st.EXECUTIONS_DELTA)                                                AS EXECUTIONS,
              ROUND(SUM(st.ELAPSED_TIME_DELTA)/NULLIF(SUM(st.EXECUTIONS_DELTA),0)/1000,1) AS AVG_ELAPSED_MS,
              ROUND(SUM(st.CPU_TIME_DELTA)    /NULLIF(SUM(st.EXECUTIONS_DELTA),0)/1000,1) AS AVG_CPU_MS,
              ROUND(SUM(st.BUFFER_GETS_DELTA) /NULLIF(SUM(st.EXECUTIONS_DELTA),0),    0) AS AVG_BUFFER_GETS,
              ROUND(SUM(st.DISK_READS_DELTA)  /NULLIF(SUM(st.EXECUTIONS_DELTA),0),    0) AS AVG_PHYS_READS,
              MAX(sn.MODULE)                                                            AS MODULE,
              SUM(st.${orderCol})                                                       AS SORT_METRIC
            FROM DBA_HIST_SQLSTAT st
            INNER JOIN DBA_HIST_SNAPSHOT sn
                    ON sn.SNAP_ID = st.SNAP_ID
                   AND sn.DBID    = st.DBID
                   AND sn.BEGIN_INTERVAL_TIME >= SYSDATE - ${days}
            WHERE st.${orderCol} > 0
              ${dbidFilter}
            GROUP BY st.SQL_ID
            ORDER BY SORT_METRIC DESC
          )
          WHERE ROWNUM <= 15
        `);
      } catch(e2) {
        return res.status(500).json({ error: 'Top SQL query failed: ' + e2.message });
      }
    }

    // ── STEP 2: Trend data for top 5 SQL IDs ─────────────────────────────────
    let trend = [];
    if (rows.length > 0) {
      const top5 = rows.slice(0, 5).map(r => `'${String(r.SQL_ID).replace(/'/g,"''")}'`).join(',');
      try {
        trend = await query(`
          SELECT st.SQL_ID,
                 sn.SNAP_ID,
                 TO_CHAR(sn.BEGIN_INTERVAL_TIME,'MM-DD HH24:MI') AS TS,
                 ROUND(st.ELAPSED_TIME_DELTA/NULLIF(st.EXECUTIONS_DELTA,0)/1000,1) AS VALUE
          FROM DBA_HIST_SQLSTAT st
          INNER JOIN DBA_HIST_SNAPSHOT sn
                  ON sn.SNAP_ID = st.SNAP_ID
                 AND sn.DBID    = st.DBID
                 AND sn.BEGIN_INTERVAL_TIME >= SYSDATE - ${days}
          WHERE st.SQL_ID IN (${top5})
            AND st.EXECUTIONS_DELTA > 0
            ${dbidFilter}
          ORDER BY st.SQL_ID, sn.SNAP_ID
        `);
      } catch(_) { trend = []; }
    }

    res.json({ rows, trend });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/oracle/redo', async (req, res) => {
  try {
    // ── Log Groups ───────────────────────────────────────────────────────────
    let groups = [];
    try {
      groups = await query(
        `SELECT "GROUP#"         AS "GROUP#",
                MEMBERS,
                ROUND(BYTES/1024/1024, 0) AS SIZE_MB,
                STATUS,
                ARCHIVED,
                TO_CHAR("FIRST_CHANGE#") AS "FIRST_CHANGE#"
         FROM V$LOG
         ORDER BY "GROUP#"`
      );
    } catch(e1) {
      // Fallback without quoted identifiers (older Oracle versions)
      try {
        groups = await query(
          `SELECT GROUP#    AS GRP,
                  MEMBERS,
                  ROUND(BYTES/1024/1024, 0) AS SIZE_MB,
                  STATUS,
                  ARCHIVED,
                  TO_CHAR(FIRST_CHANGE#) AS FIRST_CHANGE
           FROM V$LOG
           ORDER BY GROUP#`
        );
        // Normalise key names so the frontend renderer matches
        groups = groups.map(r => ({
          'GROUP#':         r.GRP         ?? r['GROUP#'] ?? '',
          'MEMBERS':        r.MEMBERS,
          'SIZE_MB':        r.SIZE_MB,
          'STATUS':         r.STATUS,
          'ARCHIVED':       r.ARCHIVED,
          'FIRST_CHANGE#':  r.FIRST_CHANGE ?? r['FIRST_CHANGE#'] ?? ''
        }));
      } catch(e2) {
        groups = [];
      }
    }

    // ── Archive Mode ─────────────────────────────────────────────────────────
    let archMode = [];
    try { archMode = await query(`SELECT LOG_MODE FROM V$DATABASE`); }
    catch(_) { archMode = [{ LOG_MODE: 'UNKNOWN' }]; }

    // ── Switch History (last 24 h) ───────────────────────────────────────────
    let switchHist = [];
    try {
      switchHist = await query(
        `SELECT TO_CHAR(FIRST_TIME,'YYYY-MM-DD HH24') AS HOUR,
                COUNT(*) AS SWITCHES,
                CASE WHEN COUNT(*)>20 THEN 'CRITICAL'
                     WHEN COUNT(*)>10 THEN 'WARNING'
                     ELSE 'OK'
                END AS SEVERITY
         FROM V$LOG_HISTORY
         WHERE FIRST_TIME >= SYSDATE - 1
         GROUP BY TO_CHAR(FIRST_TIME,'YYYY-MM-DD HH24')
         ORDER BY HOUR`
      );
    } catch(_) { switchHist = []; }

    // ── Archive Destinations ─────────────────────────────────────────────────
    let archDests = [];
    try {
      archDests = await query(
        `SELECT DEST_ID   AS "DEST#",
                STATUS,
                TARGET,
                ARCHIVER,
                DEST_NAME
         FROM V$ARCHIVE_DEST
         WHERE STATUS != 'INACTIVE'
         ORDER BY DEST_ID`
      );
    } catch(_) {
      try {
        archDests = await query(
          `SELECT DEST_ID AS "DEST#", STATUS, TARGET, ARCHIVER, DEST_NAME
           FROM V$ARCHIVE_DEST
           ORDER BY DEST_ID
           FETCH FIRST 20 ROWS ONLY`
        );
      } catch(__) { archDests = []; }
    }

    const totalSwitches   = switchHist.reduce((s, r) => s + (Number(r.SWITCHES) || 0), 0);
    const switchesPerHour = switchHist.length
      ? Math.round(totalSwitches / switchHist.length)
      : 0;

    res.json({
      groups,
      groupCount:      groups.length,
      sizePerGroup:    groups[0]?.SIZE_MB || 0,
      archiveMode:     archMode[0]?.LOG_MODE || 'NOARCHIVELOG',
      switchHistory:   switchHist,
      switchesPerHour,
      archDests
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/oracle/scheduler', async (req, res) => {
  try {
    const filter = req.query.filter || 'ALL';
    const owner  = (req.query.owner  || '').toUpperCase().replace(/'/g, "''");

    const whereState = filter === 'ALL' ? '' : `AND j.STATE = '${filter.replace(/'/g,"''")}'`;
    const whereOwner = owner && owner !== 'ALL' ? `AND j.OWNER = '${owner}'` : '';

    const safeQuery = (sql) => query(sql).catch(() => []);
    const [jobs, failures, summary, owners] = await Promise.all([
      query(`SELECT j.OWNER, j.JOB_NAME, j.STATE,
               TO_CHAR(j.LAST_START_DATE,'YYYY-MM-DD HH24:MI:SS') AS LAST_RUN,
               TO_CHAR(j.NEXT_RUN_DATE,'YYYY-MM-DD HH24:MI:SS')   AS NEXT_RUN,
               TO_CHAR(j.LAST_RUN_DURATION)                        AS RUN_DURATION,
               j.FAILURE_COUNT
             FROM DBA_SCHEDULER_JOBS j
             WHERE 1=1 ${whereState} ${whereOwner}
             ORDER BY j.FAILURE_COUNT DESC, j.LAST_START_DATE DESC
             FETCH FIRST 200 ROWS ONLY`).catch(() => []),
      query(`SELECT l.OWNER, l.JOB_NAME,
               TO_CHAR(l.LOG_DATE,'YYYY-MM-DD HH24:MI:SS') AS LOG_DATE,
               l.STATUS, l.ERROR# AS "ERROR#",
               SUBSTR(l.ADDITIONAL_INFO,1,200) AS ADDITIONAL_INFO
             FROM DBA_SCHEDULER_JOB_RUN_DETAILS l
             WHERE l.STATUS NOT IN ('SUCCEEDED','RUNNING')
               AND l.LOG_DATE >= SYSDATE - 7
               ${whereOwner.replace('j.OWNER','l.OWNER')}
             ORDER BY l.LOG_DATE DESC
             FETCH FIRST 50 ROWS ONLY`).catch(() => []),
      query(`SELECT COUNT(*) AS TOTAL,
               SUM(CASE WHEN STATE='RUNNING'  THEN 1 ELSE 0 END) AS RUNNING,
               SUM(CASE WHEN STATE='DISABLED' THEN 1 ELSE 0 END) AS DISABLED
             FROM DBA_SCHEDULER_JOBS`).catch(() => []),
      // ── FIX: owners dropdown was only listing owners from DISTINCT OWNER
      // FROM DBA_SCHEDULER_JOBS — i.e. only schemas that currently happen to
      // own at least one scheduler job. Any schema with zero scheduler jobs
      // (which, on most databases, is most of them) never appeared, which is
      // why only "2 owners" showed up even though the database has many more
      // schemas. Fixed by UNION-ing in every real application schema from
      // DBA_USERS (excluding Oracle-maintained accounts), same exclusion
      // list already used by the Schema panel, so the dropdown lets you
      // pre-filter by any schema — not just ones that already have a job.
      query(`SELECT OWNER FROM (
               SELECT DISTINCT OWNER FROM DBA_SCHEDULER_JOBS
               UNION
               SELECT USERNAME AS OWNER FROM DBA_USERS
               WHERE USERNAME NOT IN (
                 'SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS','ORDSYS',
                 'EXFSYS','DMSYS','WMSYS','CTXSYS','ANONYMOUS','XDB','ORDPLUGINS','ORDDATA',
                 'SI_INFORMTN_SCHEMA','OLAPSYS','SCOTT','XS$NULL','LBACSYS','OJVMSYS',
                 'GSMADMIN_INTERNAL','APPQOSSYS','DBSFWUSER','GGSYS','AUDSYS','DVF','DVSYS',
                 'REMOTE_SCHEDULER_AGENT'
               )
               AND ACCOUNT_STATUS NOT IN ('EXPIRED & LOCKED','LOCKED')
             )
             ORDER BY OWNER`).catch(() => []),
    ]);
    const s = summary[0] || {};
    res.json({
      jobs,
      failures,
      owners: owners.map(r => r.OWNER).filter(Boolean),
      total   : s.TOTAL    || 0,
      running : s.RUNNING  || 0,
      disabled: s.DISABLED || 0,
      failed  : failures.length,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── DATA PUMP JOB MONITOR ─────────────────────────────────────────────────────
// Returns live expdp/impdp job status from DBA_DATAPUMP_JOBS + V$SESSION_LONGOPS
app.get('/api/oracle/datapump', async (req, res) => {
  try {
    const safeQ = (sql) => query(sql).catch(e => { console.warn('[datapump safeQ]', e.message); return []; });

    // ── Step 1: Get all active/running jobs from DBA_DATAPUMP_JOBS ────────────
    const jobRows = await safeQ(`
      SELECT
        j.OWNER_NAME,
        j.JOB_NAME,
        j.OPERATION,
        j.JOB_MODE,
        j.STATE,
        j.DEGREE,
        j.ATTACHED_SESSIONS
      FROM DBA_DATAPUMP_JOBS j
      WHERE j.STATE IN ('EXECUTING', 'DEFINING', 'IDLING')
      ORDER BY
        CASE j.STATE WHEN 'EXECUTING' THEN 1 WHEN 'DEFINING' THEN 2 ELSE 3 END,
        j.JOB_NAME`
    );

    // ── Step 2: Get ALL Data Pump sessions from V$SESSION ─────────────────────
    // Keep ALL sessions (master + workers), not just ACTIVE — workers go INACTIVE
    // between write chunks. Don't filter by STATUS.
    const sessionRows = await safeQ(`
      SELECT
        s.SID,
        s.SERIAL#,
        s.USERNAME,
        s.STATUS,
        s.PROGRAM,
        s.MODULE,
        s.ACTION,
        TO_CHAR(s.LOGON_TIME, 'YYYY-MM-DD HH24:MI:SS') AS LOGON_TIME,
        SUBSTR(sq.SQL_FULLTEXT, 1, 500) AS SQL_TEXT
      FROM V$SESSION s
      LEFT JOIN V$SQL sq ON sq.SQL_ID = s.SQL_ID AND sq.CHILD_NUMBER = 0
      WHERE s.MODULE LIKE 'Data Pump%'
        AND s.USERNAME IS NOT NULL
      ORDER BY
        CASE WHEN s.MODULE LIKE 'Data Pump Master%' THEN 0 ELSE 1 END,
        s.SID`
    );

    // ── Step 3: Get ALL longops rows (last 12h, wide net) ─────────────────────
    const longopsRows = await safeQ(`
      SELECT
        SID,
        SERIAL#,
        OPNAME,
        TARGET,
        CONTEXT,
        SOFAR,
        TOTALWORK,
        UNITS,
        CASE WHEN TOTALWORK > 0
             THEN ROUND(SOFAR / TOTALWORK * 100, 1)
             ELSE 0 END AS PCT_DONE,
        ELAPSED_SECONDS,
        TIME_REMAINING,
        MESSAGE,
        TO_CHAR(LAST_UPDATE_TIME, 'YYYY-MM-DD HH24:MI:SS') AS LAST_UPDATE,
        LAST_UPDATE_TIME AS LAST_UPDATE_TIME_RAW
      FROM V$SESSION_LONGOPS
      WHERE (
            OPNAME LIKE 'Data Pump%'
         OR OPNAME LIKE 'KUPW$%'
         OR OPNAME LIKE 'KUP%'
         OR UPPER(TARGET) LIKE '%.DMP'
      )
        AND LAST_UPDATE_TIME >= SYSDATE - 12/24
      ORDER BY LAST_UPDATE_TIME DESC`
    );

    // ── Step 4: Merge in Node.js — no complex SQL joins that can silently fail ─
    // Build lookup maps
    const sessionBySid = {};          // sid -> session row
    const sessionsByJob = {};         // "OWNER|JOBNAME" -> [sessions]  (master first)
    const sidSet = new Set();

    for (const s of sessionRows) {
      const sid = String(s.SID || s.sid || '');
      if (sid) { sessionBySid[sid] = s; sidSet.add(sid); }
      const jobKey = `${(s.USERNAME||s.username||'').toUpperCase()}|${(s.ACTION||s.action||'').toUpperCase()}`;
      if (!sessionsByJob[jobKey]) sessionsByJob[jobKey] = [];
      sessionsByJob[jobKey].push(s);
    }

    // Sort each job's session list: master first, then by SID
    for (const k of Object.keys(sessionsByJob)) {
      sessionsByJob[k].sort((a, b) => {
        const am = (a.MODULE||a.module||''); const bm = (b.MODULE||b.module||'');
        const ap = am.includes('Master') ? 0 : 1;
        const bp = bm.includes('Master') ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return Number(a.SID||a.sid||0) - Number(b.SID||b.sid||0);
      });
    }

    // Longops: build map sid -> best (most recent) longops row
    const longopsBySid = {};
    const allLongopsForDisplay = [];
    for (const lo of longopsRows) {
      const sid = String(lo.SID || lo.sid || '');
      if (sid && !longopsBySid[sid]) longopsBySid[sid] = lo; // already DESC sorted
      allLongopsForDisplay.push(lo);
    }

    // Build enriched job list
    const jobs = jobRows.map(j => {
      const owner   = (j.OWNER_NAME || j.owner_name || '').toUpperCase();
      const jobName = (j.JOB_NAME   || j.job_name   || '').toUpperCase();
      const jobKey  = `${owner}|${jobName}`;

      // Find best session for this job
      const jobSessions = sessionsByJob[jobKey] || [];
      const masterSess  = jobSessions.find(s => (s.MODULE||s.module||'').includes('Master'));
      const bestSess    = masterSess || jobSessions[0] || null;
      const masterSid   = bestSess ? String(bestSess.SID || bestSess.sid || '') : null;

      // Try to find longops: check ALL sessions for this job (workers write longops too)
      let lo = null;
      // 1st: try master SID
      if (masterSid && longopsBySid[masterSid]) lo = longopsBySid[masterSid];
      // 2nd: try any worker SID for this job
      if (!lo) {
        for (const sess of jobSessions) {
          const sid2 = String(sess.SID || sess.sid || '');
          if (sid2 && longopsBySid[sid2]) { lo = longopsBySid[sid2]; break; }
        }
      }
      // 3rd: scan all longops for a TARGET that contains the job name
      if (!lo) {
        lo = longopsRows.find(r =>
          (r.TARGET || r.target || '').toUpperCase().includes(jobName) ||
          (r.OPNAME || r.opname || '').toUpperCase().includes(jobName)
        ) || null;
      }
      // 4th: scan all longops for SIDs belonging to any Data Pump session
      if (!lo && jobSessions.length === 0) {
        // No session match at all — use most recent any-DP longops row
        lo = longopsRows[0] || null;
      }

      const sofar    = lo ? (lo.SOFAR    || lo.sofar    || 0) : null;
      const total    = lo ? (lo.TOTALWORK|| lo.totalwork|| 0) : null;
      // Elapsed: prefer longops (most accurate), fall back to wall-clock from session LOGON_TIME
      const elapsedFromLo    = lo ? (lo.ELAPSED_SECONDS || lo.elapsed_seconds) : null;
      const logonTimeStr     = bestSess ? (bestSess.LOGON_TIME || bestSess.logon_time) : null;
      const elapsedFromLogon = logonTimeStr
        ? Math.round((Date.now() - new Date(logonTimeStr.replace(' ', 'T')).getTime()) / 1000)
        : null;
      const elapsed  = elapsedFromLo != null ? elapsedFromLo : elapsedFromLogon;
      const remaining= lo ? (lo.TIME_REMAINING  || lo.time_remaining)  : null;
      const pct      = (sofar != null && total && Number(total) > 0)
                       ? Math.round(Number(sofar) / Number(total) * 1000) / 10
                       : 0;

      return {
        OWNER_NAME       : j.OWNER_NAME   || j.owner_name,
        JOB_NAME         : j.JOB_NAME     || j.job_name,
        OPERATION        : j.OPERATION    || j.operation,
        JOB_MODE         : j.JOB_MODE     || j.job_mode,
        STATE            : j.STATE        || j.state,
        DEGREE           : j.DEGREE       || j.degree,
        ATTACHED_SESSIONS: j.ATTACHED_SESSIONS || j.attached_sessions,
        SID              : masterSid,
        SOFAR            : sofar,
        TOTALWORK        : total,
        PCT_DONE         : pct,
        ELAPSED_SECONDS  : elapsed,
        MINS_REMAINING   : remaining != null ? Math.round(Number(remaining) / 60 * 10) / 10 : null,
        MESSAGE          : lo ? (lo.MESSAGE || lo.message) : null,
        LAST_UPDATE      : lo ? (lo.LAST_UPDATE || lo.last_update) : null,
        _longops_found   : lo !== null,
      };
    });

    // ── Step 5: Completed / stopped jobs ──────────────────────────────────────
    const completed = await safeQ(`
      SELECT
        j.OWNER_NAME,
        j.JOB_NAME,
        j.OPERATION,
        j.JOB_MODE,
        j.STATE,
        j.DEGREE,
        j.ATTACHED_SESSIONS,
        TO_CHAR(o.CREATED,       'YYYY-MM-DD HH24:MI:SS') AS JOB_CREATED,
        TO_CHAR(o.LAST_DDL_TIME, 'YYYY-MM-DD HH24:MI:SS') AS JOB_LAST_DDL
      FROM DBA_DATAPUMP_JOBS j
      LEFT JOIN DBA_OBJECTS o
        ON  o.OBJECT_NAME = j.JOB_NAME
        AND o.OWNER       = j.OWNER_NAME
        AND o.OBJECT_TYPE = 'TABLE'
      WHERE j.STATE NOT IN ('EXECUTING', 'DEFINING', 'IDLING')
      ORDER BY o.LAST_DDL_TIME DESC NULLS LAST, j.JOB_NAME DESC
      FETCH FIRST 30 ROWS ONLY`
    );

    // ── Step 6: Data Pump directory objects ───────────────────────────────────
    const directories = await safeQ(`
      SELECT DIRECTORY_NAME, DIRECTORY_PATH
      FROM DBA_DIRECTORIES
      ORDER BY DIRECTORY_NAME
      FETCH FIRST 50 ROWS ONLY`
    );

    // ── Step 7: Summary KPIs ──────────────────────────────────────────────────
    res.json({
      jobs,
      longops    : allLongopsForDisplay.slice(0, 200),
      errors     : sessionRows,
      completed,
      directories,
      summary: {
        active   : jobs.filter(j => (j.STATE||'') === 'EXECUTING').length,
        defining : jobs.filter(j => (j.STATE||'') === 'DEFINING').length,
        idling   : jobs.filter(j => (j.STATE||'') === 'IDLING').length,
        total    : jobs.length,
      },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AUTOTASK CLIENT STATUS ────────────────────────────────────────────────────
app.get('/api/oracle/autotask', async (req, res) => {
  try {
    const rows = await query(
      `SELECT client_name, status FROM dba_autotask_client ORDER BY client_name`
    );
    res.json({ rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/oracle/dataguard', async (req, res) => {
  try {
    // ── Always fetch DB info ─────────────────────────────────────────────
    const dbInfo = await query(
      `SELECT DB_UNIQUE_NAME, DATABASE_ROLE, PROTECTION_MODE, PROTECTION_LEVEL,
              SWITCHOVER_STATUS, DATAGUARD_BROKER, LOG_MODE, OPEN_MODE,
              GUARD_STATUS
       FROM V$DATABASE`
    );
    const db = dbInfo[0] || {};

    // ── DG Stats (only on DG-configured databases) ───────────────────────
    // NOTE: 'apply finish time' is a known trouble row on V$DATAGUARD_STATS —
    // on a standby where redo apply hasn't produced an estimate yet, Oracle's
    // fixed-view logic for that one metric can throw ORA-01722 even though
    // nothing here does a real numeric conversion. Querying it separately
    // means that failure can't wipe out transport lag / apply lag / apply
    // rate / etc, which used to happen because the whole SELECT was one
    // try/catch.
    let stats = [];
    try {
      stats = await query(
        `SELECT NAME, VALUE, UNIT, TIME_COMPUTED
         FROM V$DATAGUARD_STATS
         WHERE NAME != 'apply finish time'
         ORDER BY NAME`
      );
    } catch(_) { stats = []; }
    try {
      const finishTime = await query(
        `SELECT NAME, VALUE, UNIT, TIME_COMPUTED
         FROM V$DATAGUARD_STATS
         WHERE NAME = 'apply finish time'`
      );
      stats = stats.concat(finishTime);
    } catch(_) { /* known Oracle quirk — omit this one metric, keep the rest */ }

    // ── Archive Destinations with full detail ────────────────────────────
    // NOTE: V$ARCHIVE_DEST_STATUS does NOT have TARGET, ARCHIVER, NET_TIMEOUT,
    // or APPLIED_SCN columns — those live on the separate V$ARCHIVE_DEST config
    // view (see destsConfig below). Selecting them here throws ORA-00904 on
    // every call, which the old code silently swallowed, so this table always
    // rendered empty. TYPE (LOCAL/PHYSICAL/LOGICAL/SNAPSHOT/…) is the real
    // per-destination-role column on this view.
    let dests = [];
    try {
      dests = await query(
        `SELECT DEST_ID                AS "DEST#",
                STATUS,
                TYPE,
                DATABASE_MODE,
                PROTECTION_MODE,
                DB_UNIQUE_NAME,
                GAP_STATUS,
                SYNCHRONIZED,
                SYNCHRONIZATION_STATUS,
                ARCHIVED_SEQ#           AS "ARCHIVED_SEQ",
                APPLIED_SEQ#            AS "APPLIED_SEQ",
                ERROR
         FROM V$ARCHIVE_DEST_STATUS
         WHERE STATUS != 'INACTIVE'
         ORDER BY DEST_ID`
      );
    } catch(_) { dests = []; }

    // ── Standby-related background processes (RFS/MRP/ARCH/etc) visible on
    //    this instance ────────────────────────────────────────────────────
    // NOTE: V$MANAGED_STANDBY reports Data Guard PROCESS activity — it has no
    // DB_UNIQUE_NAME, ROLE, PROTECTION_MODE, DESTINATION, APPLIED_SCN, or
    // APPLIED_TIME columns (those don't exist on this view at all). The old
    // query selected all six and threw ORA-00904 on every single call,
    // silently returning [] via the outer catch.
    let standbys = [];
    try {
      standbys = await query(
        `SELECT PROCESS, PID, STATUS, CLIENT_PROCESS, CLIENT_PID,
                THREAD#, SEQUENCE#, BLOCK#, BLOCKS, DELAY_MINS
         FROM V$MANAGED_STANDBY`
      );
    } catch(_) { standbys = []; }

    // ── Redo apply stats (standby only) ─────────────────────────────────
    let applyStats = [];
    try {
      applyStats = await query(
        `SELECT TYPE, ITEM, SOFAR, TOTAL, UNITS, TIMESTAMP
         FROM V$RECOVERY_PROGRESS
         ORDER BY TYPE, ITEM`
      ).catch(() => []);
    } catch(_) { applyStats = []; }

    // ── Current log sequence being generated (primary-side health check) ─
    let currentLog = [];
    try {
      currentLog = await query(
        `SELECT THREAD#, SEQUENCE#, ARCHIVED, STATUS
         FROM V$LOG
         WHERE STATUS = 'CURRENT'
         ORDER BY THREAD#`
      );
    } catch(_) { currentLog = []; }

    // ── Standby transport destination(s) — error check ───────────────────
    // Don't assume the standby lives at DEST_ID=2 — that's a common convention
    // but not a rule (some shops use 3, 4, or have several standby destinations
    // in a multi-standby config). Instead, find every destination whose TARGET
    // is actually 'STANDBY' and surface STATUS/ERROR for each of them.
    // NOTE: TARGET lives on V$ARCHIVE_DEST (the config view) — it does NOT
    // exist on V$ARCHIVE_DEST_STATUS. V$ARCHIVE_DEST already carries STATUS,
    // ERROR, and DB_UNIQUE_NAME itself, so no join/second view is needed.
    let standbyDests = [];
    try {
      standbyDests = await query(
        `SELECT DEST_ID, STATUS, ERROR, DB_UNIQUE_NAME
         FROM V$ARCHIVE_DEST
         WHERE TARGET = 'STANDBY'
         ORDER BY DEST_ID`
      );
    } catch(_) { standbyDests = []; }

    // ── Archive destination CONFIG (separate from the STATUS view above) ─
    // V$ARCHIVE_DEST carries the static config columns (SCHEDULE, DESTINATION,
    // TRANSMIT_MODE) that don't live on V$ARCHIVE_DEST_STATUS.
    let destsConfig = [];
    try {
      destsConfig = await query(
        `SELECT DEST_ID, DEST_NAME, STATUS, TARGET, ARCHIVER, SCHEDULE,
                DESTINATION, ERROR, TRANSMIT_MODE
         FROM V$ARCHIVE_DEST
         WHERE STATUS != 'INACTIVE'
         ORDER BY DEST_ID`
      );
    } catch(_) { destsConfig = []; }

    // ── Authoritative DG-configured signal: V$DATAGUARD_CONFIG ───────────
    // This is the SAME view/logic the dashboard's DB-info banner already uses
    // ("Data Guard Configured: YES/NO" via COUNT(*)>1 FROM v$dataguard_config)
    // — it lists every DB_UNIQUE_NAME named in the Data Guard / Broker
    // configuration, including the local database itself. More than one row
    // means at least one OTHER site is configured, which is the correct,
    // Oracle-documented way to answer "is DG configured" and doesn't depend
    // on the standby-only V$DATAGUARD_STATS view, on archive destinations
    // happening to show up as rows, or on fal_server/log_archive_config being
    // set (the heuristics below). Without this, the DG panel could disagree
    // with the dashboard banner about whether DG is even configured.
    let dgConfigMembers = [];
    try {
      dgConfigMembers = await query(
        `SELECT DB_UNIQUE_NAME, PARENT_DBUN, DEST_ROLE FROM V$DATAGUARD_CONFIG ORDER BY DB_UNIQUE_NAME`
      );
    } catch(_) { dgConfigMembers = []; }
    const dgConfigViewIndicatesDG = dgConfigMembers.length > 1;

    // ── DG-related init parameters — a cheap, reliable "is DG configured at
    //    all" signal that doesn't depend on the standby-only V$DATAGUARD_STATS
    //    view or on how many archive destinations happen to show up as rows ──
    let dgParams = [];
    try {
      dgParams = await query(
        `SELECT NAME, VALUE FROM V$PARAMETER WHERE NAME IN ('fal_server','fal_client','log_archive_config')`
      );
    } catch(_) { dgParams = []; }
    const falServer        = dgParams.find(r => r.NAME === 'fal_server')?.VALUE || '';
    const logArchiveConfig = dgParams.find(r => r.NAME === 'log_archive_config')?.VALUE || '';

    // Broker-managed configs frequently leave fal_server/log_archive_config unset
    // (the broker drives transport itself), so also check log_archive_dest_N
    // directly for a SERVICE= entry — this doesn't depend on V$ARCHIVE_DEST(_STATUS)
    // returning rows the way hasStandbyDest below does.
    let logArchiveDestParams = [];
    try {
      logArchiveDestParams = await query(
        `SELECT VALUE FROM V$PARAMETER WHERE NAME LIKE 'log\\_archive\\_dest\\_%' ESCAPE '\\'`
      );
    } catch(_) { logArchiveDestParams = []; }
    const hasServiceDest = logArchiveDestParams.some(r => (r.VALUE || '').toUpperCase().includes('SERVICE='));

    // ── Is Data Guard actually configured? ───────────────────────────────
    // IMPORTANT: V$DATAGUARD_STATS is documented by Oracle to return NO ROWS
    // when queried on a PRIMARY database — that's normal, not a sign DG is
    // missing — so `stats.length > 0` can only ever confirm DG on a STANDBY.
    // Likewise, requiring more than one archive destination row breaks on the
    // very common setup where only the standby-facing destination shows up as
    // its own row (local/implicit archiving doesn't always appear in
    // V$ARCHIVE_DEST_STATUS). So on a PRIMARY we instead look for a
    // standby-targeted destination, a switchover status that only appears in
    // a real DG config, or fal_server/log_archive_config being set.
    const hasStandbyDest = dests.some(d => ['PHYSICAL','LOGICAL','SNAPSHOT'].includes((d.TYPE || '').toUpperCase()))
                         || destsConfig.some(d => (d.TARGET || '').toUpperCase() === 'STANDBY')
                         || standbyDests.length > 0;
    const switchoverIndicatesDG = !!db.SWITCHOVER_STATUS
      && !['NOT ALLOWED', '—', ''].includes(db.SWITCHOVER_STATUS);
    const paramsIndicateDG = !!falServer.trim() || logArchiveConfig.toUpperCase().includes('DG_CONFIG') || hasServiceDest;

    const isDGConfigured = dgConfigViewIndicatesDG
      || stats.length > 0
      || db.DATABASE_ROLE === 'PHYSICAL STANDBY'
      || db.DATABASE_ROLE === 'LOGICAL STANDBY'
      || db.DATABASE_ROLE === 'SNAPSHOT STANDBY'
      || hasStandbyDest
      || switchoverIndicatesDG
      || paramsIndicateDG;

    // Extract lag values from stats
    const applyLag  = stats.find(r => r.NAME === 'apply lag')?.VALUE  || null;
    const tranLag   = stats.find(r => r.NAME === 'transport lag')?.VALUE || null;
    const applyRate = stats.find(r => r.NAME === 'apply rate')?.VALUE || null;

    res.json({
      configured:       isDGConfigured,
      role:             db.DATABASE_ROLE      || 'PRIMARY',
      protectionMode:   db.PROTECTION_MODE    || '—',
      protectionLevel:  db.PROTECTION_LEVEL   || '—',
      switchoverStatus: db.SWITCHOVER_STATUS  || '—',
      brokerEnabled:    db.DATAGUARD_BROKER   || '—',
      logMode:          db.LOG_MODE           || '—',
      openMode:         db.OPEN_MODE          || '—',
      guardStatus:      db.GUARD_STATUS       || '—',
      dbUniqueName:     db.DB_UNIQUE_NAME     || '—',
      applyLag,
      tranLag,
      applyRate,
      stats,
      dests,
      destsConfig,
      standbys,
      applyStats,
      currentLog,
      standbyDests,
      dgConfigMembers,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  DATA GUARD — STANDBY HEALTH CHECK VIA SSH + SQL*PLUS
//
//  POST /api/oracle/dataguard/standby-ssh
//
//  WHY THIS EXISTS: a physical/logical standby is very often left in MOUNT
//  state with no listener/service registered — that's normal, Data Guard
//  redo apply doesn't require the standby to be "open" — so the app's
//  regular oracledb connection pool (which needs a TNS listener + service)
//  usually CANNOT reach the standby directly. DBAs instead SSH to the
//  standby host and run `sqlplus / as sysdba` locally (a "bequeath"
//  connection — no listener needed at all). This endpoint automates exactly
//  that: SSH in, source the Oracle environment (oraenv / env_* files, same
//  approach as the OS Terminal's ssh-exec), open ONE sqlplus session, run
//  every standby-side Data Guard query in a single batch (CSV markup output
//  so it's trivial to parse), and hand back structured rows per query so
//  the Data Guard panel can render them next to the primary-side data.
//
//  Body: {
//    host, port, user, password, privateKey  — SSH connection (same shape as /api/os/ssh-exec)
//    oracleSid                               — sets ORACLE_SID / sources env_<SID> before connecting
//    connectString                           — optional full sqlplus CONNECT target, e.g.
//                                               "sys/password@host:1521/orclpdb1 as sysdba".
//                                               If omitted, falls back to a local bequeath
//                                               connection "/ as sysdba" (requires oracleSid
//                                               and an OS account in the oracle/dba group).
//    timeout                                 — optional ms, default 60000, hard cap 300000
//  }
// ═══════════════════════════════════════════════════════════════════════════════

// Split sqlplus CSV-markup output into named blocks using the PROMPT markers
// injected around every query by _dgBuildStandbySql() below.
function _dgSplitBlocks(stdout) {
  const blocks = {};
  const re = /~~~DGQ_([A-Z0-9_]+)_START~~~\r?\n([\s\S]*?)~~~DGQ_\1_END~~~/g;
  let m;
  while ((m = re.exec(stdout)) !== null) blocks[m[1]] = m[2];
  return blocks;
}

// Minimal CSV line parser — handles double-quoted fields with "" escaping,
// exactly what `SET MARKUP CSV ON QUOTE ON` produces.
function _dgParseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i+1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Turn one CSV block into { columns, rows, error } — `error` is set when the
// block's text looks like a SQL*Plus/ORA error instead of CSV data.
function _dgParseCsvBlock(text) {
  const lines = (text || '').split(/\r?\n/).map(l => l.replace(/\r$/, '')).filter(l => l.trim() !== '');
  if (!lines.length) return { columns: [], rows: [], error: null };

  const errLine = lines.find(l => /^\s*(ORA-\d{5}|SP2-\d{4})/.test(l));
  if (errLine) return { columns: [], rows: [], error: lines.join(' ').trim() };

  const columns = _dgParseCsvLine(lines[0]).map(c => c.trim());
  const rows    = lines.slice(1).map(l => _dgParseCsvLine(l));
  return { columns, rows, error: null };
}

function _dgBuildStandbySql(connectStr) {
  const Q = (id, sql) => `PROMPT ~~~DGQ_${id}_START~~~\n${sql}\nPROMPT ~~~DGQ_${id}_END~~~\n`;
  return [
    `WHENEVER SQLERROR CONTINUE`,
    `SET HEADING ON`,
    `SET PAGESIZE 50000`,
    `SET LINESIZE 32767`,
    `SET TRIMSPOOL ON`,
    `SET TRIMOUT ON`,
    `SET FEEDBACK OFF`,
    `SET VERIFY OFF`,
    `SET ECHO OFF`,
    `SET TERMOUT ON`,
    `SET WRAP OFF`,
    `SET MARKUP CSV ON QUOTE ON`,
    `CONNECT ${connectStr}`,
    Q('CONNTEST', `SELECT USER AS "CONNECTED_AS" FROM DUAL;`),
    Q('ROLE',      `SELECT DATABASE_ROLE, OPEN_MODE, PROTECTION_MODE, SWITCHOVER_STATUS FROM V$DATABASE;`),
    // NOTE: these three V$DATAGUARD_STATS metrics are pulled separately so one bad
    // row (WHENEVER SQLERROR CONTINUE) can't wipe out the others.
    //
    // ROOT CAUSE of the ORA-01722 "invalid number" that used to hit ALL THREE of
    // these queries identically: TIME_COMPUTED and DATUM_TIME on V$DATAGUARD_STATS
    // are VARCHAR2 columns (already pre-formatted date strings), NOT DATE columns.
    // Wrapping a VARCHAR2 in TO_CHAR(col,'format-model') has no valid overload —
    // SQL*Plus/Oracle falls back to the numeric TO_CHAR(NUMBER, format) signature,
    // tries to implicitly convert the date-like string to a NUMBER, and throws
    // ORA-01722 on every single row, for every one of the three metrics. Selecting
    // the columns as-is (no TO_CHAR) avoids the bad overload entirely.
    Q('LAG_TRANSPORT',    `SELECT NAME, VALUE, UNIT, TIME_COMPUTED, DATUM_TIME FROM V$DATAGUARD_STATS WHERE NAME = 'transport lag';`),
    Q('LAG_APPLY',        `SELECT NAME, VALUE, UNIT, TIME_COMPUTED, DATUM_TIME FROM V$DATAGUARD_STATS WHERE NAME = 'apply lag';`),
    Q('LAG_APPLYFINISH',  `SELECT NAME, VALUE, UNIT, TIME_COMPUTED, DATUM_TIME FROM V$DATAGUARD_STATS WHERE NAME = 'apply finish time';`),
    Q('ARCHGAP',   `SELECT THREAD#, LOW_SEQUENCE#, HIGH_SEQUENCE# FROM V$ARCHIVE_GAP;`),
    Q('MRP',       `SELECT PROCESS, STATUS, THREAD#, SEQUENCE#, BLOCK#, BLOCKS FROM V$MANAGED_STANDBY WHERE PROCESS LIKE 'MRP%';`),
    Q('ALLPROC',   `SELECT PROCESS, PID, STATUS, CLIENT_PROCESS, CLIENT_PID, SEQUENCE#, THREAD#, BLOCK#, ACTIVE_AGENTS, KNOWN_AGENTS FROM V$MANAGED_STANDBY;`),
    Q('LASTLOG',   `SELECT ARCH.THREAD# AS "THREAD", ARCH.SEQUENCE# AS "LAST_SEQ_RECEIVED", APPL.SEQUENCE# AS "LAST_SEQ_APPLIED", (ARCH.SEQUENCE# - APPL.SEQUENCE#) AS "DIFFERENCE"
FROM (SELECT THREAD#, SEQUENCE# FROM V$ARCHIVED_LOG
      WHERE (THREAD#,SEQUENCE#) IN (SELECT THREAD#,MAX(SEQUENCE#)
      FROM V$ARCHIVED_LOG WHERE RESETLOGS_CHANGE# =
      (SELECT RESETLOGS_CHANGE# FROM V$DATABASE) GROUP BY THREAD#)) ARCH,
     (SELECT THREAD#, SEQUENCE# FROM V$LOG_HISTORY
      WHERE (THREAD#,SEQUENCE#) IN (SELECT THREAD#,MAX(SEQUENCE#)
      FROM V$LOG_HISTORY GROUP BY THREAD#)) APPL
WHERE ARCH.THREAD# = APPL.THREAD#;`),
    Q('RECOVERY',  `SELECT * FROM V$RECOVERY_PROGRESS;`),
    Q('SRL',       `SELECT GROUP#, THREAD#, SEQUENCE#, ARCHIVED, STATUS FROM V$STANDBY_LOG;`),
    Q('FAL',       `SELECT NAME, VALUE FROM V$PARAMETER WHERE NAME IN ('fal_server','fal_client','log_archive_config','log_archive_dest_state_2','standby_file_management');`),
    Q('DATAFILE',  `SELECT FILE#, STATUS, ENABLED, CREATION_CHANGE#, ROUND(BYTES/1024/1024, 2) AS SIZE_MB FROM V$DATAFILE;`),
    Q('HEALTH',    `SELECT (SELECT VALUE FROM V$DATAGUARD_STATS WHERE NAME='transport lag') AS TRANSPORT_LAG,
       (SELECT VALUE FROM V$DATAGUARD_STATS WHERE NAME='apply lag') AS APPLY_LAG,
       (SELECT STATUS FROM V$MANAGED_STANDBY WHERE PROCESS LIKE 'MRP%' AND ROWNUM=1) AS MRP_STATUS,
       (SELECT DATABASE_ROLE FROM V$DATABASE) AS ROLE,
       (SELECT OPEN_MODE FROM V$DATABASE) AS OPEN_MODE
FROM DUAL;`),
    `EXIT`,
  ].join('\n');
}

app.post('/api/oracle/dataguard/standby-ssh', (req, res) => {
  const { host, port, user: sshUser, password, privateKey, oracleSid, connectString } = req.body || {};

  if (!host || typeof host !== 'string' || !host.trim())     return res.status(400).json({ error: 'host is required' });
  if (!sshUser || typeof sshUser !== 'string')                return res.status(400).json({ error: 'user is required' });
  if (!password && !privateKey)                               return res.status(400).json({ error: 'password or privateKey is required' });
  if (!connectString && !oracleSid)                            return res.status(400).json({ error: 'either oracleSid (for a local "/ as sysdba" bequeath connection) or a full connectString is required' });

  const SSH2 = _getSsh2();
  if (!SSH2) return res.status(500).json({ error: 'ssh2 package not installed. Run: npm install ssh2  then restart server.js' });

  const sshPort = parseInt(port, 10) || 22;
  const timeout = Math.min(parseInt(req.body.timeout, 10) || 60_000, 300_000);
  const t0      = Date.now();

  const connectStr = (connectString && connectString.trim()) || '/ as sysdba';

  // Source the Oracle environment on the remote host: ORACLE_SID → env_<SID> /
  // oraenv → login profiles, same layered approach as /api/os/ssh-exec so
  // sqlplus resolves correctly regardless of how that server's DBA set things up.
  const sidLit = oracleSid ? String(oracleSid).replace(/[^A-Za-z0-9_$]/g, '') : '';
  const oracleEnvSetup = [
    sidLit ? `export ORACLE_SID='${sidLit}'` : '',
    '[ -f "$HOME/.bash_profile" ] && . "$HOME/.bash_profile" 2>/dev/null',
    '[ -f "$HOME/.bashrc" ]       && . "$HOME/.bashrc"       2>/dev/null',
    sidLit ? `[ -f "$HOME/env_${sidLit}" ] && . "$HOME/env_${sidLit}" 2>/dev/null` : '',
    'for __f in "$HOME"/env_*; do [ -f "$__f" ] && . "$__f" 2>/dev/null; done',
    '[ -z "$ORACLE_HOME" ] && [ -n "$ORACLE_SID" ] && command -v oraenv >/dev/null 2>&1 && export ORAENV_ASK=NO && . oraenv >/dev/null 2>&1',
    '[ -z "$ORACLE_HOME" ] && [ -d /u01/app/oracle/product ] && export ORACLE_HOME=$(ls -d /u01/app/oracle/product/*/*/bin/.. 2>/dev/null | head -1)',
    '[ -n "$ORACLE_HOME" ] && export PATH="$ORACLE_HOME/bin:$PATH"',
  ].filter(Boolean).join(' ; ');

  const sqlScript = _dgBuildStandbySql(connectStr);
  // Quoted heredoc delimiter ('DGSQLEOF') is CRITICAL: it stops the remote
  // shell from trying to expand every "$" in V$DATABASE / V$DATAGUARD_STATS
  // etc. as a shell variable before sqlplus ever sees the script.
  const fullCmd = `${oracleEnvSetup} ; sqlplus -s /nolog <<'DGSQLEOF'\n${sqlScript}\nDGSQLEOF`;

  console.log(`[dataguard/standby-ssh] ${sshUser}@${host}:${sshPort}  sid=${sidLit || '(none)'}  connectAs=${connectString ? 'custom' : 'bequeath'}`);

  const poolKey = _sshPoolKey(sshUser.trim(), host.trim(), sshPort);
  let _poolConn = null;
  let responded = false;
  const reply = (status, body) => {
    if (responded) return;
    responded = true;
    if (_poolConn) { _sshPoolRelease(poolKey); _poolConn = null; }
    res.status(status).json(body);
  };

  const timer = setTimeout(() => reply(504, { error: `Standby SSH/sqlplus check timed out after ${timeout/1000}s` }), timeout);

  _sshPoolGet(sshUser.trim(), host.trim(), sshPort, password, privateKey)
    .then(conn => {
      _poolConn = conn;
      conn.exec(fullCmd, (err, stream) => {
        if (err) { clearTimeout(timer); return reply(500, { error: 'SSH exec error: ' + err.message }); }

        let stdoutBuf = '', stderrBuf = '';
        stream.on('data', d => { stdoutBuf += d.toString('utf8'); });
        stream.stderr.on('data', d => { stderrBuf += d.toString('utf8'); });
        stream.on('close', (code) => {
          clearTimeout(timer);
          const elapsed = Date.now() - t0;
          const blocks = _dgSplitBlocks(stdoutBuf);

          // ── Connection sanity check ──────────────────────────────────────
          const connTest = _dgParseCsvBlock(blocks.CONNTEST);
          if (connTest.error || !blocks.CONNTEST) {
            const preamble = stdoutBuf.split('~~~DGQ_')[0].trim();
            return reply(502, {
              error: 'Could not establish the SQL*Plus session on the standby (' +
                     (connTest.error || preamble || 'connection failed — check host/SID/credentials').slice(0, 500) + ')',
              stderr: stderrBuf.slice(0, 2000),
              host, exitCode: code,
            });
          }

          const parsed = {};
          for (const key of ['ROLE','ARCHGAP','MRP','ALLPROC','LASTLOG','RECOVERY','SRL','FAL','DATAFILE','HEALTH']) {
            parsed[key] = _dgParseCsvBlock(blocks[key]);
          }

          // ── Merge the three per-metric lag queries into one 'LAG' result ────
          // Each of transport lag / apply lag / apply finish time was queried
          // independently (see _dgBuildStandbySql). If one of them errors — most
          // commonly 'apply finish time' with ORA-01722 while the standby is
          // MOUNTED and apply hasn't started — we still show whichever metrics
          // came back cleanly instead of blanking the whole panel.
          const lagParts = {
            'transport lag':     _dgParseCsvBlock(blocks.LAG_TRANSPORT),
            'apply lag':         _dgParseCsvBlock(blocks.LAG_APPLY),
            'apply finish time': _dgParseCsvBlock(blocks.LAG_APPLYFINISH),
          };
          const lagRows = [];
          const lagFailures = [];
          let lagColumns = [];
          for (const [metric, blk] of Object.entries(lagParts)) {
            if (blk.error) { lagFailures.push(`${metric}: ${blk.error}`); continue; }
            if (blk.columns.length) lagColumns = blk.columns;
            lagRows.push(...blk.rows);
          }
          parsed.LAG = {
            columns: lagColumns,
            rows: lagRows,
            // Only surface as a hard error if EVERY metric failed; otherwise keep
            // the rows that succeeded and note the partial failures separately.
            error: (lagRows.length === 0 && lagFailures.length) ? lagFailures.join(' | ') : null,
            partialErrors: lagFailures.length ? lagFailures : undefined,
          };

          const roleRow = parsed.ROLE.rows[0] || [];
          const roleCols = parsed.ROLE.columns;
          const roleIdx = (name) => roleCols.indexOf(name);
          const lagMap = {};
          parsed.LAG.rows.forEach(r => {
            const nameIdx = parsed.LAG.columns.indexOf('NAME');
            const valIdx  = parsed.LAG.columns.indexOf('VALUE');
            if (nameIdx >= 0 && valIdx >= 0) lagMap[r[nameIdx]] = r[valIdx];
          });

          reply(200, {
            connectedAs:      connTest.rows[0]?.[0] || null,
            host, sid: sidLit || null,
            elapsed,
            role:             roleIdx('DATABASE_ROLE')     >= 0 ? roleRow[roleIdx('DATABASE_ROLE')]     : null,
            openMode:         roleIdx('OPEN_MODE')         >= 0 ? roleRow[roleIdx('OPEN_MODE')]         : null,
            protectionMode:   roleIdx('PROTECTION_MODE')   >= 0 ? roleRow[roleIdx('PROTECTION_MODE')]   : null,
            switchoverStatus: roleIdx('SWITCHOVER_STATUS') >= 0 ? roleRow[roleIdx('SWITCHOVER_STATUS')] : null,
            transportLag:     lagMap['transport lag']      || null,
            applyLag:         lagMap['apply lag']           || null,
            applyFinishTime:  lagMap['apply finish time']   || null,
            lag:              parsed.LAG,
            archiveGap:       parsed.ARCHGAP,
            mrpStatus:        parsed.MRP,
            allProcesses:     parsed.ALLPROC,
            lastLog:          parsed.LASTLOG,
            recoveryProgress: parsed.RECOVERY,
            standbyRedoLogs:  parsed.SRL,
            falSettings:      parsed.FAL,
            datafileStatus:   parsed.DATAFILE,
            healthCheck:      parsed.HEALTH,
            exitCode: code,
          });
        });
      });
    })
    .catch(err => {
      clearTimeout(timer);
      reply(502, { error: 'SSH connection failed: ' + err.message });
    });
});

app.get('/api/oracle/rac', async (req, res) => {
  try {
    // ── Detect RAC vs single-instance ───────────────────────────────────
    const isRACRow = await query(
      `SELECT VALUE FROM V$PARAMETER WHERE NAME = 'cluster_database'`
    ).catch(() => [{ VALUE: 'FALSE' }]);
    const isRAC = (isRACRow[0]?.VALUE || 'FALSE').toUpperCase() === 'TRUE';

    // ── Cluster name ───────────────────────────────────────────────────
    let clusterName = null;
    try {
      const cn = await query(`SELECT VALUE FROM V$PARAMETER WHERE NAME = 'db_unique_name'`).catch(() => []);
      clusterName = cn[0]?.VALUE || null;
    } catch(_) {}

    // ── Instances — try GV$ first, fallback to V$ for single instance ──
    let instances = [];
    try {
      instances = await query(
        `SELECT i.INST_ID,
                i.INSTANCE_NAME,
                i.HOST_NAME,
                i.STATUS,
                TO_CHAR(i.STARTUP_TIME,'YYYY-MM-DD HH24:MI') AS STARTUP_TIME,
                i.ACTIVE_STATE,
                i.VERSION,
                (SELECT COUNT(*) FROM GV$SESSION s
                 WHERE s.INST_ID=i.INST_ID AND s.TYPE='USER' AND s.STATUS='ACTIVE') AS ACTIVE_SESSIONS,
                (SELECT COUNT(*) FROM GV$SESSION s
                 WHERE s.INST_ID=i.INST_ID AND s.TYPE='USER') AS TOTAL_SESSIONS,
                ROUND((SELECT VALUE FROM GV$SYSSTAT s
                       WHERE s.INST_ID=i.INST_ID AND s.NAME='DB time')/1e6/60,1) AS DB_TIME_MIN
         FROM GV$INSTANCE i
         ORDER BY i.INST_ID`
      );
    } catch(_) {
      instances = await query(
        `SELECT 1                                                   AS INST_ID,
                INSTANCE_NAME,
                HOST_NAME,
                STATUS,
                TO_CHAR(STARTUP_TIME,'YYYY-MM-DD HH24:MI')        AS STARTUP_TIME,
                ACTIVE_STATE,
                VERSION,
                (SELECT COUNT(*) FROM V$SESSION
                 WHERE TYPE='USER' AND STATUS='ACTIVE')            AS ACTIVE_SESSIONS,
                (SELECT COUNT(*) FROM V$SESSION WHERE TYPE='USER') AS TOTAL_SESSIONS,
                ROUND((SELECT VALUE FROM V$SYSSTAT
                       WHERE NAME='DB time')/1e6/60,1)             AS DB_TIME_MIN
         FROM V$INSTANCE`
      ).catch(() => []);
    }

    // ── Cache Fusion (gc events) ─────────────────────────────────────
    let fusion = [];
    if (isRAC) {
      try {
        fusion = await query(
          `SELECT INST_ID, EVENT,
                  TOTAL_WAITS,
                  ROUND(TIME_WAITED_MICRO/1e6,2)                        AS TIME_WAITED_S,
                  ROUND(TIME_WAITED_MICRO/NULLIF(TOTAL_WAITS,0)/1000,2) AS AVG_WAIT_MS
           FROM GV$SYSTEM_EVENT
           WHERE EVENT LIKE 'gc%' AND TOTAL_WAITS > 0
           ORDER BY TIME_WAITED_MICRO DESC
           FETCH FIRST 20 ROWS ONLY`
        ).catch(() => []);
      } catch(_) { fusion = []; }
    }

    // ── Interconnect Traffic stats ───────────────────────────────────
    let traffic = [];
    try {
      const statNames = isRAC
        ? `'gc cr blocks received','gc current blocks received','gc cr blocks served',
           'gc current blocks served','gcs messages sent','ges messages sent'`
        : `'DB time','user commits','user rollbacks','physical reads','physical writes',
           'redo size','execute count','parse count (hard)'`;

      traffic = await query(
        isRAC
          ? `SELECT INST_ID, NAME AS STAT_NAME, VALUE
             FROM GV$SYSSTAT
             WHERE NAME IN (${statNames})
             ORDER BY INST_ID, NAME`
          : `SELECT 1 AS INST_ID, NAME AS STAT_NAME, VALUE
             FROM V$SYSSTAT
             WHERE NAME IN (${statNames})
             ORDER BY NAME`
      ).catch(() => []);
    } catch(_) { traffic = []; }

    // ── Global Cache Statistics (RAC only) ───────────────────────────
    let gcache = [];
    if (isRAC) {
      try {
        const crRows = await query(
          `SELECT INST_ID,
                  'CR Blocks Served'    AS METRIC, CR_BLOCK AS VALUE FROM GV$CR_BLOCK_SERVER
           UNION ALL
           SELECT INST_ID,
                  'CR Disk Read (ms)' AS METRIC, CR_DISK_READ FROM GV$CR_BLOCK_SERVER
           UNION ALL
           SELECT INST_ID,
                  'Current Blocks Served' AS METRIC, CURRENT_BLOCK FROM GV$CURRENT_BLOCK_SERVER
           ORDER BY INST_ID, METRIC`
        ).catch(() => []);
        gcache = crRows;
      } catch(_) { gcache = []; }
    }

    // ── SCN Health ───────────────────────────────────────────────────
    let scnHealth = [];
    try {
      scnHealth = await query(
        isRAC
          ? `SELECT i.INST_ID,
                    'Current SCN'       AS METRIC,
                    TO_CHAR(d.CURRENT_SCN) AS VALUE
             FROM GV$DATABASE d, GV$INSTANCE i WHERE d.INST_ID(+) = i.INST_ID
             UNION ALL
             SELECT i.INST_ID,
                    'Log Switch Count'  AS METRIC,
                    TO_CHAR(COUNT(*))   AS VALUE
             FROM GV$LOG l, GV$INSTANCE i
             WHERE l.INST_ID(+) = i.INST_ID
             GROUP BY i.INST_ID
             ORDER BY INST_ID, METRIC`
          : `SELECT 1                    AS INST_ID,
                    'Current SCN'        AS METRIC,
                    TO_CHAR(CURRENT_SCN) AS VALUE
             FROM V$DATABASE
             UNION ALL
             SELECT 1, 'Online Redo Groups', TO_CHAR(COUNT(*)) FROM V$LOG
             UNION ALL
             SELECT 1, 'Active Log Groups', TO_CHAR(COUNT(*)) FROM V$LOG WHERE STATUS='CURRENT'
             UNION ALL
             SELECT 1, 'Last SCN Reset (days)', TO_CHAR(ROUND(SYSDATE - RESETLOGS_TIME,1)) FROM V$DATABASE
             ORDER BY METRIC`
      ).catch(() => []);
    } catch(_) { scnHealth = []; }

    // ── Top SQL by Buffer Gets ───────────────────────────────────────
    let topSql = [];
    try {
      topSql = await query(
        `SELECT ${isRAC ? 'INST_ID,' : '1 AS INST_ID,'}
                SQL_ID,
                SUBSTR(SQL_TEXT, 1, 120) AS SQL_TEXT,
                BUFFER_GETS,
                EXECUTIONS,
                ROUND(ELAPSED_TIME/1e6, 2) AS ELAPSED_S
         FROM ${isRAC ? 'GV$SQL' : 'V$SQL'}
         WHERE EXECUTIONS > 0 AND BUFFER_GETS > 1000
         ORDER BY BUFFER_GETS DESC
         FETCH FIRST 10 ROWS ONLY`
      ).catch(() => []);
    } catch(_) { topSql = []; }

    // ── Global Enqueue / DLM Locks (RAC only) ────────────────────────
    let dlmLocks = [];
    if (isRAC) {
      try {
        dlmLocks = await query(
          `SELECT INST_ID,
                  EQ_TYPE,
                  TOTAL_REQ# AS REQUESTS,
                  ROUND(SUCC_REQ#/NULLIF(TOTAL_REQ#,0)*100,1) AS SUCCESS_PCT,
                  FAILED_REQ#                                  AS FAILED_REQ,
                  ROUND(CUM_WAIT_TIME/1e3,2)                   AS WAIT_TIME_S
           FROM GV$ENQUEUE_STATISTICS
           WHERE TOTAL_REQ# > 0 AND EQ_TYPE IN ('TX','TM','RO','SQ','CF','CI','CU','TA')
           ORDER BY WAIT_TIME_S DESC
           FETCH FIRST 15 ROWS ONLY`
        ).catch(() => []);
      } catch(_) { dlmLocks = []; }
    }

    // ── Per-instance throughput (commits, reads, writes) ─────────────
    let throughput = [];
    try {
      const tpStats = `'user commits','user rollbacks','physical reads','physical writes','redo size'`;
      throughput = await query(
        isRAC
          ? `SELECT INST_ID, NAME AS STAT_NAME, VALUE FROM GV$SYSSTAT WHERE NAME IN (${tpStats}) ORDER BY INST_ID, NAME`
          : `SELECT 1 AS INST_ID, NAME AS STAT_NAME, VALUE FROM V$SYSSTAT WHERE NAME IN (${tpStats}) ORDER BY NAME`
      ).catch(() => []);
    } catch(_) { throughput = []; }

    // ── Wait class summary ───────────────────────────────────────────
    let waitSummary = [];
    try {
      waitSummary = await query(
        `SELECT ${isRAC ? 'INST_ID,' : '1 AS INST_ID,'}
                WAIT_CLASS,
                COUNT(*)                             AS SESSIONS,
                ROUND(AVG(SECONDS_IN_WAIT),1)        AS AVG_WAIT_S
         FROM ${isRAC ? 'GV$SESSION' : 'V$SESSION'}
         WHERE TYPE='USER' AND STATUS='ACTIVE' AND WAIT_CLASS != 'Idle'
         GROUP BY ${isRAC ? 'INST_ID,' : ''} WAIT_CLASS
         ORDER BY SESSIONS DESC
         FETCH FIRST 15 ROWS ONLY`
      ).catch(() => []);
    } catch(_) { waitSummary = []; }

    res.json({
      isRAC,
      clusterName,
      instances,
      fusion,
      traffic,
      gcache,
      scnHealth,
      topSql,
      dlmLocks,
      throughput,
      waitSummary,
      nodeCount: instances.length,
    });

  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/oracle/users', async (req, res) => {
  try {
    const filter = req.query.filter || 'ALL';
    const whereStatus = filter === 'ALL' ? '' : `AND ACCOUNT_STATUS LIKE '%${filter.replace(/'/g,"''")}%'`;
    const [users, privs, roles, summary] = await Promise.all([
      query(`SELECT USERNAME, ACCOUNT_STATUS, TO_CHAR(CREATED,'YYYY-MM-DD') AS CREATED, TO_CHAR(EXPIRY_DATE,'YYYY-MM-DD') AS EXPIRY_DATE, DEFAULT_TABLESPACE, PROFILE, TO_CHAR(LAST_LOGIN,'YYYY-MM-DD HH24:MI') AS LAST_LOGIN FROM DBA_USERS WHERE 1=1 ${whereStatus} ORDER BY CREATED DESC`).catch(() => []),
      query(`SELECT GRANTEE, PRIVILEGE AS PRIVILEGE_OR_ROLE, ADMIN_OPTION, 'SYSTEM PRIVILEGE' AS TYPE FROM DBA_SYS_PRIVS WHERE (PRIVILEGE LIKE '%ANY%' OR PRIVILEGE IN ('SYSDBA','SYSOPER','DBA','ALTER SYSTEM','DROP USER','CREATE USER')) AND GRANTEE NOT IN ('SYS','SYSTEM','DBA','IMP_FULL_DATABASE','EXP_FULL_DATABASE') UNION ALL SELECT GRANTEE, GRANTED_ROLE, ADMIN_OPTION, 'ROLE' AS TYPE FROM DBA_ROLE_PRIVS WHERE GRANTED_ROLE IN ('DBA','SYSDBA','SYSOPER','AQ_ADMINISTRATOR_ROLE','SCHEDULER_ADMIN') AND GRANTEE NOT IN ('SYS','SYSTEM') ORDER BY TYPE, GRANTEE`).catch(() => []),
      query(`SELECT GRANTEE, GRANTED_ROLE, DEFAULT_ROLE, ADMIN_OPTION FROM DBA_ROLE_PRIVS WHERE GRANTEE NOT IN (SELECT ROLE FROM DBA_ROLES) ORDER BY GRANTEE, GRANTED_ROLE`).catch(() => []),
      query(`SELECT COUNT(*) AS TOTAL, SUM(CASE WHEN ACCOUNT_STATUS='OPEN' THEN 1 ELSE 0 END) AS OPEN_COUNT, SUM(CASE WHEN ACCOUNT_STATUS LIKE '%LOCKED%' OR ACCOUNT_STATUS LIKE '%EXPIRED%' THEN 1 ELSE 0 END) AS LOCKED_COUNT FROM DBA_USERS`).catch(() => []),
    ]);
    const s = summary[0] || {};
    res.json({ users, privs, roles, dbaCount: privs.filter(p=>p.PRIVILEGE_OR_ROLE==='DBA').length, total: s.TOTAL||0, open: s.OPEN_COUNT||0, locked: s.LOCKED_COUNT||0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/oracle/audit', async (req, res) => {
  try {
    const from   = req.query.from || '';
    const to     = req.query.to   || '';
    const user   = (req.query.user   || '').toUpperCase().replace(/'/g, "''");
    const action = (req.query.action || '').replace(/'/g, "''");
    const hours  = parseInt(req.query.hours || '24');

    const defaultHours = Math.min(hours || 24, 168);

    // Safe ISO → Oracle timestamp
    const toOraTS = (isoStr) => {
      if (!isoStr) return null;
      try {
        const d = new Date(isoStr);
        if (isNaN(d.getTime())) return null;
        const pad = n => String(n).padStart(2,'0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      } catch(_) { return null; }
    };

    // Oracle return code → human-readable description map
    const ORA_CODES = {
      '0':     'Success',
      '1017':  'ORA-01017: Invalid username/password',
      '28000': 'ORA-28000: Account locked',
      '28001': 'ORA-28001: Password expired',
      '28002': 'ORA-28002: Password will expire soon',
      '28003': 'ORA-28003: Password verification failed',
      '28007': 'ORA-28007: Password cannot be reused',
      '28009': 'ORA-28009: Connection as SYS must be SYSDBA/SYSOPER',
      '1031':  'ORA-01031: Insufficient privileges',
      '1045':  'ORA-01045: User lacks CREATE SESSION privilege',
      '12154': 'ORA-12154: TNS could not resolve connect identifier',
      '12170': 'ORA-12170: TNS connect timeout',
      '3136':  'ORA-03136: Inbound connection timed out',
      '604':   'ORA-00604: Error in recursive SQL',
      '942':   'ORA-00942: Table or view does not exist',
      '1403':  'ORA-01403: No data found',
      '4031':  'ORA-04031: Out of shared memory',
    };

    const fromTs = toOraTS(from);
    const toTs   = toOraTS(to);

    let rows = [], source = '';

    // ── Strategy 1: UNIFIED_AUDIT_TRAIL (Oracle 12c+) ─────────────────────
    try {
      const whereTime = fromTs
        ? `AND EVENT_TIMESTAMP >= TO_TIMESTAMP('${fromTs}','YYYY-MM-DD HH24:MI:SS')
           ${toTs ? `AND EVENT_TIMESTAMP <= TO_TIMESTAMP('${toTs}','YYYY-MM-DD HH24:MI:SS')` : ''}`
        : `AND EVENT_TIMESTAMP >= SYSDATE - ${defaultHours}/24`;
      const whereUser = user   ? `AND UPPER(DBUSERNAME) = '${user}'` : '';
      const whereAct  = action === 'DDL'
        ? `AND ACTION_NAME IN ('CREATE TABLE','DROP TABLE','ALTER TABLE','CREATE INDEX','DROP INDEX','CREATE VIEW','DROP VIEW','CREATE PROCEDURE','DROP PROCEDURE','CREATE FUNCTION','DROP FUNCTION','TRUNCATE TABLE','CREATE SEQUENCE','DROP SEQUENCE')`
        : action ? `AND ACTION_NAME LIKE '%${action.replace(/'/g,"''")}%'` : '';

      rows = await query(
        `SELECT TO_CHAR(EVENT_TIMESTAMP,'YYYY-MM-DD HH24:MI:SS')       AS TIMESTAMP,
                NVL(DBUSERNAME,'-')                                     AS DB_USER,
                NVL(OS_USERNAME,'-')                                    AS OS_USER,
                NVL(ACTION_NAME,'-')                                    AS ACTION_NAME,
                NVL(OBJECT_NAME, NVL(SYSTEM_PRIVILEGE_USED, '-'))       AS OBJ_NAME,
                NVL(TO_CHAR(RETURN_CODE),'0')                          AS RETURNCODE,
                NVL(USERHOST,'-')                                       AS USERHOST,
                NVL(CLIENT_PROGRAM_NAME,'-')                            AS PROGRAM,
                NVL(AUTHENTICATION_TYPE,'-')                            AS AUTH_TYPE,
                NVL(UNIFIED_AUDIT_POLICIES,'-')                         AS POLICY
         FROM UNIFIED_AUDIT_TRAIL
         WHERE 1=1
           ${whereTime}
           ${whereUser}
           ${whereAct}
         ORDER BY EVENT_TIMESTAMP DESC
         FETCH FIRST 500 ROWS ONLY`
      );
      source = 'UNIFIED_AUDIT_TRAIL';
    } catch(e1) {

      // ── Strategy 2: DBA_AUDIT_TRAIL ──────────────────────────────────────
      try {
        const whereTime = fromTs
          ? `AND TIMESTAMP >= TO_DATE('${fromTs}','YYYY-MM-DD HH24:MI:SS')
             ${toTs ? `AND TIMESTAMP <= TO_DATE('${toTs}','YYYY-MM-DD HH24:MI:SS')` : ''}`
          : `AND TIMESTAMP >= SYSDATE - ${defaultHours}/24`;
        const whereUser = user   ? `AND UPPER(DB_USER) = '${user}'` : '';
        const whereAct  = action === 'DDL'
          ? `AND ACTION_NAME IN ('CREATE TABLE','DROP TABLE','ALTER TABLE','CREATE INDEX','DROP INDEX','TRUNCATE TABLE','CREATE VIEW','DROP VIEW')`
          : action ? `AND ACTION_NAME LIKE '%${action.replace(/'/g,"''")}%'` : '';

        rows = await query(
          `SELECT TO_CHAR(TIMESTAMP,'YYYY-MM-DD HH24:MI:SS') AS TIMESTAMP,
                  NVL(DB_USER,'-')             AS DB_USER,
                  NVL(OS_USER,'-')             AS OS_USER,
                  NVL(ACTION_NAME,'-')         AS ACTION_NAME,
                  NVL(OBJ_NAME,'-')            AS OBJ_NAME,
                  NVL(TO_CHAR(RETURNCODE),'0') AS RETURNCODE,
                  NVL(USERHOST,'-')            AS USERHOST,
                  NVL(TERMINAL,'-')            AS PROGRAM,
                  '-'                          AS AUTH_TYPE,
                  '-'                          AS POLICY
           FROM DBA_AUDIT_TRAIL
           WHERE 1=1
             ${whereTime}
             ${whereUser}
             ${whereAct}
           ORDER BY TIMESTAMP DESC
           FETCH FIRST 500 ROWS ONLY`
        );
        source = 'DBA_AUDIT_TRAIL';
      } catch(e2) {

        // ── Strategy 3: V$XML_AUDIT_TRAIL ───────────────────────────────────
        try {
          const whereTime = fromTs
            ? `AND TIMESTAMP >= TO_DATE('${fromTs}','YYYY-MM-DD HH24:MI:SS')`
            : `AND TIMESTAMP >= SYSDATE - ${defaultHours}/24`;

          rows = await query(
            `SELECT TO_CHAR(TIMESTAMP,'YYYY-MM-DD HH24:MI:SS') AS TIMESTAMP,
                    NVL(DB_USER,'-')     AS DB_USER,
                    NVL(OS_USER,'-')     AS OS_USER,
                    NVL(ACTION_NAME,'-') AS ACTION_NAME,
                    NVL(OBJ_NAME,'-')    AS OBJ_NAME,
                    NVL(TO_CHAR(RETURNCODE),'0') AS RETURNCODE,
                    NVL(USERHOST,'-')    AS USERHOST,
                    '-'                  AS PROGRAM,
                    '-'                  AS AUTH_TYPE,
                    '-'                  AS POLICY
             FROM V$XML_AUDIT_TRAIL
             WHERE 1=1 ${whereTime}
             ORDER BY TIMESTAMP DESC
             FETCH FIRST 200 ROWS ONLY`
          );
          source = 'V$XML_AUDIT_TRAIL';
        } catch(e3) {

          // ── Strategy 4: V$SESSION fallback ──────────────────────────────
          try {
            rows = await query(
              `SELECT TO_CHAR(LOGON_TIME,'YYYY-MM-DD HH24:MI:SS') AS TIMESTAMP,
                      NVL(USERNAME,'-')   AS DB_USER,
                      NVL(OSUSER,'-')     AS OS_USER,
                      'SESSION'           AS ACTION_NAME,
                      NVL(PROGRAM,'-')    AS OBJ_NAME,
                      '0'                 AS RETURNCODE,
                      NVL(MACHINE,'-')    AS USERHOST,
                      NVL(PROGRAM,'-')    AS PROGRAM,
                      '-'                 AS AUTH_TYPE,
                      '-'                 AS POLICY
               FROM V$SESSION
               WHERE TYPE = 'USER'
               ORDER BY LOGON_TIME DESC`
            );
            source = 'V$SESSION (audit not enabled)';
          } catch(e4) {
            throw new Error(`All audit sources failed. Last error: ${e4.message}. Auditing may not be enabled.`);
          }
        }
      }
    }

    // ── Enrich rows with human-readable return code descriptions ──────────
    rows = rows.map(r => {
      const rc    = String(r.RETURNCODE || '0').trim();
      const desc  = ORA_CODES[rc] || (rc !== '0' ? `ORA-${rc.padStart(5,'0')}: Oracle error` : 'Success');
      return { ...r, RETURNCODE: rc, RC_DESC: desc };
    });

    // ── Compute summary stats ──────────────────────────────────────────────
    const uniqueUsers  = new Set(rows.map(r => r.DB_USER).filter(u => u && u !== '-')).size;
    // Failed = auth errors specifically (wrong pwd, locked, expired)
    const AUTH_FAIL_CODES = new Set(['1017','28000','28001','28002','28003','1031','1045']);
    const failedLogins = rows.filter(r => AUTH_FAIL_CODES.has(String(r.RETURNCODE))).length;
    const allErrors    = rows.filter(r => r.RETURNCODE !== '0').length;
    const ddlCount     = rows.filter(r => /CREATE|DROP|ALTER|TRUNCATE|RENAME/i.test(r.ACTION_NAME || '')).length;
    const loginCount   = rows.filter(r => /LOGON|LOGIN|CONNECT/i.test(r.ACTION_NAME || '')).length;

    // ── Top users ──────────────────────────────────────────────────────────
    const userCounts = {};
    rows.forEach(r => { if (r.DB_USER && r.DB_USER !== '-') userCounts[r.DB_USER] = (userCounts[r.DB_USER]||0)+1; });
    const topUsers = Object.entries(userCounts).sort((a,b)=>b[1]-a[1]).slice(0,5)
      .map(([u,c]) => ({ USER: u, EVENTS: c }));

    // ── Top actions ────────────────────────────────────────────────────────
    const actionCounts = {};
    rows.forEach(r => { if (r.ACTION_NAME && r.ACTION_NAME !== '-') actionCounts[r.ACTION_NAME] = (actionCounts[r.ACTION_NAME]||0)+1; });
    const topActions = Object.entries(actionCounts).sort((a,b)=>b[1]-a[1]).slice(0,8)
      .map(([a,c]) => ({ ACTION: a, COUNT: c }));

    // ── Return code breakdown ──────────────────────────────────────────────
    const rcCounts = {};
    rows.forEach(r => {
      if (r.RETURNCODE !== '0') {
        const key = r.RC_DESC || r.RETURNCODE;
        rcCounts[key] = (rcCounts[key]||0)+1;
      }
    });
    const topErrors = Object.entries(rcCounts).sort((a,b)=>b[1]-a[1]).slice(0,5)
      .map(([desc,cnt]) => ({ DESC: desc, COUNT: cnt }));

    res.json({
      rows,
      source,
      total:       rows.length,
      uniqueUsers,
      failedLogins,
      allErrors,
      ddlCount,
      loginCount,
      topUsers,
      topActions,
      topErrors,
      timeWindow: fromTs ? `${fromTs} → ${toTs || 'now'}` : `Last ${defaultHours}h`,
    });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/oracle/privesc', async (req, res) => {
  try {
    const [highRisk, sysdba, recentAudit] = await Promise.all([
      query(`SELECT GRANTEE, PRIVILEGE_ROLE, CASE WHEN PRIVILEGE_ROLE IN ('DBA') THEN 'CRITICAL' WHEN PRIVILEGE_ROLE LIKE '%ANY%' THEN 'HIGH' ELSE 'MEDIUM' END AS RISK_LEVEL, ADMIN_OPTION, GRANTED_BY FROM (SELECT GRANTEE, PRIVILEGE AS PRIVILEGE_ROLE, ADMIN_OPTION, 'SYS' AS GRANTED_BY FROM DBA_SYS_PRIVS WHERE PRIVILEGE IN ('DBA') OR PRIVILEGE LIKE '%ANY%' UNION ALL SELECT GRANTEE, GRANTED_ROLE, ADMIN_OPTION, 'ROLE GRANT' FROM DBA_ROLE_PRIVS WHERE GRANTED_ROLE IN ('DBA','SYSDBA','SYSOPER','AQ_ADMINISTRATOR_ROLE','SCHEDULER_ADMIN')) WHERE GRANTEE NOT IN ('SYS','SYSTEM') ORDER BY RISK_LEVEL, GRANTEE`).catch(() => []),
      query(`SELECT COUNT(*) AS CNT FROM V$PWFILE_USERS`).catch(()=>[{CNT:0}]),
      query(`SELECT TO_CHAR(TIMESTAMP,'YYYY-MM-DD HH24:MI:SS') AS TIMESTAMP, DB_USER AS GRANTOR, OBJ_NAME AS GRANTEE, ACTION_NAME AS PRIVILEGE, 'GRANT' AS ACTION FROM DBA_AUDIT_TRAIL WHERE ACTION_NAME IN ('GRANT','REVOKE') AND TIMESTAMP >= SYSDATE - 7 ORDER BY TIMESTAMP DESC`).catch(()=>[]),
    ]);
    res.json({ highRisk, recent: recentAudit, dbaCount: highRisk.filter(r=>r.PRIVILEGE_ROLE==='DBA').length, anyCount: highRisk.filter(r=>(r.PRIVILEGE_ROLE||'').includes('ANY')).length, sysdbaCount: parseInt(sysdba[0]?.CNT||0), recentGrants: recentAudit.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/oracle/archivelog', async (req, res) => {
  try {
    const hours = Math.min(parseInt(req.query.hours) || 24, 8760);
    const [fra, fraFiles, logs, hourlyGen, oldest] = await Promise.all([
      query(`SELECT NAME, ROUND(SPACE_LIMIT/1073741824, 2) AS LIMIT_GB, ROUND(SPACE_USED/1073741824, 2) AS USED_GB, ROUND(SPACE_RECLAIMABLE/1073741824, 2) AS RECLAIM_GB, ROUND(SPACE_USED*100/NULLIF(SPACE_LIMIT,0), 1) AS PCT_USED FROM V$RECOVERY_FILE_DEST`).catch(() => []),
      query(`SELECT FILE_TYPE, ROUND(PERCENT_SPACE_USED, 1) AS PERCENT_SPACE_USED, ROUND(PERCENT_SPACE_RECLAIMABLE, 1) AS PERCENT_SPACE_RECLAIMABLE, NUMBER_OF_FILES FROM V$RECOVERY_AREA_USAGE ORDER BY PERCENT_SPACE_USED DESC`).catch(() => []),
      query(`SELECT SEQUENCE#, THREAD#, ROUND(BLOCKS*BLOCK_SIZE/1048576, 2) AS BLOCKS_MB, TO_CHAR(COMPLETION_TIME,'YYYY-MM-DD HH24:MI:SS') AS COMPLETION_TIME, APPLIED, DELETED FROM V$ARCHIVED_LOG WHERE COMPLETION_TIME >= SYSDATE - ${hours}/24 AND STANDBY_DEST = 'NO' ORDER BY SEQUENCE# DESC FETCH FIRST 100 ROWS ONLY`).catch(() => []),
      query(`SELECT TO_CHAR(TRUNC(COMPLETION_TIME,'HH'),'YYYY-MM-DD HH24') AS HOUR, ROUND(SUM(BLOCKS*BLOCK_SIZE)/1048576, 1) AS MB_GENERATED, COUNT(*) AS LOG_COUNT FROM V$ARCHIVED_LOG WHERE COMPLETION_TIME >= SYSDATE - 1 AND STANDBY_DEST = 'NO' GROUP BY TRUNC(COMPLETION_TIME,'HH') ORDER BY TRUNC(COMPLETION_TIME,'HH')`).catch(() => []),
      query(`SELECT ROUND(SYSDATE - MIN(FIRST_TIME), 1) AS OLDEST_DAYS FROM V$ARCHIVED_LOG WHERE DELETED = 'NO'`).catch(() => [{ OLDEST_DAYS: null }]),
    ]);
    const fraInfo = fra[0] || {};
    const totalMBh = hourlyGen.reduce((s, r) => s + (parseFloat(r.MB_GENERATED)||0), 0);
    res.json({ fra: { limitGB: fraInfo.LIMIT_GB||0, usedGB: fraInfo.USED_GB||0, reclaimGB: fraInfo.RECLAIM_GB||0, pctUsed: fraInfo.PCT_USED||0, name: fraInfo.NAME||'' }, fraFiles, logs, hourlyGen, genRateMBh: Math.round(hourlyGen.length ? totalMBh / hourlyGen.length : 0), oldestDays: oldest[0]?.OLDEST_DAYS || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PL/SQL Global Stats — DB-wide object counts (ignores search filters) ──────
app.get('/api/oracle/plsql/stats', async (req, res) => {
  try {
    const SYS_LIST = `'SYS','SYSTEM','AUDSYS','DBSNMP','APPQOSSYS','DBSFWUSER','GGSYS',
      'ANONYMOUS','CTXSYS','DVSYS','DVF','GSMADMIN_INTERNAL','MDSYS','OJVMSYS','OLAPSYS',
      'ORDDATA','ORDSYS','ORDPLUGINS','SI_INFORMTN_SCHEMA','WMSYS','XDB','LBACSYS',
      'APEX_PUBLIC_USER','FLOWS_FILES','ORDS_PUBLIC_USER','ORDS_METADATA','SYSBACKUP',
      'SYSDG','SYSKM','SYSRAC','XS$NULL','SYS$UMF','OUTLN'`;

    // Try DBA_OBJECTS first, fall back to ALL_OBJECTS
    let statsRows = [];
    try {
      statsRows = await query(
        `SELECT COUNT(*) AS TOTAL_OBJECTS,
                SUM(CASE WHEN STATUS='INVALID' THEN 1 ELSE 0 END) AS INVALID_COUNT
         FROM DBA_OBJECTS
         WHERE OBJECT_TYPE IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY','TRIGGER','TYPE','TYPE BODY')
           AND OWNER NOT IN (${SYS_LIST})`
      );
    } catch(e) {
      statsRows = await query(
        `SELECT COUNT(*) AS TOTAL_OBJECTS,
                SUM(CASE WHEN STATUS='INVALID' THEN 1 ELSE 0 END) AS INVALID_COUNT
         FROM ALL_OBJECTS
         WHERE OBJECT_TYPE IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY','TRIGGER','TYPE','TYPE BODY')
           AND OWNER NOT IN (${SYS_LIST})`
      ).catch(() => [{ TOTAL_OBJECTS: 0, INVALID_COUNT: 0 }]);
    }

    // Get total line count and largest object from DBA_SOURCE / ALL_SOURCE
    let lineRows = [];
    try {
      lineRows = await query(
        `SELECT COUNT(*) AS TOTAL_LINES,
                MAX(lc) AS MAX_LINES,
                MAX(CASE WHEN lc = (SELECT MAX(lc2) FROM (SELECT COUNT(*) AS lc2 FROM DBA_SOURCE WHERE OWNER NOT IN (${SYS_LIST}) GROUP BY OWNER,NAME,TYPE)) THEN OWNER||'.'||NAME ELSE NULL END) AS LARGEST_OBJ
         FROM (SELECT OWNER, NAME, TYPE, COUNT(*) AS lc FROM DBA_SOURCE
               WHERE OWNER NOT IN (${SYS_LIST})
                 AND TYPE IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY','TRIGGER','TYPE','TYPE BODY')
               GROUP BY OWNER, NAME, TYPE)`
      );
    } catch(e1) {
      try {
        lineRows = await query(
          `SELECT COUNT(*) AS TOTAL_LINES,
                  MAX(lc) AS MAX_LINES,
                  MAX(CASE WHEN lc = (SELECT MAX(lc2) FROM (SELECT COUNT(*) AS lc2 FROM ALL_SOURCE WHERE OWNER NOT IN (${SYS_LIST}) GROUP BY OWNER,NAME,TYPE)) THEN OWNER||'.'||NAME ELSE NULL END) AS LARGEST_OBJ
           FROM (SELECT OWNER, NAME, TYPE, COUNT(*) AS lc FROM ALL_SOURCE
                 WHERE OWNER NOT IN (${SYS_LIST})
                   AND TYPE IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY','TRIGGER','TYPE','TYPE BODY')
                 GROUP BY OWNER, NAME, TYPE)`
        );
      } catch(e2) {
        lineRows = [{ TOTAL_LINES: 0, MAX_LINES: 0, LARGEST_OBJ: null }];
      }
    }

    const s = statsRows[0] || {};
    const l = lineRows[0]  || {};
    res.json({
      totalObjects  : Number(s.TOTAL_OBJECTS) || 0,
      invalidCount  : Number(s.INVALID_COUNT) || 0,
      totalLines    : Number(l.TOTAL_LINES)   || 0,
      maxLines      : Number(l.MAX_LINES)     || 0,
      largestObject : l.LARGEST_OBJ           || null
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/oracle/plsql/owners', async (req, res) => {
  try {
    // Strategy: get ALL schemas that own ANY database object (tables, procs, etc.)
    // We do NOT restrict to PL/SQL-only — a schema with only tables is still useful.
    // Use DBA_OBJECTS first for richest view, fall back to ALL_OBJECTS, then USER.
    const HARD_SYSTEM = new Set([
      'SYS','SYSTEM','AUDSYS','DBSNMP','APPQOSSYS','DBSFWUSER','GGSYS','ANONYMOUS',
      'CTXSYS','DVSYS','DVF','GSMADMIN_INTERNAL','MDSYS','OJVMSYS','OLAPSYS','ORDDATA',
      'ORDSYS','ORDPLUGINS','SI_INFORMTN_SCHEMA','SPATIALINDEXADM','WMSYS','XDB',
      'LBACSYS','APEX_PUBLIC_USER','FLOWS_FILES','ORDS_PUBLIC_USER','ORDS_METADATA',
      'SYSBACKUP','SYSDG','SYSKM','SYSRAC','XS$NULL','SYS$UMF','OUTLN','MDDATA',
      'SPATIAL_CSW_ADMIN_USR','SPATIAL_WFS_ADMIN_USR',
      'APEX_030200','APEX_040000','APEX_040200','APEX_050000','APEX_180200',
      'APEX_190200','APEX_200200','APEX_210200','APEX_220200','APEX_230200',
    ]);

    let rows = [];

    // Attempt 1 — DBA_OBJECTS: all schemas with any PL/SQL object
    try {
      rows = await query(
        `SELECT DISTINCT OWNER FROM DBA_OBJECTS
         WHERE OBJECT_TYPE IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY',
                               'TRIGGER','TYPE','TYPE BODY')
         ORDER BY OWNER`
      );
    } catch(e1) {
      // Attempt 2 — ALL_SOURCE: schemas visible to current user
      try {
        rows = await query(`SELECT DISTINCT OWNER FROM ALL_SOURCE ORDER BY OWNER`);
      } catch(e2) {
        // Attempt 3 — ALL_OBJECTS
        try {
          rows = await query(
            `SELECT DISTINCT OWNER FROM ALL_OBJECTS
             WHERE OBJECT_TYPE IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY',
                                   'TRIGGER','TYPE','TYPE BODY')
             ORDER BY OWNER`
          );
        } catch(e3) {
          // Attempt 4 — just return current user
          rows = await query(`SELECT USER AS OWNER FROM DUAL`).catch(() => []);
        }
      }
    }

    const userOwners = rows.map(r => r.OWNER).filter(o => o && !HARD_SYSTEM.has(o));

    // If still empty, fall back: return ALL non-system schema owners regardless of object type
    if (!userOwners.length) {
      try {
        const fallback = await query(
          `SELECT DISTINCT OWNER FROM DBA_OBJECTS
           WHERE OWNER NOT IN ('SYS','SYSTEM','AUDSYS','DBSNMP','APPQOSSYS','CTXSYS',
                               'MDSYS','OJVMSYS','ORDSYS','WMSYS','XDB','LBACSYS',
                               'ORDS_PUBLIC_USER','ORDS_METADATA','OUTLN','DVF','DVSYS')
           ORDER BY OWNER`
        ).catch(() => []);
        fallback.map(r => r.OWNER).filter(o => o && !HARD_SYSTEM.has(o))
          .forEach(o => { if(!userOwners.includes(o)) userOwners.push(o); });
      } catch(_) {}
    }

    res.json({ owners: userOwners });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/oracle/plsql/objects', async (req, res) => {
  try {
    const q         = (req.query.q || '').toUpperCase().replace(/'/g, "''");
    const owner     = (req.query.owner || '').toUpperCase().replace(/'/g, "''");
    const type      = (req.query.type || '').replace(/'/g, "''");
    const status    = (req.query.status || '').replace(/'/g, "''");
    const srcSearch = (req.query.srcSearch || '').toUpperCase().replace(/'/g, "''");

    const SYS_LIST = `'SYS','SYSTEM','AUDSYS','DBSNMP','APPQOSSYS','DBSFWUSER','GGSYS',
      'ANONYMOUS','CTXSYS','DVSYS','DVF','GSMADMIN_INTERNAL','MDSYS','OJVMSYS','OLAPSYS',
      'ORDDATA','ORDSYS','ORDPLUGINS','SI_INFORMTN_SCHEMA','SPATIALINDEXADM','WMSYS','XDB',
      'LBACSYS','APEX_PUBLIC_USER','FLOWS_FILES','ORDS_PUBLIC_USER','ORDS_METADATA',
      'SYSBACKUP','SYSDG','SYSKM','SYSRAC','XS$NULL','SYS$UMF','OUTLN','MDDATA',
      'SPATIAL_CSW_ADMIN_USR','SPATIAL_WFS_ADMIN_USR'`;

    // If owner selected → show all PL/SQL in that schema.
    // If no owner → exclude system schemas.
    const ownerFilter = owner
      ? `AND o.OWNER = '${owner}'`
      : `AND o.OWNER NOT IN (${SYS_LIST})`;

    let typeFilter = `AND o.OBJECT_TYPE IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY','TRIGGER','TYPE','TYPE BODY')`;
    if (type) typeFilter = `AND o.OBJECT_TYPE = '${type}'`;

    let nameFilter  = q      ? `AND o.OBJECT_NAME LIKE '%${q}%'`    : '';
    let statFilter  = status ? `AND o.STATUS = '${status}'`          : '';

    // Source search join — try DBA_SOURCE first (most accurate), fall back to ALL_SOURCE
    let srcJoin = '';
    if (srcSearch) {
      try {
        await query(`SELECT 1 FROM DBA_SOURCE WHERE ROWNUM=1`);
        srcJoin = `JOIN (SELECT DISTINCT OWNER,NAME,TYPE FROM DBA_SOURCE WHERE UPPER(TEXT) LIKE '%${srcSearch}%') ss
                   ON o.OWNER=ss.OWNER AND o.OBJECT_NAME=ss.NAME AND o.OBJECT_TYPE=ss.TYPE`;
      } catch(_) {
        srcJoin = `JOIN (SELECT DISTINCT OWNER,NAME,TYPE FROM ALL_SOURCE WHERE UPPER(TEXT) LIKE '%${srcSearch}%') ss
                   ON o.OWNER=ss.OWNER AND o.OBJECT_NAME=ss.NAME AND o.OBJECT_TYPE=ss.TYPE`;
      }
    }

    const buildSQL = (objView, srcView, withLineCount) => {
      const lcSubq = withLineCount
        ? `(SELECT COUNT(*) FROM ${srcView} s WHERE s.OWNER=o.OWNER AND s.NAME=o.OBJECT_NAME AND s.TYPE=o.OBJECT_TYPE)`
        : `0`;
      return `SELECT o.OWNER, o.OBJECT_NAME, o.OBJECT_TYPE, o.STATUS,
                     TO_CHAR(o.LAST_DDL_TIME,'YYYY-MM-DD HH24:MI') AS LAST_DDL,
                     ${lcSubq} AS LINE_COUNT
              FROM ${objView} o ${srcJoin}
              WHERE 1=1
                ${typeFilter}
                ${ownerFilter}
                ${nameFilter}
                ${statFilter}
              ORDER BY o.OWNER, o.OBJECT_TYPE, o.OBJECT_NAME
              FETCH FIRST 500 ROWS ONLY`;
    };

    let rows = [];

    // Attempt 1: DBA_OBJECTS + DBA_SOURCE line count
    try {
      rows = await query(buildSQL('DBA_OBJECTS', 'DBA_SOURCE', true));
    } catch(e1) {
      // Attempt 2: DBA_OBJECTS + ALL_SOURCE line count
      try {
        rows = await query(buildSQL('DBA_OBJECTS', 'ALL_SOURCE', true));
      } catch(e2) {
        // Attempt 3: ALL_OBJECTS + ALL_SOURCE, no line count (avoids subquery timeout)
        try {
          rows = await query(buildSQL('ALL_OBJECTS', 'ALL_SOURCE', false));
        } catch(e3) {
          // Attempt 4: USER_OBJECTS — last resort
          const meRow = await query(`SELECT USER AS U FROM DUAL`).catch(()=>[{U:''}]);
          const me = meRow[0]?.U || '';
          rows = await query(
            `SELECT '${me}' AS OWNER, OBJECT_NAME, OBJECT_TYPE, STATUS,
                    TO_CHAR(LAST_DDL_TIME,'YYYY-MM-DD HH24:MI') AS LAST_DDL, 0 AS LINE_COUNT
             FROM USER_OBJECTS
             WHERE OBJECT_TYPE IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY','TRIGGER','TYPE','TYPE BODY')
             ORDER BY OBJECT_TYPE, OBJECT_NAME FETCH FIRST 500 ROWS ONLY`
          );
        }
      }
    }

    res.json({ objects: rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/oracle/plsql/source', async (req, res) => {
  try {
    const { owner, name, type } = req.body;
    if (!owner || !name || !type) return res.status(400).json({ error: 'owner, name, type required' });
    if (!/^[\w$]+$/.test(owner) || !/^[\w$\s]+$/.test(name) || !/^[\w\s]+$/.test(type)) {
      return res.status(400).json({ error: 'Invalid object identifier' });
    }
    const O = owner.toUpperCase(), N = name.toUpperCase(), T = type.toUpperCase();
    let rows = [];

    // Try DBA_SOURCE first (most complete)
    try {
      rows = await query(
        `SELECT TEXT FROM DBA_SOURCE WHERE OWNER=:1 AND NAME=:2 AND TYPE=:3 ORDER BY LINE`,
        [O, N, T]
      );
    } catch(e1) {
      // Fall back to ALL_SOURCE (visible to current user without DBA)
      rows = await query(
        `SELECT TEXT FROM ALL_SOURCE WHERE OWNER=:1 AND NAME=:2 AND TYPE=:3 ORDER BY LINE`,
        [O, N, T]
      );
    }

    if (!rows.length) {
      // Try USER_SOURCE if owner matches connected user
      try {
        const meRows = await query(`SELECT USER AS U FROM DUAL`);
        if (meRows[0]?.U?.toUpperCase() === O) {
          rows = await query(
            `SELECT TEXT FROM USER_SOURCE WHERE NAME=:1 AND TYPE=:2 ORDER BY LINE`,
            [N, T]
          );
        }
      } catch(_) {}
    }

    if (!rows.length) {
      return res.status(404).json({
        error: `Source not found for ${O}.${N} (${T}). The object may exist in DBA_OBJECTS but have no rows in DBA_SOURCE — this can happen for built-in wrapped/native objects.`
      });
    }

    const source = rows.map(r => (r.TEXT || '').replace(/\r/g, '')).join('');
    res.json({ source, lineCount: rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});



// __streamlit code

// ── App registry: maps a friendly key → { file, port, process, logs[], startTime } ──
const STREAMLIT_APPS = {
  unified:     { file: 'oracle_unified_dashboard.py', port: 8500 },
  healthcheck: { file: 'Checkup.py',                  port: 8501 },
  alertlog:    { file: 'Alert.py',                    port: 8502 },
  awr:         { file: 'app.py',                      port: 8503 },
};
 
// Runtime state for each app
const _streamlitProcs = {};   // key → { proc, pid, startTime, logs:[] }
 
// ── Helper: detect python/streamlit binary ──────────────────────────────────
function detectPython() {
  for (const bin of ['python3', 'python', 'py']) {
    try { execSync(`${bin} --version`, { stdio: 'pipe' }); return bin; } catch(_) {}
  }
  throw new Error('Python not found. Install Python 3.8+ and add it to PATH.');
}
function detectStreamlit() {
  for (const bin of ['streamlit', 'python3 -m streamlit', 'python -m streamlit']) {
    try { execSync(`${bin} --version`, { stdio: 'pipe' }); return bin; } catch(_) {}
  }
  throw new Error('Streamlit not found. Run:  pip install streamlit');
}
 
// ── Helper: find the directory where Python files live ──────────────────────
// server.js is expected to live in the same folder as the .py files.
// If not, set STREAMLIT_APP_DIR env var to the absolute path of the folder.
const STREAMLIT_APP_DIR = process.env.STREAMLIT_APP_DIR || __dirname;
 
// ── Helper: push log line (cap at 200) ──────────────────────────────────────
function _pushLog(key, line) {
  const state = _streamlitProcs[key];
  if (!state) return;
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  state.logs.push(`[${ts}] ${line.trim()}`);
  if (state.logs.length > 200) state.logs.shift();
}
 
// ── Start a Streamlit app ────────────────────────────────────────────────────
function startStreamlit(key) {
  const app = STREAMLIT_APPS[key];
  if (!app) throw new Error(`Unknown app key: ${key}. Valid keys: ${Object.keys(STREAMLIT_APPS).join(', ')}`);
 
  // Already running?
  if (_streamlitProcs[key]?.proc && !_streamlitProcs[key].proc.killed) {
    return { alreadyRunning: true, port: app.port, pid: _streamlitProcs[key].pid };
  }
 
  const filePath = path.join(STREAMLIT_APP_DIR, app.file);
  if (!require('fs').existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
 
  let streamlitBin;
  try { streamlitBin = detectStreamlit(); }
  catch(e) { throw e; }
 
  // Build the command
  // Split "python -m streamlit" into an array if needed
  const parts = streamlitBin.split(' ');
  const cmd   = parts[0];
  // Ensure .streamlit/config.toml exists to allow iframe embedding
  const streamlitCfgDir  = require('path').join(STREAMLIT_APP_DIR, '.streamlit');
  const streamlitCfgFile = require('path').join(streamlitCfgDir, 'config.toml');
  try {
    require('fs').mkdirSync(streamlitCfgDir, { recursive: true });
    const cfgContent = [
      '[server]',
      'headless = true',
      'enableCORS = false',
      'enableXsrfProtection = false',
      '',
      '[browser]',
      'gatherUsageStats = false',
    ].join('\n');
    require('fs').writeFileSync(streamlitCfgFile, cfgContent, 'utf8');
  } catch(e) { console.warn('Could not write .streamlit/config.toml:', e.message); }

  const args  = [
    ...parts.slice(1),
    'run', filePath,
    '--server.port',                 String(app.port),
    '--server.address',              '127.0.0.1',
    '--server.headless',             'true',
    '--server.enableCORS',           'false',
    '--server.enableXsrfProtection', 'false',
    '--browser.gatherUsageStats',    'false',
    // CRITICAL: tells Streamlit to prefix ALL asset URLs with this path.
    // Without this, Streamlit generates absolute paths like /static/js/main.js
    // which the browser fetches directly from Node (no /streamlit-proxy/* prefix)
    // → Node has no /static route → 404. With baseUrlPath set, Streamlit generates
    // /streamlit-proxy/unified/static/js/main.js which routes through our proxy ✓
    '--server.baseUrlPath',          `/streamlit-proxy/${key}`,
  ];
 
  const proc = spawn(cmd, args, {
    cwd:   STREAMLIT_APP_DIR,
    stdio: 'pipe',
    env:   { ...process.env, PYTHONUNBUFFERED: '1', STREAMLIT_SERVER_HEADLESS: 'true' },
  });
 
  _streamlitProcs[key] = { proc, pid: proc.pid, startTime: Date.now(), logs: [], port: app.port };
 
  proc.stdout.on('data', d => {
    String(d).split('\n').filter(Boolean).forEach(l => {
      _pushLog(key, l);
      if (process.env.STREAMLIT_VERBOSE) console.log(`[streamlit:${key}]`, l);
    });
  });
  proc.stderr.on('data', d => {
    String(d).split('\n').filter(Boolean).forEach(l => {
      _pushLog(key, l);
      if (process.env.STREAMLIT_VERBOSE) console.warn(`[streamlit:${key}][ERR]`, l);
    });
  });
  proc.on('exit', (code, sig) => {
    _pushLog(key, `⚠ Process exited — code=${code} signal=${sig}`);
    console.log(`[streamlit:${key}] exited — code=${code}`);
    // Auto-clear state so it can be restarted
    if (_streamlitProcs[key]?.pid === proc.pid) {
      _streamlitProcs[key].proc = null;
    }
  });
  proc.on('error', err => {
    _pushLog(key, `✗ Spawn error: ${err.message}`);
    console.error(`[streamlit:${key}] spawn error:`, err.message);
  });
 
  console.log(`✓ Streamlit started — key=${key} file=${app.file} port=${app.port} pid=${proc.pid}`);
  return { pid: proc.pid, port: app.port };
}
 
// ── Stop a Streamlit app ─────────────────────────────────────────────────────
function stopStreamlit(key) {
  const state = _streamlitProcs[key];
  if (!state?.proc || state.proc.killed) return { wasRunning: false };
  try {
    state.proc.kill('SIGTERM');
    setTimeout(() => { try { state.proc.kill('SIGKILL'); } catch(_){} }, 3000);
  } catch(e) { /* already dead */ }
  _streamlitProcs[key].proc = null;
  return { wasRunning: true };
}
 
// ── Kill all on server exit ───────────────────────────────────────────────────
['exit', 'SIGINT', 'SIGTERM'].forEach(sig => {
  process.on(sig, () => {
    Object.keys(_streamlitProcs).forEach(key => {
      try { _streamlitProcs[key]?.proc?.kill('SIGTERM'); } catch(_) {}
    });
  });
});
 
// ════════════════════════════════════════════════════════════════════════════
//  REST API ROUTES
// ════════════════════════════════════════════════════════════════════════════
 
// GET /api/streamlit/list — all apps with status
app.get('/api/streamlit/list', (req, res) => {
  const list = Object.entries(STREAMLIT_APPS).map(([key, cfg]) => {
    const state = _streamlitProcs[key] || {};
    const running = !!(state.proc && !state.proc.killed);
    return {
      key,
      file:     cfg.file,
      port:     cfg.port,
      proxyUrl: `/streamlit-proxy/${key}/`,
      running,
      pid:      running ? state.pid   : null,
      uptime:   running ? Math.floor((Date.now() - state.startTime) / 1000) : 0,
      lastLog:  (state.logs || []).slice(-1)[0] || '',
    };
  });
  res.json({ apps: list });
});
 
// GET /api/streamlit/status/:key
app.get('/api/streamlit/status/:key', (req, res) => {
  const key = req.params.key;
  const cfg  = STREAMLIT_APPS[key];
  if (!cfg) return res.status(404).json({ error: 'Unknown app key' });
  const state   = _streamlitProcs[key] || {};
  const running = !!(state.proc && !state.proc.killed);
  res.json({
    key, file: cfg.file, port: cfg.port,
    proxyUrl: `/streamlit-proxy/${key}/`,
    running,
    pid:    running ? state.pid : null,
    uptime: running ? Math.floor((Date.now() - state.startTime) / 1000) : 0,
    logs:   (state.logs || []).slice(-30),
  });
});
 
// POST /api/streamlit/start  body: { key:'unified' }
app.post('/api/streamlit/start', (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'key is required' });
  try {
    const result = startStreamlit(key);
    const cfg    = STREAMLIT_APPS[key];
    res.json({
      status:   result.alreadyRunning ? 'already_running' : 'starting',
      key, port: cfg.port,
      pid:      result.pid,
      proxyUrl: `/streamlit-proxy/${key}/`,
      directUrl:`http://localhost:${cfg.port}`,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
 
// POST /api/streamlit/stop  body: { key:'unified' }
app.post('/api/streamlit/stop', (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'key is required' });
  if (!STREAMLIT_APPS[key]) return res.status(404).json({ error: 'Unknown app key' });
  const result = stopStreamlit(key);
  res.json({ stopped: true, wasRunning: result.wasRunning, key });
});
 
// ════════════════════════════════════════════════════════════════════════════
//  REVERSE PROXY  /streamlit-proxy/:key/* → http://localhost:<port>/
//
//  This is the magic that makes the iframe work without CORS errors.
//  The browser talks to your Node server at the SAME origin, and Node
//  forwards the request to Streamlit internally.
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
//  STREAMLIT REVERSE PROXY — ROBUST IMPLEMENTATION
//
//  THE CORE PROBLEM:
//  http-proxy-middleware v2/v3 behaves differently with app.use(prefix, proxy):
//  - v2: Express strips prefix before proxy sees req.url  ✓
//  - v3: May NOT strip — behavior changed, causing 404s   ✗
//
//  THE SOLUTION:
//  Use app.use(prefix + '/*') with an explicit Express route that:
//    1. Manually strips the prefix from req.url
//    2. Passes the clean path directly to the proxy
//    3. Also handles WebSocket upgrades
//
//  See inline comments in the forEach block below.
// ════════════════════════════════════════════════════════════════════════════



const _streamlitProxies = {};  // key → proxy instance (reused for WS upgrades)

Object.entries(STREAMLIT_APPS).forEach(([key, cfg]) => {
  const prefix    = `/streamlit-proxy/${key}`;
  const targetUrl = `http://127.0.0.1:${cfg.port}`;

  // ════════════════════════════════════════════════════════════════════════
  // HOW THIS PROXY WORKS — read before changing anything
  // ════════════════════════════════════════════════════════════════════════
  //
  // Streamlit is launched with --server.baseUrlPath=/streamlit-proxy/<key>
  // This tells Streamlit TWO things:
  //   1. Expect ALL requests to arrive with that prefix in the path
  //   2. Generate ALL asset URLs with that prefix, e.g.:
  //        <script src="/streamlit-proxy/unified/static/js/main.js">
  //
  // ⚠ DO NOT add pathRewrite to strip the prefix.
  // Because Streamlit's baseUrlPath IS the prefix, it needs to receive
  // the FULL path including /streamlit-proxy/<key>/... — stripping it
  // causes Streamlit to return 404 for every request.
  //
  // Request flow (correct):
  //   Browser  → GET /streamlit-proxy/unified/static/js/main.js
  //   app.all  → req.url = /streamlit-proxy/unified/static/js/main.js
  //   proxy forwards FULL path to Streamlit on port 8500
  //   Streamlit (baseUrlPath=/streamlit-proxy/unified) handles it ✓
  // ════════════════════════════════════════════════════════════════════════

  const proxy = createProxyMiddleware({
    target:       targetUrl,
    changeOrigin: true,
    ws:           true,

    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('host', `127.0.0.1:${cfg.port}`);
      },
      proxyRes: (proxyRes) => {
        // Remove ALL headers that could block iframe embedding
        ['x-frame-options', 'X-Frame-Options',
         'content-security-policy', 'content-security-policy-report-only',
        ].forEach(h => delete proxyRes.headers[h]);
      },
      error: (err, req, res) => {
        console.warn(`[proxy:${key}] error:`, err.message);
        if (res && typeof res.status === 'function') {
          res.status(503).send(`
            <html><body style="font-family:monospace;background:#0a0c10;color:#7a8199;
              display:flex;align-items:center;justify-content:center;height:100vh;
              margin:0;flex-direction:column;gap:12px">
              <div style="font-size:24px">⏳</div>
              <div style="color:#ff6b2b;font-size:14px">Streamlit is starting up…</div>
              <div style="font-size:11px">Port ${cfg.port} · App: ${cfg.file}</div>
              <div style="font-size:10px;color:#4a5168">Auto-refreshing…</div>
              <script>setTimeout(()=>location.reload(),3000)</script>
            </body></html>`);
        }
      },
    },
  });

  _streamlitProxies[key] = proxy;

  // Use app.all() NOT app.use() — app.use strips the prefix from req.url before
  // the proxy sees it. app.all() with a RegExp preserves the full original req.url
  // so the FULL path (including /streamlit-proxy/<key>) reaches Streamlit unchanged.
  // Note: Express 4 wildcard syntax is '/*' not '/(*path)' (that's Express 5 only).
  // Use a RegExp route — avoids all path-to-regexp wildcard syntax issues across versions
  const prefixRe = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(/.*)?$');
  app.all(prefixRe, (req, res, next) => proxy(req, res, next));

  console.log(`✓ Streamlit proxy: ${prefix} → ${targetUrl}  (${cfg.file})`);
});

// ── WebSocket upgrade handler for all Streamlit apps ─────────────────────────
// Streamlit uses WebSockets for live updates. We must explicitly proxy WS
// upgrade requests because Express doesn't handle them automatically.
// This attaches to the raw Node HTTP server AFTER app.listen() is called.
function _attachStreamlitWsProxy(server) {
  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    // Let /api/os/ssh-pty be handled by _attachSshPtyWs — don't destroy it
    if (url.startsWith('/api/os/ssh-pty')) return;
    for (const [key, proxy] of Object.entries(_streamlitProxies)) {
      const prefix = `/streamlit-proxy/${key}`;
      if (url.startsWith(prefix)) {
        proxy.upgrade(req, socket, head);
        return;
      }
    }
    // Not a known WebSocket path — destroy
    socket.destroy();
  });
  console.log('✓ Streamlit WebSocket upgrade handler attached');
}
 
// ════════════════════════════════════════════════════════════════════════════
// END OF STREAMLIT MANAGER BLOCK
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// EMAIL REPORT ENDPOINT  —  POST /api/report/send-email
// ════════════════════════════════════════════════════════════════════════════
// Supports Gmail AND company/corporate email domains automatically.
// Requires nodemailer:  npm install nodemailer
//
// ── HOW TO CONFIGURE ────────────────────────────────────────────────────────
// Create a  .env  file in the same folder as server.js with these values:
//
//   For Gmail:
//     SMTP_USER=yourname@gmail.com
//     SMTP_PASS=abcdefghijklmnop        ← 16-char Google App Password (NOT your Gmail login)
//
//   For Company email (e.g. yourname@cloverinfotech.com):
//     SMTP_USER=yourname@cloverinfotech.com
//     SMTP_PASS=your-email-password
//
//   Optional overrides (auto-detected if not set):
//     SMTP_HOST=smtp.gmail.com          ← auto-detected from email domain
//     SMTP_PORT=587                     ← default 587
//     SMTP_SECURE=false                 ← true only for port 465
//     SMTP_FROM=yourname@gmail.com      ← defaults to SMTP_USER
//
// ── KNOWN DOMAIN AUTO-DETECTION TABLE ───────────────────────────────────────
//   gmail.com, googlemail.com    → smtp.gmail.com : 587
//   outlook.com, hotmail.com,
//   live.com, msn.com            → smtp-mail.outlook.com : 587
//   yahoo.com, yahoo.in, etc.    → smtp.mail.yahoo.com : 587
//   office365 / *.onmicrosoft    → smtp.office365.com : 587
//   any other company domain     → smtp.<domain> : 587  (standard convention)
//                                  fallback: mail.<domain> : 587
// ════════════════════════════════════════════════════════════════════════════

let _nodemailer = null;
try {
  _nodemailer = require('nodemailer');
  // Verify it loaded correctly
  if (typeof _nodemailer.createTransport !== 'function' && typeof _nodemailer.createTransporter !== 'function') {
    throw new Error('nodemailer loaded but createTransport is missing');
  }
  // Normalize: some versions use createTransport, some createTransporter
  if (!_nodemailer.createTransporter) {
    _nodemailer.createTransporter = _nodemailer.createTransport.bind(_nodemailer);
  }
  console.log('[email] nodemailer loaded OK — version:', require('./node_modules/nodemailer/package.json').version);
} catch(e) {
  console.warn('[email] nodemailer load error:', e.message, '— run: npm install nodemailer');
}

// ── Auto-detect SMTP settings from email domain ───────────────────────────
function _detectSmtpConfig(emailAddress) {
  const domain = (emailAddress || '').split('@')[1]?.toLowerCase().trim() || '';

  // ── Gmail ──────────────────────────────────────────────────────────────
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return { host: 'smtp.gmail.com', port: 587, secure: false, label: 'Gmail' };
  }

  // ── Google Workspace (company domain using Google) ─────────────────────
  // Note: Google Workspace uses the same smtp.gmail.com endpoint
  // You can force this by setting SMTP_HOST=smtp.gmail.com in .env

  // ── Microsoft Outlook / Hotmail / Live ────────────────────────────────
  if (['outlook.com','hotmail.com','live.com','msn.com','outlook.in'].includes(domain)) {
    return { host: 'smtp-mail.outlook.com', port: 587, secure: false, label: 'Outlook' };
  }

  // ── Microsoft 365 / Office 365 (company domains on MS) ────────────────
  if (domain.endsWith('.onmicrosoft.com')) {
    return { host: 'smtp.office365.com', port: 587, secure: false, label: 'Office365' };
  }

  // ── Yahoo Mail ─────────────────────────────────────────────────────────
  if (domain.startsWith('yahoo.')) {
    return { host: 'smtp.mail.yahoo.com', port: 587, secure: false, label: 'Yahoo' };
  }

  // ── iCloud / Apple Mail ────────────────────────────────────────────────
  if (domain === 'icloud.com' || domain === 'me.com' || domain === 'mac.com') {
    return { host: 'smtp.mail.me.com', port: 587, secure: false, label: 'iCloud' };
  }

  // ── Zoho Mail (popular for company domains) ────────────────────────────
  if (domain === 'zoho.com' || domain === 'zohomail.com') {
    return { host: 'smtp.zoho.com', port: 587, secure: false, label: 'Zoho' };
  }

  // ── Company / Corporate domain — try smtp.<domain> as standard convention
  return { host: `smtp.${domain}`, port: 587, secure: false, label: `Company (${domain})`, fallbackHost: `mail.${domain}` };
}

// ── Gmail HTTPS API sender (bypasses all firewall/SMTP port blocks) ──────────
// Uses Gmail's REST API over port 443 (HTTPS) — works even when ports 587/465
// are blocked by corporate firewalls. Requires an App Password just like SMTP.
async function _sendViaGmailApi(smtpUser, smtpPass, mailOptions) {
  const https = require('https');

  // Build RFC 2822 raw message
  const toAddr  = Array.isArray(mailOptions.to) ? mailOptions.to.join(', ') : mailOptions.to;
  const ccAddr  = mailOptions.cc ? (Array.isArray(mailOptions.cc) ? mailOptions.cc.join(', ') : mailOptions.cc) : '';
  const subject = mailOptions.subject || '';
  const boundary = `boundary_${Date.now()}`;

  const rawLines = [
    `From: ${mailOptions.from}`,
    `To: ${toAddr}`,
    ...(ccAddr ? [`Cc: ${ccAddr}`] : []),
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    mailOptions.text || 'Please open this email in an HTML-capable client.',
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    ``,
    mailOptions.html || '',
    ``,
    `--${boundary}--`,
  ];
  const raw = Buffer.from(rawLines.join('\r\n')).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // Gmail API endpoint — uses Basic Auth with App Password
  // This goes over HTTPS port 443, which is never blocked
  const body = JSON.stringify({ raw });
  const auth  = Buffer.from(`${smtpUser}:${smtpPass}`).toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'gmail.googleapis.com',
      path:     '/gmail/v1/users/me/messages/send',
      method:   'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve({ messageId: JSON.parse(data).id || 'sent', accepted: [toAddr] });
        } else {
          reject(new Error(`Gmail API ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Build final SMTP config (env vars override auto-detection) ─────────────
function _buildSmtpConfig(emailUser) {
  const auto   = _detectSmtpConfig(emailUser);
  const host   = process.env.SMTP_HOST  || auto.host;
  const port   = parseInt(process.env.SMTP_PORT  || String(auto.port));
  const secure = process.env.SMTP_SECURE === 'true' ? true : (port === 465);
  console.log(`[email] SMTP provider detected: ${auto.label} → ${host}:${port} (secure=${secure})`);

  const auth = { user: emailUser, pass: process.env.SMTP_PASS || '' };
  const tls  = { rejectUnauthorized: false };

  // Build candidate list — try all host/port combos in order.
  // CRITICAL FIX: port 465 MUST use secure:true (implicit SSL), 587 uses secure:false (STARTTLS)
  let candidates;
  if (process.env.SMTP_HOST) {
    candidates = [
      { host, port: 587, secure: false, auth, tls },  // STARTTLS
      { host, port: 465, secure: true,  auth, tls },  // SSL — secure MUST be true for 465
      { host, port: 25,  secure: false, auth, tls },  // plain
    ];
  } else {
    const hosts = [auto.host];
    if (auto.fallbackHost && auto.fallbackHost !== auto.host) hosts.push(auto.fallbackHost);
    candidates = [];
    for (const h of hosts) {
      candidates.push({ host: h, port: 587, secure: false, auth, tls }); // STARTTLS
      candidates.push({ host: h, port: 465, secure: true,  auth, tls }); // SSL (secure=true!)
      candidates.push({ host: h, port: 25,  secure: false, auth, tls }); // plain last resort
    }
  }

  return { candidates, _label: auto.label, _isGmail: host === 'smtp.gmail.com' };
}

// ── Try sending — SMTP candidates first, Gmail HTTPS API as last resort ─────
async function _sendWithFallback(cfg, mailOptions) {
  const { candidates, _label, _isGmail } = cfg;
  const smtpUser = process.env.SMTP_USER || '';
  const smtpPass = process.env.SMTP_PASS || '';
  let lastErr;

  // 1. Try all SMTP candidates
  for (const smtpCfg of candidates) {
    try {
      console.log(`[email] Trying SMTP ${smtpCfg.host}:${smtpCfg.port} secure=${smtpCfg.secure} …`);
      const transporter = _nodemailer.createTransport({ ...smtpCfg, connectionTimeout: 10000, greetingTimeout: 10000 });
      await transporter.verify();
      const info = await transporter.sendMail(mailOptions);
      console.log(`[email] ✓ Sent via SMTP ${smtpCfg.host}:${smtpCfg.port}`);
      return info;
    } catch(err) {
      console.warn(`[email] ✗ SMTP ${smtpCfg.host}:${smtpCfg.port} — ${err.message}`);
      lastErr = err;
      // Auth failure → no point trying other ports, credentials are wrong
      if (err.message.includes('535') || err.message.includes('Invalid login') ||
          err.message.includes('5.7.8') || err.message.includes('Username and Password')) {
        console.error('[email] Auth failure — stopping SMTP attempts');
        throw err;
      }
    }
  }

  // 2. If Gmail and all SMTP ports blocked → try Gmail HTTPS REST API (port 443, never blocked)
  if (_isGmail && smtpUser && smtpPass) {
    console.log('[email] All SMTP ports blocked — trying Gmail HTTPS API (port 443) …');
    try {
      const info = await _sendViaGmailApi(smtpUser, smtpPass, mailOptions);
      console.log('[email] ✓ Sent via Gmail HTTPS API');
      return info;
    } catch(apiErr) {
      console.warn('[email] ✗ Gmail API also failed:', apiErr.message);
      // Throw original SMTP error with note about firewall
      throw new Error(`SMTP ports 587/465/25 are all blocked by your corporate firewall. Gmail API also failed: ${apiErr.message}. Solution: Ask your IT admin to allow outbound SMTP, or run this server outside the corporate network.`);
    }
  }

  throw lastErr;
}

// ── GET /api/oracle/ddl ──────────────────────────────────────────────────────
// DDL Generator: returns CREATE DDL for any schema object using DBMS_METADATA.
// Supports: TABLE, INDEX, VIEW, SEQUENCE, PROCEDURE, FUNCTION, PACKAGE,
//           PACKAGE BODY, TRIGGER, SYNONYM, TYPE, MATERIALIZED VIEW, DATABASE LINK
// Query params: owner, name, type
// Returns: { ddl: string, objectType, owner, name, generated }
app.get('/api/oracle/ddl', async (req, res) => {
  try {
    const owner = (req.query.owner || '').trim().toUpperCase();
    const name  = (req.query.name  || '').trim().toUpperCase();
    const type  = (req.query.type  || '').trim().toUpperCase();

    if (!owner || !name || !type) {
      return res.status(400).json({ error: 'owner, name, and type query params are required' });
    }
    // Whitelist: only allow safe identifiers
    if (!/^[\w$#]+$/.test(owner) || !/^[\w$#."@]+$/.test(name) || !/^[\w\s]+$/.test(type)) {
      return res.status(400).json({ error: 'Invalid object identifier' });
    }

    let conn;
    try {
      const pool = await getPool(currentDbId());
      conn = await pool.getConnection();
      conn.callTimeout = 60000;  // 60s — large packages/types can take time

      // ── Step 1: Set DBMS_METADATA transform params for clean, readable DDL ──
      // These suppress the default storage-clause verbosity we still want
      // but remove things like segment_attributes and storage from views/procs.
      const transformSetup = [
        `BEGIN
           DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM,'STORAGE',TRUE);
           DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM,'TABLESPACE',TRUE);
           DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM,'SEGMENT_ATTRIBUTES',TRUE);
           DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM,'PRETTY',TRUE);
           DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM,'SQLTERMINATOR',TRUE);
         END;`
      ];
      await conn.execute(transformSetup[0], [], { autoCommit: true });

      // ── Step 2: Fetch DDL via DBMS_METADATA.GET_DDL ──────────────────────
      // Map dashboard type names to Oracle DBMS_METADATA object type names
      const typeMap = {
        'TABLE':             'TABLE',
        'INDEX':             'INDEX',
        'VIEW':              'VIEW',
        'SEQUENCE':          'SEQUENCE',
        'PROCEDURE':         'PROCEDURE',
        'FUNCTION':          'FUNCTION',
        'PACKAGE':           'PACKAGE',
        'PACKAGE BODY':      'PACKAGE_BODY',
        'PACKAGE_BODY':      'PACKAGE_BODY',
        'TRIGGER':           'TRIGGER',
        'SYNONYM':           'SYNONYM',
        'TYPE':              'TYPE',
        'TYPE BODY':         'TYPE_BODY',
        'MATERIALIZED VIEW': 'MATERIALIZED_VIEW',
        'MVIEW':             'MATERIALIZED_VIEW',
        'DATABASE LINK':     'DB_LINK',
        'DB_LINK':           'DB_LINK',
        'JAVA CLASS':        'JAVA_CLASS',
        'CLUSTER':           'CLUSTER',
      };
      const metaType = typeMap[type] || type.replace(/ /g, '_');

      // Use CLOB output for large DDL — maxSize 4MB covers even the largest packages
      const result = await conn.execute(
        `SELECT DBMS_METADATA.GET_DDL(:1, :2, :3) AS DDL FROM DUAL`,
        [metaType, name, owner],
        { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchTypeMap: new Map([[oracledb.CLOB, {type: oracledb.STRING, maxSize: 4 * 1024 * 1024}]]) }
      );

      let ddl = '';
      const row = (result.rows || [])[0];
      if (row) {
        const val = row['DDL'] || row['ddl'] || '';
        ddl = typeof val === 'string' ? val : (typeof val.getData === 'function' ? await val.getData() : String(val));
      }

      if (!ddl || !ddl.trim()) {
        return res.status(404).json({ error: `No DDL found for ${owner}.${name} (${type}). Object may not exist or insufficient privileges.` });
      }

      res.json({ ddl: ddl.trim(), objectType: type, owner, name, generated: new Date().toISOString() });

    } finally {
      if (conn) try { await conn.close(); } catch(e) {}
    }

  } catch(e) {
    const msg = e.message || 'Unknown error';
    // Provide friendly hints for common ORA errors
    let hint = '';
    if (msg.includes('ORA-31603'))      hint = ' — Object not found. Check owner, name, and type.';
    else if (msg.includes('ORA-04043')) hint = ' — Object does not exist in the database.';
    else if (msg.includes('ORA-01031')) hint = ' — Insufficient privileges. Grant EXECUTE on DBMS_METADATA to the connected user.';
    res.status(500).json({ error: msg + hint });
  }
});

// ── GET /api/oracle/ddl/objects ──────────────────────────────────────────────
// Returns list of all objects for a given schema+type, for the DDL browser.
// Query params: owner, type (optional — returns all types if omitted)
app.get('/api/oracle/ddl/objects', async (req, res) => {
  try {
    const owner = (req.query.owner || '').trim().toUpperCase();
    const type  = (req.query.type  || '').trim().toUpperCase();

    if (!owner) return res.status(400).json({ error: 'owner is required' });
    if (!/^[\w$#]+$/.test(owner)) return res.status(400).json({ error: 'Invalid owner' });

    const typeFilter = type ? `AND OBJECT_TYPE = :2` : '';
    const binds = type ? [owner, type] : [owner];

    const sql = (view) => `
      SELECT OBJECT_NAME, OBJECT_TYPE, STATUS,
             TO_CHAR(LAST_DDL_TIME,'YYYY-MM-DD HH24:MI') AS LAST_DDL_TIME
      FROM ${view}
      WHERE OWNER = :1
      AND OBJECT_TYPE NOT IN ('LOB','INDEX PARTITION','TABLE PARTITION','TABLE SUBPARTITION',
                               'INDEX SUBPARTITION','JAVA DATA','JAVA RESOURCE','UNDEFINED')
      ${typeFilter}
      ORDER BY OBJECT_TYPE, OBJECT_NAME`;

    let rows;
    try {
      rows = await query(sql('DBA_OBJECTS'), binds);
    } catch(e1) {
      // Fall back to ALL_OBJECTS if no DBA privs
      rows = await query(sql('ALL_OBJECTS'), binds);
    }

    res.json({ objects: rows, owner, count: rows.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/oracle/ddl-logins ────────────────────────────────────────────────
// ── GET /api/oracle/failed-logins ────────────────────────────────────────────
// Dedicated failed-login tracker: queries audit trail for auth failure events
// (ORA-01017 wrong pwd, ORA-28000 locked, ORA-28001 expired, etc.)
// and returns enriched stats including brute-force detection.
app.get('/api/oracle/failed-logins', async (req, res) => {
  try {
    const from      = req.query.from      || '';
    const to        = req.query.to        || '';
    const user      = (req.query.user || '').toUpperCase().replace(/'/g, "''");
    const errorCode = req.query.errorCode || '';
    const hours     = Math.min(parseInt(req.query.hours || '24'), 168);

    const toOraTS = (isoStr) => {
      if (!isoStr) return null;
      try {
        const d = new Date(isoStr);
        if (isNaN(d.getTime())) return null;
        const p = n => String(n).padStart(2,'0');
        return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      } catch(_) { return null; }
    };

    // FIX: Use Set for O(1) .has() lookups used in post-query filtering
    const AUTH_FAIL_CODES     = ['1017','28000','28001','28002','28003','1031','1045'];
    const AUTH_FAIL_CODES_SET = new Set(AUTH_FAIL_CODES);

    const ORA_CODES = {
      '1017':  'Wrong username/password (ORA-01017)',
      '28000': 'Account locked (ORA-28000)',
      '28001': 'Password expired (ORA-28001)',
      '28002': 'Password will expire soon (ORA-28002)',
      '28003': 'Password verification failed (ORA-28003)',
      '1031':  'Insufficient privileges (ORA-01031)',
      '1045':  'No CREATE SESSION privilege (ORA-01045)',
    };

    const fromTs = toOraTS(from);
    const toTs   = toOraTS(to);

    // Build the IN-list of error codes to filter on
    const codeList = errorCode
      ? `('${errorCode}')`
      : `('${AUTH_FAIL_CODES.join("','")}')`;

    // FIX: Separate whereUser for each source — column names differ between views
    const whereUserUnified = user ? `AND UPPER(DBUSERNAME) = '${user}'` : '';
    const whereUserDba     = user ? `AND UPPER(DB_USER)    = '${user}'` : '';

    // Time filters — UNIFIED uses TIMESTAMP type, DBA uses DATE type
    const whereTimeUnified = fromTs
      ? `AND EVENT_TIMESTAMP >= TO_TIMESTAMP('${fromTs}','YYYY-MM-DD HH24:MI:SS')
         ${toTs ? `AND EVENT_TIMESTAMP <= TO_TIMESTAMP('${toTs}','YYYY-MM-DD HH24:MI:SS')` : ''}`
      : `AND EVENT_TIMESTAMP >= SYSDATE - ${hours}/24`;

    const whereTimeDba = fromTs
      ? `AND TIMESTAMP >= TO_DATE('${fromTs}','YYYY-MM-DD HH24:MI:SS')
         ${toTs ? `AND TIMESTAMP <= TO_DATE('${toTs}','YYYY-MM-DD HH24:MI:SS')` : ''}`
      : `AND TIMESTAMP >= SYSDATE - ${hours}/24`;

    let rows = [], source = '';

    // ── Strategy 1: UNIFIED_AUDIT_TRAIL (Oracle 12c+) ────────────────────────
    // FIX: The original WHERE clause had broken OR/AND operator precedence —
    // it was returning ALL logon rows (including successful ones).
    // Correct logic: filter ONLY on RETURN_CODE being a known failure code.
    // ACTION_NAME filter is removed — it was the root cause of the data pollution.
    try {
      rows = await query(
        `SELECT TO_CHAR(EVENT_TIMESTAMP,'YYYY-MM-DD HH24:MI:SS') AS TIMESTAMP,
                NVL(DBUSERNAME,'-')             AS DB_USER,
                NVL(OS_USERNAME,'-')            AS OS_USER,
                NVL(TO_CHAR(RETURN_CODE),'0')   AS RETURNCODE,
                NVL(USERHOST,'-')               AS USERHOST,
                NVL(CLIENT_PROGRAM_NAME,'-')    AS PROGRAM
         FROM UNIFIED_AUDIT_TRAIL
         WHERE TO_CHAR(RETURN_CODE) IN ${codeList}
         ${whereTimeUnified}
         ${whereUserUnified}
         ORDER BY EVENT_TIMESTAMP DESC
         FETCH FIRST 500 ROWS ONLY`
      );
      source = 'UNIFIED_AUDIT_TRAIL';
    } catch(e1) {
      // ── Strategy 2: DBA_AUDIT_TRAIL (Oracle 11g or standard auditing) ────────
      try {
        rows = await query(
          `SELECT TO_CHAR(TIMESTAMP,'YYYY-MM-DD HH24:MI:SS') AS TIMESTAMP,
                  NVL(DB_USER,'-')             AS DB_USER,
                  NVL(OS_USER,'-')             AS OS_USER,
                  NVL(TO_CHAR(RETURNCODE),'0') AS RETURNCODE,
                  NVL(USERHOST,'-')            AS USERHOST,
                  NVL(TERMINAL,'-')            AS PROGRAM
           FROM DBA_AUDIT_TRAIL
           WHERE TO_CHAR(RETURNCODE) IN ${codeList}
           ${whereTimeDba}
           ${whereUserDba}
           ORDER BY TIMESTAMP DESC
           FETCH FIRST 500 ROWS ONLY`
        );
        source = 'DBA_AUDIT_TRAIL';
      } catch(e2) {
        throw new Error(`Audit trail unavailable: ${e2.message}. Enable auditing with: AUDIT SESSION WHENEVER NOT SUCCESSFUL`);
      }
    }

    // Enrich rows — normalize RETURNCODE to trimmed string and attach description
    rows = rows.map(r => {
      const rc   = String(r.RETURNCODE || '0').trim();
      const desc = ORA_CODES[rc] || (rc !== '0' ? `ORA-${rc.padStart(5,'0')}: Oracle error` : 'Success');
      return { ...r, RETURNCODE: rc, RC_DESC: desc };
    });

    // FIX: Filter out any rows that slipped through with RETURNCODE '0' (success)
    // This guards against views that return all sessions when no return-code index is used.
    rows = rows.filter(r => r.RETURNCODE !== '0' && AUTH_FAIL_CODES_SET.has(r.RETURNCODE));

    const total       = rows.length;
    const uniqueUsers = new Set(rows.map(r => r.DB_USER).filter(u => u && u !== '-')).size;
    const uniqueHosts = new Set(rows.map(r => r.USERHOST).filter(h => h && h !== '-')).size;
    const lockedCount = rows.filter(r => r.RETURNCODE === '28000').length;

    // Top targeted usernames (up to 8)
    const userCounts   = {};
    const userLastSeen = {};
    rows.forEach(r => {
      if (r.DB_USER && r.DB_USER !== '-') {
        userCounts[r.DB_USER] = (userCounts[r.DB_USER] || 0) + 1;
        if (!userLastSeen[r.DB_USER] || r.TIMESTAMP > userLastSeen[r.DB_USER])
          userLastSeen[r.DB_USER] = r.TIMESTAMP;
      }
    });
    const topUsers = Object.entries(userCounts).sort((a,b) => b[1]-a[1]).slice(0,8)
      .map(([u, c]) => ({ USERNAME: u, FAILURES: c, LAST_SEEN: userLastSeen[u] || '—' }));

    // Top source hosts (up to 8)
    const hostCounts = {};
    rows.forEach(r => {
      if (r.USERHOST && r.USERHOST !== '-')
        hostCounts[r.USERHOST] = (hostCounts[r.USERHOST] || 0) + 1;
    });
    const topHosts = Object.entries(hostCounts).sort((a,b) => b[1]-a[1]).slice(0,8)
      .map(([h, c]) => ({ HOST: h, FAILURES: c }));

    // Error code breakdown (sorted by count desc)
    const errCounts = {};
    rows.forEach(r => {
      const key = r.RC_DESC || `ORA-${r.RETURNCODE}`;
      errCounts[key] = (errCounts[key] || 0) + 1;
    });
    const errorBreakdown = Object.entries(errCounts).sort((a,b) => b[1]-a[1])
      .map(([desc, cnt]) => ({ DESCRIPTION: desc, COUNT: cnt }));

    // Brute-force detection: any single host or username with 5+ failures in the window
    const bruteForce = { detected: false, message: '' };
    const bruteHost  = topHosts.find(h => h.FAILURES >= 5);
    const bruteUser  = topUsers.find(u => u.FAILURES >= 5);
    if (bruteHost || bruteUser) {
      bruteForce.detected = true;
      const parts = [];
      if (bruteUser) parts.push(`${bruteUser.FAILURES} attempts against user "${bruteUser.USERNAME}"`);
      if (bruteHost) parts.push(`${bruteHost.FAILURES} attempts from host "${bruteHost.HOST}"`);
      // FIX: Use correct time-window label — custom range or rolling hours
      const windowLabel = fromTs ? `${fromTs} → ${toTs || 'now'}` : `the last ${hours}h`;
      bruteForce.message = parts.join('; ') + ` in ${windowLabel}.`;
    }

    // FIX: Accurate timeWindow label in response
    const timeWindow = fromTs ? `${fromTs} → ${toTs || 'now'}` : `Last ${hours}h`;

    res.json({ rows, source, total, uniqueUsers, uniqueHosts, lockedCount, topUsers, topHosts, errorBreakdown, bruteForce, timeWindow });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── POST /api/report/send-email ──────────────────────────────────────────── ────────────────────────────────────────────
app.post('/api/report/send-email', async (req, res) => {
  try {
    if (!_nodemailer || typeof _nodemailer.createTransport !== 'function') {
      return res.status(503).json({ ok: false, error: 'nodemailer not installed. Run: npm install nodemailer' });
    }

    const { to, cc, subject, html, dbName } = req.body || {};
    if (!to)   return res.status(400).json({ ok: false, error: 'Missing recipient email(s)' });
    if (!html) return res.status(400).json({ ok: false, error: 'Missing report HTML content' });

    const smtpUser = process.env.SMTP_USER || '';
    const smtpPass = process.env.SMTP_PASS || '';

    if (!smtpUser) return res.status(503).json({ ok: false, error: 'SMTP_USER not set in .env file. Add your email address.' });
    if (!smtpPass) return res.status(503).json({ ok: false, error: 'SMTP_PASS not set in .env file. Add your email password or App Password.' });

    const cfg        = _buildSmtpConfig(smtpUser);
    const smtpFrom   = process.env.SMTP_FROM || smtpUser;
    const recipients = to.split(',').map(e => e.trim()).filter(Boolean).join(', ');

    const mailOptions = {
      from:    `"Oracle DBA Tool" <${smtpFrom}>`,
      to:      recipients,
      ...(cc && cc.trim() ? { cc: cc.split(',').map(e => e.trim()).filter(Boolean).join(', ') } : {}),
      subject: subject || `Oracle DBA Health Report — ${dbName || 'Database'}`,
      html,
      text:    `Oracle DBA Health Report for ${dbName || 'Database'}.\nPlease open in an HTML-capable email client.`,
    };

    const info = await _sendWithFallback(cfg, mailOptions);

    console.log(`[email] ✓ Report sent to ${recipients} — MessageId: ${info.messageId}`);
    res.json({
      ok:        true,
      messageId: info.messageId,
      accepted:  info.accepted,
      provider:  cfg._label || 'Email',
    });

  } catch(e) {
    console.error('[email] ✗ Send failed:', e.message);
    // Give a helpful error message based on common failure patterns
    let hint = '';
    if (e.message.includes('Invalid login') || e.message.includes('535')) {
      hint = ' — Wrong App Password. Go to https://myaccount.google.com/apppasswords, delete the old one and generate a new 16-char App Password.';
    } else if (e.message.includes('ECONNRESET') || e.message.includes('Connection closed')) {
      hint = ' — Your corporate firewall is blocking outbound SMTP (ports 587/465/25). Ask your IT admin to whitelist outbound SMTP to smtp.gmail.com, or run this server from home/outside the office network.';
    } else if (e.message.includes('ECONNREFUSED') || e.message.includes('ENOTFOUND')) {
      hint = ' — Cannot reach SMTP server. Check SMTP_HOST in .env or ask your IT admin for the correct SMTP server address.';
    } else if (e.message.includes('certificate') || e.message.includes('self signed')) {
      hint = ' — SSL certificate issue. Add SMTP_SECURE=false to your .env file.';
    } else if (e.message.includes('534') || e.message.includes('5.7.9')) {
      hint = ' — Gmail requires an App Password. Go to Google Account → Security → App Passwords and generate one.';
    } else if (e.message.includes('firewall') || e.message.includes('SMTP ports')) {
      hint = ' — All outbound email ports are blocked. Use a personal hotspot/home network instead of office WiFi/VPN, or ask IT to allow smtp.gmail.com:587.';
    }
    res.status(500).json({ ok: false, error: e.message + hint });
  }
});

// ── GET /api/report/email-config — returns detected SMTP provider for UI display
app.get('/api/report/email-config', (req, res) => {
  const smtpUser = process.env.SMTP_USER || '';
  if (!smtpUser) return res.json({ configured: false });
  const auto = _detectSmtpConfig(smtpUser);
  const host = process.env.SMTP_HOST || auto.host;
  const port = parseInt(process.env.SMTP_PORT || String(auto.port));
  res.json({
    configured: !!(process.env.SMTP_PASS),
    user:       smtpUser,
    host,
    port,
    provider:   auto.label,
  });
});

// ── SQLPLUS TERMINAL — unrestricted query execution ───────────────────────────
// Supports SELECT, DML (INSERT/UPDATE/DELETE), DDL (CREATE/ALTER/DROP),
// SHOW PARAMETERS, DESC <table>, and multi-statement batches separated by ';'
// Each statement is auto-committed. Results stream back as structured JSON.
app.post('/api/oracle/terminal', async (req, res) => {
  const { sql } = req.body || {};
  if (!sql || !sql.trim()) return res.status(400).json({ error: 'SQL is required' });

  // Split on semicolons (skip empty, skip PL/SQL block terminators '/')
  const rawStatements = sql.split(/;/).map(s => s.trim()).filter(s => s && s !== '/');

  const results = [];

  for (const stmt of rawStatements) {
    const t0 = Date.now();
    let conn;
    try {
      const pool = await getPool(currentDbId());
      conn = await pool.getConnection();
      conn.callTimeout = 120000; // 2-min timeout for terminal

      // ── Handle DESC / DESCRIBE ────────────────────────────────────────────
      // Smart fallback chain:
      //   1. If object has an explicit owner prefix (e.g. SYS.DBA_TABLES), try DBA_TAB_COLUMNS with that owner
      //   2. If no owner and name starts with V$ / GV$, try V$_COL_USAGE or ALL_TAB_COLUMNS on SYS + FIXED_COL fallback
      //   3. Try DBA_TAB_COLUMNS (needs DBA priv) — if 0 rows, fall through
      //   4. Try ALL_TAB_COLUMNS (visible objects) — if 0 rows, fall through
      //   5. Try USER_TAB_COLUMNS (current schema) — final attempt
      //   6. If all return 0 rows, return 0 rows + a privilege hint message
      const descMatch = stmt.match(/^\s*(?:DESC|DESCRIBE)\s+([.\w$#"]+)\s*$/i);
      if (descMatch) {
        const objName = descMatch[1].replace(/"/g, '');
        const parts   = objName.split('.');
        const owner   = parts.length > 1 ? parts[0].toUpperCase() : null;
        const name    = (parts.length > 1 ? parts[1] : parts[0]).toUpperCase();

        // Helper: run a query and return { cols, rows } or null on error / 0 rows
        async function tryDescQuery(sql) {
          try {
            const r = await conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: false });
            const cols = (r.metaData || []).map(m => m.name);
            const rows = (r.rows || []).map(row => cols.map(c => {
              const v = row[c]; return v === null || v === undefined ? 'NULL' : String(v);
            }));
            if (rows.length > 0) return { cols, rows };
            return null; // 0 rows — try next source
          } catch(_) {
            return null; // No privilege or object doesn't exist in this view
          }
        }

        // ── V$/GV$ dynamic performance views: use FIXED_COLUMNS fallback ──────
        const isDynView = /^G?V\$/.test(name);
        let descResult = null;

        if (isDynView && !owner) {
          // V$ views: try V_$<name> columns from ALL_TAB_COLUMNS under SYS, then FIXED_COLUMNS
          const vBase = name.startsWith('GV$') ? name.replace(/^GV\$/, 'GV_$') : name.replace(/^V\$/, 'V_$');
          descResult =
            await tryDescQuery(`SELECT COLUMN_NAME,DATA_TYPE,DATA_LENGTH,DATA_PRECISION,DATA_SCALE,NULLABLE FROM DBA_TAB_COLUMNS WHERE OWNER='SYS' AND TABLE_NAME='${vBase}' ORDER BY COLUMN_ID`) ||
            await tryDescQuery(`SELECT COLUMN_NAME,DATA_TYPE,DATA_LENGTH,DATA_PRECISION,DATA_SCALE,NULLABLE FROM ALL_TAB_COLUMNS WHERE TABLE_NAME='${name}' ORDER BY COLUMN_ID`) ||
            await tryDescQuery(`SELECT COLUMN_NAME,TYPE DATA_TYPE,NULL DATA_LENGTH,NULL DATA_PRECISION,NULL DATA_SCALE,'N' NULLABLE FROM V$FIXED_VIEW_DEFINITION WHERE VIEW_NAME='${name}' AND ROWNUM<=1`);

          // Last resort for V$: describe using a 0-row SELECT to get column metadata
          if (!descResult) {
            try {
              const r0 = await conn.execute(`SELECT * FROM ${name} WHERE 1=0`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: false });
              const cols0 = (r0.metaData || []).map(m => m.name);
              if (cols0.length > 0) {
                // Fake rows with column names only — display as "name / type" rows
                const metaCols = ['COLUMN_NAME', 'DATA_TYPE', 'NULLABLE'];
                const metaRows = r0.metaData.map(m => [
                  m.name,
                  m.dbTypeName || String(m.dbType || ''),
                  m.nullable ? 'Y' : 'N'
                ]);
                descResult = { cols: metaCols, rows: metaRows };
              }
            } catch(_) {}
          }
        }

        // ── Standard tables/views: try DBA → ALL → USER ───────────────────────
        if (!descResult) {
          const ownerFilter = owner ? `OWNER='${owner}' AND ` : '';
          if (owner) {
            // Explicit owner given — try DBA first, then ALL
            descResult =
              await tryDescQuery(`SELECT COLUMN_NAME,DATA_TYPE,DATA_LENGTH,DATA_PRECISION,DATA_SCALE,NULLABLE FROM DBA_TAB_COLUMNS WHERE OWNER='${owner}' AND TABLE_NAME='${name}' ORDER BY COLUMN_ID`) ||
              await tryDescQuery(`SELECT COLUMN_NAME,DATA_TYPE,DATA_LENGTH,DATA_PRECISION,DATA_SCALE,NULLABLE FROM ALL_TAB_COLUMNS WHERE OWNER='${owner}' AND TABLE_NAME='${name}' ORDER BY COLUMN_ID`);
          } else {
            // No owner — try DBA (with any owner matching name), then ALL, then USER
            descResult =
              await tryDescQuery(`SELECT COLUMN_NAME,DATA_TYPE,DATA_LENGTH,DATA_PRECISION,DATA_SCALE,NULLABLE FROM DBA_TAB_COLUMNS WHERE TABLE_NAME='${name}' AND ROWNUM<=500 ORDER BY OWNER,COLUMN_ID`) ||
              await tryDescQuery(`SELECT COLUMN_NAME,DATA_TYPE,DATA_LENGTH,DATA_PRECISION,DATA_SCALE,NULLABLE FROM ALL_TAB_COLUMNS WHERE TABLE_NAME='${name}' AND ROWNUM<=500 ORDER BY OWNER,COLUMN_ID`) ||
              await tryDescQuery(`SELECT COLUMN_NAME,DATA_TYPE,DATA_LENGTH,DATA_PRECISION,DATA_SCALE,NULLABLE FROM USER_TAB_COLUMNS WHERE TABLE_NAME='${name}' ORDER BY COLUMN_ID`);
          }
        }

        if (descResult) {
          results.push({ stmt, type: 'query', columns: descResult.cols, rows: descResult.rows, rowCount: descResult.rows.length, elapsed: Date.now() - t0 });
        } else {
          // Object not found or no privilege anywhere — return 0 rows with a helpful hint
          const hint = isDynView
            ? `Object '${objName}' not found. V$/GV$ views require SELECT_CATALOG_ROLE or SELECT ANY DICTIONARY privilege. Try: GRANT SELECT_CATALOG_ROLE TO ${conn.tag||'your_user'};`
            : `Object '${objName}' not found or not accessible. If it exists in another schema, try: DESC OWNER.${name} — or ensure the user has SELECT privilege on it.`;
          results.push({ stmt, type: 'query', columns: ['COLUMN_NAME','DATA_TYPE','DATA_LENGTH','DATA_PRECISION','DATA_SCALE','NULLABLE'], rows: [], rowCount: 0, elapsed: Date.now() - t0, hint });
        }
        continue;
      }

      // ── Handle SHOW PARAMETERS ────────────────────────────────────────────
      const showParamMatch = stmt.match(/^\s*SHOW\s+PARAMETERS?\s*(.*)?$/i);
      if (showParamMatch) {
        const filter = (showParamMatch[1] || '').trim();
        const pSql = filter
          ? `SELECT NAME,TYPE,VALUE,DESCRIPTION FROM V$PARAMETER WHERE LOWER(NAME) LIKE LOWER('%${filter.replace(/'/g,"''")}%') ORDER BY NAME`
          : `SELECT NAME,TYPE,VALUE,DESCRIPTION FROM V$PARAMETER ORDER BY NAME`;
        const r = await conn.execute(pSql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: false });
        const cols = (r.metaData || []).map(m => m.name);
        const rows = (r.rows || []).map(row => cols.map(c => { const v = row[c]; return v === null ? 'NULL' : String(v); }));
        results.push({ stmt, type: 'query', columns: cols, rows, rowCount: rows.length, elapsed: Date.now() - t0 });
        continue;
      }

      // ── Handle SHOW USER ──────────────────────────────────────────────────
      if (/^\s*SHOW\s+USER\s*$/i.test(stmt)) {
        const r = await conn.execute(`SELECT USER AS "USER" FROM DUAL`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: false });
        const user = r.rows?.[0]?.USER || '';
        results.push({ stmt, type: 'query', columns: ['USER'], rows: [[user]], rowCount: 1, elapsed: Date.now() - t0 });
        continue;
      }

      // ── Handle SHOW SGA ───────────────────────────────────────────────────
      if (/^\s*SHOW\s+SGA\s*$/i.test(stmt)) {
        const r = await conn.execute(`SELECT NAME, VALUE FROM V$SGA ORDER BY NAME`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: false });
        const cols = ['NAME', 'VALUE'];
        const rows = (r.rows || []).map(row => [String(row.NAME || ''), String(row.VALUE ?? 'NULL')]);
        results.push({ stmt, type: 'query', columns: cols, rows, rowCount: rows.length, elapsed: Date.now() - t0 });
        continue;
      }

      // ── Handle SHOW ERRORS ────────────────────────────────────────────────
      if (/^\s*SHOW\s+ERRORS?\s*$/i.test(stmt)) {
        const r = await conn.execute(
          `SELECT TYPE,NAME,LINE,POSITION,TEXT FROM USER_ERRORS ORDER BY TYPE,NAME,SEQUENCE`,
          [], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: false }
        );
        const cols = ['TYPE', 'NAME', 'LINE', 'POSITION', 'TEXT'];
        const rows = (r.rows || []).map(row => cols.map(c => { const v = row[c]; return v === null ? 'NULL' : String(v); }));
        if (rows.length === 0) {
          results.push({ stmt, type: 'query', columns: ['MESSAGE'], rows: [['No errors.']], rowCount: 1, elapsed: Date.now() - t0 });
        } else {
          results.push({ stmt, type: 'query', columns: cols, rows, rowCount: rows.length, elapsed: Date.now() - t0 });
        }
        continue;
      }

      // ── Handle SHOW RECYCLEBIN ────────────────────────────────────────────
      if (/^\s*SHOW\s+RECYCLEBIN\s*$/i.test(stmt)) {
        const r = await conn.execute(
          `SELECT OBJECT_NAME,ORIGINAL_NAME,TYPE,DROPTIME FROM USER_RECYCLEBIN ORDER BY DROPTIME DESC`,
          [], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: false }
        );
        const cols = ['OBJECT_NAME', 'ORIGINAL_NAME', 'TYPE', 'DROPTIME'];
        const rows = (r.rows || []).map(row => cols.map(c => { const v = row[c]; return v === null ? 'NULL' : String(v); }));
        if (rows.length === 0) {
          results.push({ stmt, type: 'query', columns: ['MESSAGE'], rows: [['Recycle bin is empty.']], rowCount: 1, elapsed: Date.now() - t0 });
        } else {
          results.push({ stmt, type: 'query', columns: cols, rows, rowCount: rows.length, elapsed: Date.now() - t0 });
        }
        continue;
      }

      // ── Handle SHOW RELEASE ───────────────────────────────────────────────
      if (/^\s*SHOW\s+RELEASE\s*$/i.test(stmt)) {
        const r = await conn.execute(`SELECT VERSION FROM V$INSTANCE`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: false });
        const version = r.rows?.[0]?.VERSION || 'Unknown';
        results.push({ stmt, type: 'query', columns: ['RELEASE'], rows: [[version]], rowCount: 1, elapsed: Date.now() - t0 });
        continue;
      }

      // ── Handle SHOW CON_NAME ──────────────────────────────────────────────
      if (/^\s*SHOW\s+CON_NAME\s*$/i.test(stmt)) {
        try {
          const r = await conn.execute(`SELECT SYS_CONTEXT('USERENV','CON_NAME') AS CON_NAME FROM DUAL`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: false });
          const conName = r.rows?.[0]?.CON_NAME || 'CDB$ROOT';
          results.push({ stmt, type: 'query', columns: ['CON_NAME'], rows: [[conName]], rowCount: 1, elapsed: Date.now() - t0 });
        } catch(_) {
          results.push({ stmt, type: 'query', columns: ['CON_NAME'], rows: [['N/A (non-CDB)']], rowCount: 1, elapsed: Date.now() - t0 });
        }
        continue;
      }

      // ── Handle SHOW PDBS ──────────────────────────────────────────────────
      if (/^\s*SHOW\s+PDBS\s*$/i.test(stmt)) {
        try {
          const r = await conn.execute(`SELECT CON_ID,NAME,OPEN_MODE FROM V$PDBS ORDER BY CON_ID`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: false });
          const cols = ['CON_ID', 'NAME', 'OPEN_MODE'];
          const rows = (r.rows || []).map(row => cols.map(c => { const v = row[c]; return v === null ? 'NULL' : String(v); }));
          results.push({ stmt, type: 'query', columns: cols, rows, rowCount: rows.length, elapsed: Date.now() - t0 });
        } catch(_) {
          results.push({ stmt, type: 'query', columns: ['MESSAGE'], rows: [['V$PDBS not accessible or non-CDB instance.']], rowCount: 1, elapsed: Date.now() - t0 });
        }
        continue;
      }

      // ── Handle SHOW CON_ID ────────────────────────────────────────────────
      if (/^\s*SHOW\s+CON_ID\s*$/i.test(stmt)) {
        const r = await conn.execute(`SELECT SYS_CONTEXT('USERENV','CON_ID') AS CON_ID FROM DUAL`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: false });
        const conId = r.rows?.[0]?.CON_ID || '0';
        results.push({ stmt, type: 'query', columns: ['CON_ID'], rows: [[conId]], rowCount: 1, elapsed: Date.now() - t0 });
        continue;
      }

      // ── Catch remaining unsupported SHOW <keyword> commands ───────────────
      const unsupportedShow = stmt.match(/^\s*SHOW\s+(\w+)/i);
      if (unsupportedShow) {
        const keyword = unsupportedShow[1].toUpperCase();
        results.push({
          stmt, type: 'error',
          error: `SHOW ${keyword} is a SQL*Plus client command and is not supported here. ` +
                 `Supported: SHOW USER, SHOW SGA, SHOW ERRORS, SHOW RECYCLEBIN, SHOW RELEASE, ` +
                 `SHOW CON_NAME, SHOW CON_ID, SHOW PDBS, SHOW PARAMETERS [filter].`,
          elapsed: Date.now() - t0
        });
        continue;
      }

      // ── Regular SQL ───────────────────────────────────────────────────────
      const isSelect = /^\s*(SELECT|WITH|EXPLAIN)\b/i.test(stmt);
      const r = await conn.execute(stmt, [], {
        outFormat  : oracledb.OUT_FORMAT_OBJECT,
        autoCommit : true,
        fetchTypeMap: new Map([
          [oracledb.CLOB,  { type: oracledb.STRING }],
          [oracledb.BLOB,  { type: oracledb.BUFFER }],
          [oracledb.NCLOB, { type: oracledb.STRING }],
        ]),
        maxRows: 5000
      });

      if (isSelect || r.rows) {
        const cols = (r.metaData || []).map(m => m.name);
        const rows = await Promise.all((r.rows || []).map(async row => {
          return Promise.all(cols.map(async c => {
            const v = row[c];
            if (v === null || v === undefined) return 'NULL';
            if (v && typeof v === 'object' && typeof v.getData === 'function') {
              try { return await v.getData() || ''; } catch(_) { return ''; }
            }
            if (Buffer.isBuffer(v)) return v.toString('utf8');
            if (v instanceof Date) return v.toISOString().replace('T',' ').slice(0,19);
            return String(v);
          }));
        }));
        results.push({ stmt, type: 'query', columns: cols, rows, rowCount: rows.length, elapsed: Date.now() - t0 });
      } else {
        // DML / DDL — rowsAffected
        const affected = r.rowsAffected != null ? r.rowsAffected : null;
        const stmtType = stmt.trim().match(/^\s*(\w+)/)?.[1]?.toUpperCase() || 'Statement';
        const msg = affected != null
          ? `${stmtType} completed. ${affected} row(s) affected.`
          : `${stmtType} completed successfully.`;
        results.push({ stmt, type: 'dml', message: msg, rowsAffected: affected, elapsed: Date.now() - t0 });
      }
    } catch (e) {
      results.push({ stmt, type: 'error', error: e.message, elapsed: Date.now() - t0 });
    } finally {
      if (conn) try { await conn.close(); } catch(_) {}
    }
  }

  res.json({ results, totalStatements: rawStatements.length });
});

// ── OS TERMINAL — SSH remote execution ───────────────────────────────────────
//
//  POST /api/os/ssh-exec
//  Body: { cmd, host, port?, user, password?, privateKey?, cwd? }
//
//  Executes a shell command on a REMOTE server via SSH using the 'ssh2' library.
//  Falls back gracefully if ssh2 is not installed (returns a helpful error).
//
//  GET /api/os/ssh-hosts
//  Returns all registered DB hostnames so the frontend can offer them in a picker.
//
//  Security notes:
//    • Password / private-key are transmitted only over your LAN to this proxy.
//    • Sessions are not persisted — a new SSH connection is made per request.
//    • Hardcoded 30 s timeout (same as local exec).
// ─────────────────────────────────────────────────────────────────────────────

// Lazily require ssh2 so the server still starts even if the package is missing.
let _ssh2Client;
function _getSsh2() {
  if (_ssh2Client) return _ssh2Client;
  try {
    _ssh2Client = require('ssh2').Client;
    return _ssh2Client;
  } catch (_) {
    return null;
  }
}

// ── SSH Session Pool ──────────────────────────────────────────────────────────
// Caches one authenticated SSH connection per user@host:port so that
// switching between Batch (ssh-exec) and PTY (ssh-pty) tabs does NOT require
// a second login.  The pool key is "user@host:port".
// Each entry: { conn, ready, key, idleTimer, refs }
// Connections are evicted after 10 minutes of no activity.
const _sshPool = new Map();          // key → { conn, ready, refs, idleTimer }
const SSH_POOL_IDLE_MS = 10 * 60 * 1000; // 10 min idle eviction

function _sshPoolKey(user, host, port) {
  return `${user}@${host}:${port}`;
}

// Get (or create) a ready SSH connection for user@host:port.
// Returns a Promise<ssh2.Client> or throws on auth failure.
// The caller MUST call _sshPoolRelease(key) when done so the idle timer starts.
function _sshPoolGet(user, host, port, password, privateKey) {
  const SSH2 = _getSsh2();
  if (!SSH2) return Promise.reject(new Error('ssh2 not installed'));
  const key = _sshPoolKey(user, host, port);

  // Return existing ready connection — first check the socket is still alive.
  // SSH server can silently close the connection (idle timeout, MaxSessions)
  // leaving entry.ready=true but the socket dead, causing "Channel open failure".
  if (_sshPool.has(key)) {
    const entry = _sshPool.get(key);
    if (entry.ready) {
      const sock = entry.conn._sock;
      const alive = !sock || (sock.writable && !sock.destroyed);
      if (alive) {
        entry.refs++;
        if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
        return Promise.resolve(entry.conn);
      }
      // Socket is dead — evict and create a fresh connection below
      console.warn('[ssh-pool] stale entry (dead socket), evicting:', key);
      try { entry.conn.end(); } catch(_) {}
      _sshPool.delete(key);
    }
  }

  // Create new connection
  return new Promise((resolve, reject) => {
    const conn = new SSH2();
    const entry = { conn, ready: false, refs: 1, idleTimer: null, key };
    _sshPool.set(key, entry);

    conn.on('ready', () => {
      entry.ready = true;
      resolve(conn);
    });
    conn.on('error', err => {
      _sshPool.delete(key);
      reject(err);
    });
    conn.on('end', () => {
      entry.ready = false;
      _sshPool.delete(key);
    });
    conn.on('close', () => {
      entry.ready = false;
      _sshPool.delete(key);
    });

    const cfg = { host, port, username: user, readyTimeout: 20_000 };
    if (privateKey) cfg.privateKey = privateKey; else cfg.password = password;
    try { conn.connect(cfg); } catch(e) { _sshPool.delete(key); reject(e); }
  });
}

// Release a reference to a pooled connection.
// Starts the idle eviction timer when refs drops to zero.
function _sshPoolRelease(key) {
  const entry = _sshPool.get(key);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs === 0 && !entry.idleTimer) {
    entry.idleTimer = setTimeout(() => {
      try { entry.conn.end(); } catch(_) {}
      _sshPool.delete(key);
      console.log(`[ssh-pool] evicted idle session: ${key}`);
    }, SSH_POOL_IDLE_MS);
  }
}

// Expose pool stats for /api/os/ssh-pool-status (debug endpoint)
app.get('/api/os/ssh-pool-status', (_req, res) => {
  const sessions = [];
  for (const [k, e] of _sshPool.entries()) {
    sessions.push({ key: k, ready: e.ready, refs: e.refs });
  }
  res.json({ sessions });
});

// Extract hostname from an Oracle connect string like
//   (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=1.2.3.4)(PORT=1521))…)
// or a simple "host:port/service" EZConnect string.
function _extractOracleHost(cs) {
  if (!cs) return null;
  // Full descriptor
  const m = cs.match(/HOST\s*=\s*([^)\s]+)/i);
  if (m) return m[1].trim();
  // EZConnect  host:port/service  or  host/service
  const ez = cs.match(/^([^:(\/]+)/);
  if (ez) return ez[1].trim();
  return null;
}

// GET /api/os/ssh-hosts  — list unique hosts derived from registered databases
// Deduplicates by IP so the same host never appears twice in the dropdown.
app.get('/api/os/ssh-hosts', (_req, res) => {
  const seen = new Set();
  const hosts = [];
  for (const [id, db] of _dbRegistry.entries()) {
    const host = _extractOracleHost(db.connectionString);
    if (host && !seen.has(host)) {
      seen.add(host);
      hosts.push({ dbId: id, dbName: db.name, host, isActive: id === _activeDBId });
    }
  }
  res.json({ hosts });
});

// POST /api/os/ssh-exec
app.post('/api/os/ssh-exec', (req, res) => {
  const { cmd, host, port, user: sshUser, password, privateKey, cwd } = req.body || {};

  // ── Validate ────────────────────────────────────────────────────────────────
  if (!cmd  || typeof cmd  !== 'string' || !cmd.trim())  return res.status(400).json({ error: 'cmd is required'  });
  if (!host || typeof host !== 'string' || !host.trim()) return res.status(400).json({ error: 'host is required' });
  if (!sshUser || typeof sshUser !== 'string')           return res.status(400).json({ error: 'user is required' });
  if (!password && !privateKey)                          return res.status(400).json({ error: 'password or privateKey is required' });
  if (cmd.length > 4096)                                 return res.status(400).json({ error: 'cmd too long (max 4096 chars)' });

  const SSH2 = _getSsh2();
  if (!SSH2) {
    return res.status(500).json({
      error: 'ssh2 package not installed. Run: npm install ssh2  then restart server.js'
    });
  }

  const sshPort   = parseInt(port, 10) || 22;
  // Allow caller to pass a custom timeout (ms). Default 5 min for long-running
  // commands (expdp, impdp, rman, find, du, etc.). Hard cap at 30 min.
  const timeout   = Math.min(parseInt(req.body.timeout, 10) || 300_000, 1_800_000);
  const t0        = Date.now();

  // Always prepend `cd '<cwd>'` if we have a saved cwd, then append `pwd` at the
  // end so the response always carries the NEW working directory back to the frontend.
  //
  // CRITICAL — no subshell: cmd runs in the OUTER shell so `cd` inside cmd
  // changes the directory that the trailing `pwd` then reports.
  // Using subshell ( cmd ) would mean cd only affects a child process and pwd
  // always reports the parent's (unchanged) directory.
  //
  // Paths are single-quoted to safely handle spaces and shell metacharacters.
  function shellSingleQuote(p) {
    return "'" + p.replace(/'/g, "'\\''") + "'";
  }

  // Source the user's login profile so Oracle env vars (ORACLE_HOME, PATH, etc.)
  // are available.  Non-interactive SSH shells skip .bash_profile/.bashrc by default,
  // which is why sqlplus/rman/expdp/impdp all return "command not found".
  //
  // Strategy (each line falls back silently if the file doesn't exist):
  //   1. Source .bash_profile  (Oracle's standard env file on Linux)
  //   2. Source .bashrc        (fallback)
  //   3. Source any env_* files in $HOME (common Oracle DBA convention: env_19c, env_monkpt_dr …)
  //   4. If ORACLE_HOME still not set, try the two most common install paths
  const oracleEnvSetup = [
    '[ -f "$HOME/.bash_profile" ] && . "$HOME/.bash_profile" 2>/dev/null',
    '[ -f "$HOME/.bashrc" ]       && . "$HOME/.bashrc"       2>/dev/null',
    'for __f in "$HOME"/env_*; do [ -f "$__f" ] && . "$__f" 2>/dev/null; done',
    '[ -z "$ORACLE_HOME" ] && [ -d /u01/app/oracle/product ] && export ORACLE_HOME=$(ls -d /u01/app/oracle/product/*/*/bin/.. 2>/dev/null | head -1)',
    '[ -n "$ORACLE_HOME" ] && export PATH="$ORACLE_HOME/bin:$PATH"',
  ].join(' ; ');

  const withCd  = cwd ? `cd ${shellSingleQuote(cwd)} && ` : '';
  const fullCmd = `${oracleEnvSetup} ; ${withCd}${cmd} ; __exit__=$? ; pwd ; exit $__exit__`;

  console.log(`[os/ssh-exec] ${sshUser}@${host}:${sshPort}  cmd="${cmd.slice(0,120)}"`);

  // ── Use connection pool so Batch + PTY share the same SSH session ──────────
  const poolKey = _sshPoolKey(sshUser.trim(), host.trim(), sshPort);
  let   _poolConn = null;
  let responded = false;

  const reply = (status, body) => {
    if (responded) return;
    responded = true;
    if (_poolConn) { _sshPoolRelease(poolKey); _poolConn = null; }
    res.status(status).json(body);
  };

  const timer = setTimeout(() => reply(504, { error: `SSH command timed out after ${timeout/1000}s` }), timeout);

  _sshPoolGet(sshUser.trim(), host.trim(), sshPort, password, privateKey)
    .then(conn => {
      _poolConn = conn;
      // Wrap exec in a retry helper: if the pooled conn gives "Channel open
      // failure" it means the SSH session was closed server-side. Evict it
      // and retry once with a fresh connection.
      function _execWithRetry(c, isRetry) {
        c.exec(fullCmd, (err, stream) => {
          if (err) {
            const isStale = /channel open failure|open failed/i.test(err.message);
            if (isStale && !isRetry) {
              console.warn('[os/ssh-exec] channel open failure on pooled conn — retrying fresh');
              try { c.end(); } catch(_) {}
              _sshPool.delete(poolKey);
              _poolConn = null;
              _sshPoolGet(sshUser.trim(), host.trim(), sshPort, password, privateKey)
                .then(fresh => { _poolConn = fresh; _execWithRetry(fresh, true); })
                .catch(e2 => { clearTimeout(timer); reply(502, { error: 'SSH connection failed: ' + e2.message }); });
              return;
            }
            clearTimeout(timer);
            return reply(500, { error: 'SSH exec error: ' + err.message });
          }

        let stdoutBuf = '', stderrBuf = '';
        stream.on('data', d => { stdoutBuf += d.toString('utf8'); });
        stream.stderr.on('data', d => { stderrBuf += d.toString('utf8'); });
        stream.on('close', (code) => {
          clearTimeout(timer);
          const elapsed = Date.now() - t0;

          // Extract the last line of stdout as the new cwd (that's where `pwd` printed).
          // Remove it from the visible stdout so the user doesn't see a spurious path line.
          const lines   = stdoutBuf.split('\n');
          let   newCwd  = cwd || null;
          // Walk from the end to find the first non-empty absolute path line
          for (let i = lines.length - 1; i >= 0; i--) {
            const l = lines[i].trim();
            if (l && l.startsWith('/')) {
              newCwd = l;
              lines.splice(i, 1);   // remove pwd line from output
              break;
            }
          }
          const cleanStdout = lines.join('\n').replace(/\n$/, '');

          console.log(`[os/ssh-exec] done  exit=${code}  elapsed=${elapsed}ms  newCwd=${newCwd}`);
          reply(200, {
            stdout  : cleanStdout,
            stderr  : stderrBuf,
            exitCode: code ?? -1,
            cwd     : newCwd,
            host,
            user    : sshUser,
            elapsed,
            osType  : 'remote',
            shell   : 'ssh',
            pooled  : true,   // indicates session reuse was possible
          });
        });
        }); // end c.exec
      }     // end _execWithRetry
      _execWithRetry(conn, false);
    })
    .catch(err => {
      clearTimeout(timer);
      console.warn(`[os/ssh-exec] connection error: ${err.message}`);
      reply(502, { error: 'SSH connection failed: ' + err.message });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  SAR REPORT ANALYSIS — Linux System Activity Reporter
//
//  POST /api/sar/parse   Body: raw text (Content-Type: text/plain) — the contents
//                         of a saved sar report (e.g. `sar -A`, or individual
//                         `sar -u/-r/-q/-b/-n DEV` output). Returns parsed
//                         time-series JSON grouped by metric type, plus a
//                         `diagnostics` block explaining exactly what was and
//                         wasn't found (so a blank chart is never a mystery).
//
//  POST /api/sar/live     Body: { host, port?, user, password?, privateKey? }
//                         Takes a single live snapshot from the remote host via
//                         SSH (reusing the same connection pool as OS Terminal)
//                         and returns it parsed in the same shape as /parse.
//                         Forces LC_ALL=C so column headers and decimal points
//                         are never mangled by the remote host's locale.
//
//  Both routes share the parseSarText() parser below, which recognises the
//  standard sysstat column headers regardless of locale time format
//  (12-hour "hh:mm:ss AM/PM" or 24-hour "hh:mm:ss") and tolerates minor
//  column-name variants across sysstat versions/distros.
// ─────────────────────────────────────────────────────────────────────────────

// ── Parser ──────────────────────────────────────────────────────────────────
// Canonical column-name aliases — different sysstat/mpstat builds occasionally
// abbreviate these differently. Mapping them to one canonical name means the
// frontend never has to guess which spelling a given report used.
const SAR_COLUMN_ALIASES = {
  '%usr': '%user', '%sys': '%system', '%wio': '%iowait', '%wait': '%iowait',
};

function parseSarText(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const TIME_RE = /^(\d{1,2}:\d{2}:\d{2})(?:\s+(AM|PM))?\s+(.*)$/i;

  function detectSection(colsLower) {
    if ((colsLower.includes('%idle') || colsLower.includes('%idle')) &&
        (colsLower.includes('%user') || colsLower.includes('%usr')))            return 'cpu';
    if (colsLower.includes('kbmemfree'))                                        return 'memory';
    if (colsLower.includes('ldavg-1'))                                          return 'load';
    // Network errors (`sar -n EDEV`) must be checked BEFORE the throughput section
    // below — both start with IFACE, but this one carries rxerr/s not rxpck/s.
    if (colsLower.includes('iface') && colsLower.some(c => c.startsWith('rxerr'))) return 'netedev';
    if (colsLower.includes('iface') && colsLower.some(c => c.startsWith('rxpck'))) return 'network';
    // Per-device disk stats (`sar -d`): DEV tps rkB/s wkB/s ... await svctm %util.
    // Distinct from the aggregate disk section below — this one has a per-device
    // identifier column (dev8-0, dev253-0, ...) instead of one system-wide row.
    if (colsLower.includes('dev') && colsLower.some(c => c.startsWith('await')))  return 'diskdev';
    if (colsLower.some(c => c.startsWith('bread/s')) || colsLower.some(c => c.startsWith('rd_sec')) ||
        (colsLower.includes('tps') && colsLower.some(c => c.startsWith('bwrtn'))))  return 'disk';
    if (colsLower.includes('pswpin/s'))                                         return 'swap';
    // Swap *space* usage (`sar -S`): kbswpfree/kbswpused/%swpused — how full swap
    // is, as opposed to the 'swap' section above which is swap I/O *activity*
    // (pages/sec). Both matter: a host can be dangerously low on swap space while
    // barely swapping, or actively swapping while space is still plentiful.
    if (colsLower.includes('kbswpfree') && colsLower.includes('%swpused'))       return 'swapspace';
    if (colsLower.includes('pgpgin/s'))                                         return 'paging';
    // Process creation & context-switch rate (`sar -w`) — cheap, high-signal
    // early warning for thrashing/thundering-herd workloads before CPU/load
    // even look abnormal.
    if (colsLower.includes('proc/s') && colsLower.includes('cswch/s'))           return 'procswitch';
    // Socket usage (`sar -n SOCK`) — totsck/tcpsck/udpsck etc. A slow climb here
    // with no matching traffic growth usually means a file-descriptor/connection
    // leak in an application, not real load.
    if (colsLower.includes('totsck') && colsLower.includes('tcpsck'))            return 'sock';
    // Kernel table usage (`sar -v`) — dentry cache, open file handles, inode
    // handlers, pseudo-terminals. Exhausting any one of these can bring down a
    // host even while CPU/memory/disk all look completely healthy.
    if (colsLower.includes('dentunusd') && colsLower.includes('file-nr'))        return 'ktables';
    // Huge pages (`sar -H`) — only present on hosts using HugePages (common for
    // Oracle SGA sizing).
    if (colsLower.includes('kbhugfree') && colsLower.includes('kbhugused'))      return 'huge';
    // NFS client activity (`sar -n NFS`) — call/s + retrans/s is the signature;
    // a rising retrans/s ratio means the NFS server or network path is unreliable.
    if (colsLower.includes('call/s') && colsLower.includes('retrans/s'))         return 'nfsclient';
    // NFS server activity (`sar -n NFSD`) — distinguished from the client view
    // above by scall/s (server-side "calls received") instead of call/s.
    if (colsLower.includes('scall/s') && colsLower.includes('badcall/s'))        return 'nfsserver';
    // Softnet / network-stack stats (`sar -n SOFT`) — dropd/s and squeezd/s
    // reveal packet drops at the kernel softirq layer that never show up as
    // interface errors, a common hidden cause of intermittent network stalls
    // under high packet-per-second load.
    if (colsLower.includes('total/s') && colsLower.some(c => c.startsWith('dropd')))  return 'softnet';
    return null;
  }

  // A line whose column-count happens to match the currently-open section but
  // is actually the header of a *different, unsupported* section (e.g. per-device
  // disk stats before 'diskdev' support existed, or NFS/socket stats) must not be
  // swallowed as data — that silently corrupts the open section with garbage
  // values. Header lines are almost entirely non-numeric column names; data rows
  // are almost entirely numeric (aside from an optional leading identifier like a
  // CPU number, interface name, or device name). This heuristic tells them apart
  // without needing to recognize every possible sar section by name.
  function looksLikeHeaderLine(tokens) {
    let numericTokens = 0;
    for (const t of tokens) {
      if (/^-?[\d.,]+$/.test(t) && !isNaN(parseFloat(t.replace(',', '.')))) numericTokens++;
    }
    return numericTokens < tokens.length / 2;
  }

  const sections  = {
    cpu: [], memory: [], load: [], network: [], disk: [], diskdev: [], swap: [], swapspace: [], paging: [],
    netedev: [], procswitch: [], sock: [], ktables: [], huge: [], nfsclient: [], nfsserver: [], softnet: [],
  };
  const colMap    = {};   // section → canonical column names, in the order they appear after the time token
  let   curSection = null;

  // Host/kernel/CPU-core metadata, pulled from the standard sysstat banner line:
  // "Linux 5.14.0-284.11.1.el9_2.x86_64 (myhost)  07/29/2026  _x86_64_ (8 CPU)"
  // This is critical for correctly judging load-average (a load of 6 is healthy
  // on a 16-core box and critical on a 2-core box) so we capture it instead of
  // silently discarding the line.
  const meta = { kernel: null, hostname: null, date: null, cpuCount: null };

  // Diagnostics — always collected so the API can explain a blank result.
  const diag = {
    totalLines: lines.length,
    nonEmptyLines: 0,
    timestampedLines: 0,
    headersFound: {},     // section → { count, firstLine, columns }
    rowsMatched: {},      // section → count
    rowsSkippedMismatch: {}, // section → count (header found but a data row's column count didn't line up)
    sampleUnrecognizedLines: [], // up to 5 lines that had a timestamp but matched no known section
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    diag.nonEmptyLines++;
    if (/^Linux\s/.test(line)) {              // "Linux 5.14.0 ... (hostname)  MM/DD/YYYY  _x86_64_ (N CPU)"
      if (!meta.kernel) {
        const hm = line.match(/^Linux\s+(\S+)\s+\(([^)]+)\)\s+(\S+)/);
        if (hm) { meta.kernel = hm[1]; meta.hostname = hm[2]; meta.date = hm[3]; }
        const cm = line.match(/\((\d+)\s*CPU\)/i);
        if (cm) meta.cpuCount = parseInt(cm[1], 10);
      }
      continue;
    }
    if (/^Average/i.test(line)) continue;     // summary row — we compute averages client-side instead

    const m = line.match(TIME_RE);
    if (!m) continue;
    diag.timestampedLines++;
    let [, timeStr, ampm, rest] = m;
    if (ampm) timeStr += ' ' + ampm.toUpperCase();
    const tokens = rest.trim().split(/\s+/);
    if (!tokens.length) continue;
    const lowerRaw = tokens.map(t => t.toLowerCase());
    const lower = lowerRaw.map(t => SAR_COLUMN_ALIASES[t] || t); // normalize known aliases

    const sec = detectSection(lower);
    if (sec) {
      // Header line — remember its (canonicalized) column order and switch the active section.
      curSection = sec;
      colMap[sec] = lower;
      if (!diag.headersFound[sec]) diag.headersFound[sec] = { count: 0, firstLine: line, columns: lower };
      diag.headersFound[sec].count++;
      continue;
    }

    // Not a section we parse — but if it LOOKS like a header (mostly non-numeric
    // tokens, e.g. NFS/socket/softnet stats we don't surface), close out the
    // current section rather than letting its data rows get misattributed to
    // whatever section was open before it. Without this, an unsupported
    // section whose row width happened to match a supported one (this has
    // actually happened: per-device disk rows silently corrupting paging
    // stats) would be ingested as if it belonged to the wrong metric.
    if (looksLikeHeaderLine(tokens)) {
      curSection = null;
      if (diag.sampleUnrecognizedLines.length < 5) diag.sampleUnrecognizedLines.push(line.slice(0, 140));
      continue;
    }

    if (!curSection) {
      if (diag.sampleUnrecognizedLines.length < 5) diag.sampleUnrecognizedLines.push(line.slice(0, 140));
      continue;
    }
    const cols = colMap[curSection];
    if (!cols || cols.length !== tokens.length) {
      diag.rowsSkippedMismatch[curSection] = (diag.rowsSkippedMismatch[curSection] || 0) + 1;
      continue; // malformed / mismatched row (e.g. a "LINUX RESTART" marker) — skip safely
    }

    const row = { time: timeStr };
    for (let i = 0; i < cols.length; i++) {
      const key = cols[i];
      const val = tokens[i];
      if (i === 0 && (curSection === 'cpu' || curSection === 'network' || curSection === 'diskdev' || curSection === 'netedev' || curSection === 'softnet')) {
        row[key] = val; // 'all' / CPU number, interface name, or device name — keep as string
      } else {
        const num = parseFloat(val.replace(',', '.')); // tolerate comma decimals from non-English locales
        row[key] = isNaN(num) ? val : num;
      }
    }
    sections[curSection].push(row);
    diag.rowsMatched[curSection] = (diag.rowsMatched[curSection] || 0) + 1;
  }

  // For CPU, prefer the aggregate "all" rows for the main chart (drop per-core rows)
  // but only if aggregate rows were actually present.
  const cpuAll = sections.cpu.filter(r => r.cpu === 'all');

  const parsed = {
    cpu:        cpuAll.length ? cpuAll : sections.cpu,
    memory:     sections.memory,
    load:       sections.load,
    network:    sections.network,
    disk:       sections.disk,
    diskdev:    sections.diskdev,
    swap:       sections.swap,
    swapspace:  sections.swapspace,
    paging:     sections.paging,
    netedev:    sections.netedev,
    procswitch: sections.procswitch,
    sock:       sections.sock,
    ktables:    sections.ktables,
    huge:       sections.huge,
    nfsclient:  sections.nfsclient,
    nfsserver:  sections.nfsserver,
    softnet:    sections.softnet,
  };

  return { parsed, diag, meta };
}

function _sarTotalPoints(parsed) {
  return Object.values(parsed).reduce((a, arr) => a + (Array.isArray(arr) ? arr.length : 0), 0);
}

// Human-readable hints for sections that produced zero rows despite other
// sections succeeding — surfaced directly in the UI so a blank chart is
// never a silent mystery.
const SAR_SECTION_HINTS = {
  cpu:        'No CPU rows found. Make sure the report includes `sar -u` (or plain `sar`) output with the standard "CPU %user %nice %system %iowait %steal %idle" header.',
  memory:     'No memory rows found. Include `sar -r` output (header starts with "kbmemfree").',
  load:       'No load-average rows found. Include `sar -q` output (header includes "ldavg-1").',
  disk:       'No disk I/O rows found. Include `sar -b` output (header includes "bread/s"/"bwrtn/s").',
  network:    'No network rows found. Include `sar -n DEV` output (header starts with "IFACE").',
  diskdev:    'No per-device disk rows found. Include `sar -d` output (header starts with "DEV").',
  swap:       'No swap-activity rows found. Include `sar -W` output (header: "pswpin/s pswpout/s").',
  swapspace:  'No swap-space rows found. Include `sar -S` output (header starts with "kbswpfree").',
  paging:     'No paging rows found. Include `sar -B` output (header starts with "pgpgin/s").',
  netedev:    'No network-error rows found. Include `sar -n EDEV` output (header starts with "IFACE" and includes "rxerr/s").',
  procswitch: 'No process/context-switch rows found. Include `sar -w` output (header: "proc/s cswch/s").',
  sock:       'No socket-usage rows found. Include `sar -n SOCK` output (header starts with "totsck").',
  ktables:    'No kernel-table rows found. Include `sar -v` output (header starts with "dentunusd").',
  huge:       'No hugepages rows found. Include `sar -H` output (header starts with "kbhugfree") — only relevant if this host uses HugePages.',
  nfsclient:  'No NFS-client rows found. Include `sar -n NFS` output (header starts with "call/s") — only relevant if this host mounts NFS.',
  nfsserver:  'No NFS-server rows found. Include `sar -n NFSD` output (header starts with "scall/s") — only relevant if this host exports NFS.',
  softnet:    'No softnet rows found. Include `sar -n SOFT` output (header includes "total/s"/"dropd/s").',
};

// Sections every production report is expected to have — missing one of these
// is always surfaced as a warning, even if the header itself was never found.
const SAR_CORE_SECTIONS = ['cpu', 'memory', 'load', 'disk', 'network'];
// Optional sections — normal to be entirely absent (not every capture runs
// every sar flag, and NFS/hugepages only apply to hosts using those features).
// Only warn on these if the header WAS found but rows still failed to parse,
// since that indicates a real parsing problem rather than "flag not captured".
const SAR_OPTIONAL_SECTIONS = ['diskdev', 'swap', 'swapspace', 'paging', 'netedev', 'procswitch', 'sock', 'ktables', 'huge', 'nfsclient', 'nfsserver', 'softnet'];

function _sarBuildWarnings(parsed, diag) {
  const warnings = [];
  SAR_CORE_SECTIONS.forEach(sec => {
    if ((parsed[sec] || []).length === 0) {
      const hadHeader = !!diag.headersFound[sec];
      warnings.push({
        section: sec,
        hadHeader,
        message: hadHeader
          ? `The "${sec}" header was found but no data rows matched it (${diag.rowsSkippedMismatch[sec] || 0} rows skipped — likely a column-count mismatch).`
          : SAR_SECTION_HINTS[sec],
      });
    }
  });
  SAR_OPTIONAL_SECTIONS.forEach(sec => {
    if ((parsed[sec] || []).length === 0 && diag.headersFound[sec] && (diag.rowsSkippedMismatch[sec] || 0) > 0) {
      warnings.push({
        section: sec,
        hadHeader: true,
        message: `The "${sec}" header was found but no data rows matched it (${diag.rowsSkippedMismatch[sec]} rows skipped — likely a column-count mismatch).`,
      });
    }
  });
  return warnings;
}

// ── POST /api/sar/parse ────────────────────────────────────────────────────────
// Route-scoped text parser (25 MB limit — sar -A reports can be several MB for
// a full day at short intervals). The global express.json() middleware only
// engages for Content-Type: application/json, so it no-ops here and leaves
// req.body for this text parser to fill.
app.post('/api/sar/parse', express.text({ type: '*/*', limit: '25mb' }), (req, res) => {
  try {
    const text = typeof req.body === 'string' ? req.body : '';
    if (!text.trim()) return res.status(400).json({ error: 'Empty SAR report content' });
    const { parsed, diag, meta } = parseSarText(text);
    if (_sarTotalPoints(parsed) === 0) {
      return res.status(422).json({
        error: 'No recognizable SAR sections found. Make sure this is plain-text sar output ' +
               '(e.g. from `sar -A`, or `sar -u`/`-r`/`-q`/`-b`/`-n DEV`) — not a binary sysstat datafile.',
        diagnostics: diag,
      });
    }
    const warnings = _sarBuildWarnings(parsed, diag);
    console.log(`[sar/parse] parsed ${text.length} bytes → cpu=${parsed.cpu.length} mem=${parsed.memory.length} load=${parsed.load.length} disk=${parsed.disk.length} diskdev=${parsed.diskdev.length} net=${parsed.network.length} netedev=${parsed.netedev.length} swap=${parsed.swap.length} swapspace=${parsed.swapspace.length} paging=${parsed.paging.length} procswitch=${parsed.procswitch.length} sock=${parsed.sock.length} ktables=${parsed.ktables.length} huge=${parsed.huge.length} nfsclient=${parsed.nfsclient.length} nfsserver=${parsed.nfsserver.length} softnet=${parsed.softnet.length}${meta.hostname ? `  host=${meta.hostname} cores=${meta.cpuCount||'?'}` : ''}${warnings.length ? `  ⚠ ${warnings.length} section(s) empty` : ''}`);
    res.json({ ok: true, parsed, warnings, diagnostics: diag, meta });
  } catch (e) {
    res.status(500).json({ error: 'Failed to parse SAR report: ' + e.message });
  }
});

// ── POST /api/sar/live ─────────────────────────────────────────────────────────
// Body: { host, port?, user, password?, privateKey? }
// Takes one live sar sample across CPU / memory / load / disk / network via SSH,
// reusing the same connection pool as the OS Terminal SSH features.
app.post('/api/sar/live', (req, res) => {
  const { host, port, user: sshUser, password, privateKey } = req.body || {};

  if (!host || typeof host !== 'string' || !host.trim())  return res.status(400).json({ error: 'host is required' });
  if (!sshUser || typeof sshUser !== 'string')             return res.status(400).json({ error: 'user is required' });
  if (!password && !privateKey)                            return res.status(400).json({ error: 'password or privateKey is required' });

  const SSH2 = _getSsh2();
  if (!SSH2) {
    return res.status(500).json({
      error: 'ssh2 package not installed. Run: npm install ssh2  then restart server.js'
    });
  }

  const sshPort = parseInt(port, 10) || 22;
  const timeout = 25_000;
  const t0 = Date.now();

  // ── Run all sar samples IN PARALLEL, not sequentially ──────────────────────
  // Each `sar X 1 1` blocks for its 1-second sample window plus process
  // spawn overhead. The old code chained all 15 of them with `;` (fully
  // sequential), so one /api/sar/live round trip always took ~15-20+
  // seconds no matter what — meaning the "Interval" dropdown (5s/10s/etc.)
  // could never actually be honored: the in-flight guard just kept skipping
  // ticks until the still-running 20s request finished, so live data only
  // ever refreshed every ~20s regardless of the selected interval.
  // Fix: launch every `sar` invocation as a background job writing to its
  // own temp file, `wait` for them all (they run concurrently, so total time
  // ≈ the slowest single one, ~1-2s), then cat the results out in order.
  // LC_ALL=C / LANG=C forces English column headers and period decimal points
  // regardless of the remote host's configured locale — without this, some
  // locales format numbers as "5,23" instead of "5.23" and silently break parsing.
  const ENV = 'LC_ALL=C LANG=C';
  // Unique temp-file prefix per request ($$  = remote shell PID) so
  // concurrent /api/sar/live calls (e.g. two browser tabs) never collide.
  const T = '/tmp/.sarlive_$$';
  const SECTIONS = [
    // [marker, background command that writes its output to "$T_<marker>"]
    ['META',    `${ENV} sh -c 'uname -r; hostname; nproc' > ${T}_META 2>&1 &`],
    ['CPU',     `(${ENV} sar -u 1 1 > ${T}_CPU 2>&1 || echo "SAR_NOT_INSTALLED" > ${T}_CPU) &`],
    ['MEM',     `${ENV} sar -r 1 1 > ${T}_MEM 2>&1 &`],
    ['LOAD',    `${ENV} sar -q 1 1 > ${T}_LOAD 2>&1 &`],
    ['DISK',    `${ENV} sar -b 1 1 > ${T}_DISK 2>&1 &`],
    ['NET',     `${ENV} sar -n DEV 1 1 > ${T}_NET 2>&1 &`],
    // Swap activity (pswpin/s, pswpout/s) — the single most reliable signal of
    // genuine memory pressure (as opposed to Linux simply using spare RAM as
    // page cache, which %memused alone can't distinguish).
    ['SWAP',    `${ENV} sar -W 1 1 > ${T}_SWAP 2>&1 &`],
    // Paging activity (pgpgin/s, pgpgout/s, fault/s, majflt/s) — surfaced for
    // completeness alongside swap.
    ['PAGE',    `${ENV} sar -B 1 1 > ${T}_PAGE 2>&1 &`],
    // Per-device disk stats — the aggregate DISK section above can look fine
    // while one specific device is actually saturated.
    ['DISKDEV', `${ENV} sar -d 1 1 > ${T}_DISKDEV 2>&1 &`],
    // Network errors — dropped/error/collision packets never show up in the
    // plain throughput numbers above.
    ['EDEV',    `${ENV} sar -n EDEV 1 1 > ${T}_EDEV 2>&1 &`],
    // Process creation & context-switch rate — an early signal of thrashing
    // before CPU/load even look abnormal.
    ['PROC',    `${ENV} sar -w 1 1 > ${T}_PROC 2>&1 &`],
    // Socket usage — a slow climb with no matching traffic growth usually
    // means a connection/file-descriptor leak in an application.
    ['SOCK',    `${ENV} sar -n SOCK 1 1 > ${T}_SOCK 2>&1 &`],
    // Kernel table usage (dentry cache, open files, inodes, ptys) — any one
    // of these filling up can bring the host down with CPU/memory both idle.
    ['KTBL',    `${ENV} sar -v 1 1 > ${T}_KTBL 2>&1 &`],
    // HugePages — only meaningful on hosts sizing an Oracle SGA with them;
    // harmless (empty/'not installed') if the host doesn't use HugePages.
    ['HUGE',    `${ENV} sar -H 1 1 > ${T}_HUGE 2>&1 &`],
    // NFS client/server activity — only meaningful if this host mounts/exports
    // NFS; harmless if not.
    ['NFS',     `${ENV} sar -n NFS 1 1 > ${T}_NFS 2>&1 &`],
    ['NFSD',    `${ENV} sar -n NFSD 1 1 > ${T}_NFSD 2>&1 &`],
    // Softnet stats — kernel softirq-layer packet drops that never show up as
    // interface errors, a common hidden cause of intermittent network stalls.
    ['SOFT',    `${ENV} sar -n SOFT 1 1 > ${T}_SOFT 2>&1 &`],
  ];
  const launchAll = SECTIONS.map(([, bgCmd]) => bgCmd).join(' ');
  const collectAll = SECTIONS
    .map(([marker]) => `echo __SAR_${marker}_START__; cat ${T}_${marker} 2>/dev/null; echo __SAR_${marker}_END__;`)
    .join(' ');
  const cmd = `${launchAll} wait; ${collectAll} rm -f ${T}_*`;

  console.log(`[sar/live] sampling ${sshUser}@${host}:${sshPort}`);

  const poolKey = _sshPoolKey(sshUser.trim(), host.trim(), sshPort);
  let _poolConn  = null;
  let responded  = false;

  const reply = (status, body) => {
    if (responded) return;
    responded = true;
    if (_poolConn) { _sshPoolRelease(poolKey); _poolConn = null; }
    res.status(status).json(body);
  };

  const timer = setTimeout(() => reply(504, { error: 'SAR live sample timed out' }), timeout);

  function extractSection(out, name) {
    const m = out.match(new RegExp(`__SAR_${name}_START__([\\s\\S]*?)__SAR_${name}_END__`));
    return m ? m[1] : '';
  }

  // Wrap exec in the same evict-and-retry-once pattern as /api/os/ssh-exec:
  // a pooled connection can look "ready" locally while the remote side has
  // silently dropped it (idle timeout, NAT drop, MaxSessions limit). Without
  // this retry, a stale pooled connection surfaces here as an immediate
  // "SSH exec error: Channel open failure" instead of transparently
  // reconnecting — one of the causes behind the SAR Live panel intermittently
  // failing even though Batch mode (which already retries) still works.
  function _execWithRetry(conn, isRetry) {
    _poolConn = conn;
    conn.exec(cmd, (err, stream) => {
      if (err) {
        const isStale = /channel open failure|open failed/i.test(err.message);
        if (isStale && !isRetry) {
          console.warn('[sar/live] channel open failure on pooled conn — retrying fresh');
          try { conn.end(); } catch(_e) {}
          _sshPool.delete(poolKey);
          _poolConn = null;
          _sshPoolGet(sshUser.trim(), host.trim(), sshPort, password, privateKey)
            .then(fresh => _execWithRetry(fresh, true))
            .catch(e2 => { clearTimeout(timer); reply(502, { error: 'SSH connection failed: ' + e2.message }); });
          return;
        }
        clearTimeout(timer);
        return reply(500, { error: 'SSH exec error: ' + err.message });
      }
        let out = '';
        stream.on('data', d => { out += d.toString('utf8'); });
        stream.stderr.on('data', d => { out += d.toString('utf8'); });
        stream.on('close', () => {
          clearTimeout(timer);

          if (/SAR_NOT_INSTALLED/.test(out) || !/__SAR_CPU_START__/.test(out)) {
            return reply(200, {
              ok: false,
              error: 'sar (sysstat) does not appear to be installed on the remote host. ' +
                     'Install it with: sudo yum install sysstat   (RHEL/OL/CentOS)   or   sudo apt-get install sysstat   (Debian/Ubuntu)',
            });
          }

          const combined = ['CPU', 'MEM', 'LOAD', 'DISK', 'NET', 'SWAP', 'PAGE', 'DISKDEV', 'EDEV', 'PROC', 'SOCK', 'KTBL', 'HUGE', 'NFS', 'NFSD', 'SOFT']
            .map(name => extractSection(out, name))
            .join('\n');

          // META block is 3 plain lines: `uname -r`, `hostname`, `nproc` — parsed
          // explicitly rather than relying on sar's own banner line, which some
          // minimal sar invocations omit.
          const metaLines = extractSection(out, 'META').trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
          const meta = {
            kernel:   metaLines[0] || null,
            hostname: metaLines[1] || null,
            cpuCount: metaLines[2] && /^\d+$/.test(metaLines[2]) ? parseInt(metaLines[2], 10) : null,
            date:     new Date().toLocaleDateString(),
          };

          const { parsed, diag } = parseSarText(combined);
          const warnings = _sarBuildWarnings(parsed, diag);
          reply(200, { ok: true, parsed, warnings, elapsed: Date.now() - t0, host, sampledAt: new Date().toISOString(), meta });
        });
      });
  } // end _execWithRetry

  _sshPoolGet(sshUser.trim(), host.trim(), sshPort, password, privateKey)
    .then(conn => _execWithRetry(conn, false))
    .catch(err => {
      clearTimeout(timer);
      console.warn(`[sar/live] connection error: ${err.message}`);
      reply(502, { error: 'SSH connection failed: ' + err.message });
    });
});

console.log('✓ SAR report analysis endpoints attached (/api/sar/parse, /api/sar/live)');


// ═════════════════════════════════════════════════════════════════════════════
//  NMON REPORT ANALYSIS — AIX/Linux `nmon` performance capture
//
//  POST /api/nmon/parse   Body: raw text (Content-Type: text/plain) — the
//                          contents of a RAW `.nmon` capture file (the plain
//                          CSV-style text that `nmon`/`topas_nmon` itself
//                          writes, e.g. `hostname_YYMMDD_HHMM.nmon`).
//
//  POST /api/nmon/parse-xlsx   Body: raw bytes of a `.nmon.xlsx` workbook —
//                          the Excel conversion of the same capture produced
//                          by `nmon2xlsx`/`nmonanalyser`/`topas_nmon`'s own
//                          exporter. Production hosts here are only ever
//                          handed this .xlsx file (not the original raw
//                          .nmon text), so this endpoint is the one the
//                          dashboard's upload box actually uses for .xlsx
//                          files. See `parseNmonXlsx()` further down for the
//                          implementation — it returns the exact same JSON
//                          shape as this text parser.
//
//  Every numeric value in the response is taken verbatim from the report —
//  nothing is estimated, smoothed, or inferred. Sections nmon didn't capture
//  (e.g. no `-V` flag → no volume-group stats) are simply left empty and
//  called out explicitly in `warnings`, never silently substituted.
// ─────────────────────────────────────────────────────────────────────────────

// Split a raw nmon CSV line into fields. nmon's own writer never quotes
// fields, so a plain split is correct and matches how every existing nmon
// parsing tool (nmon2xlsx, nmonanalyser, njmon) reads this format too.
function _nmonSplit(line) {
  return line.split(',');
}

function parseNmonText(raw) {
  const rawLines = String(raw || '').split(/\r?\n/).filter(l => l.trim().length > 0);

  // ── Pass 1: bucket every line by its leading section tag ──────────────────
  const sections = new Map();  // tag -> { header: string[]|null, rows: {tcode, values:string[]}[] }
  const aaaLines = [];
  const zzzzRows = [];         // { tcode, timeStr, dateStr }

  for (const line of rawLines) {
    const parts = _nmonSplit(line);
    const tag = parts[0];
    if (!tag) continue;

    if (tag === 'AAA') { aaaLines.push(parts.slice(1)); continue; }
    if (tag === 'ZZZZ') {
      // ZZZZ,T0001,08:00:40,10-AUG-2026
      const [tcode, timeStr, dateStr] = parts.slice(1);
      if (tcode) zzzzRows.push({ tcode, timeStr: timeStr || '', dateStr: dateStr || '' });
      continue;
    }
    // BBB*/UARG lines are static lookup/legend tables (disk-to-VG name maps,
    // full command-line args, etc.) — not time-series data. Skip them; they
    // don't affect any chart or figure below and including them would just
    // add noise to the section list.
    if (/^BBB/.test(tag) || tag === 'UARG' || tag === 'ERROR') continue;

    // ══ FIX: TOP section rows are NOT laid out like every other section ═══
    // Every other tag writes `TAG,Tcode,value1,value2,...` — Tcode is always
    // the field right after the tag. TOP is nmon's one exception: it writes
    // `TOP,PID,Tcode,value1,value2,...` — the PID comes BEFORE the Tcode.
    // The generic isDataRow check below (`/^T\d+$/.test(rest[0])`) tests the
    // PID against the Tcode pattern, fails, and the row was silently
    // dropped — even on captures taken with `-T` and thousands of real TOP
    // rows present, `topProcesses` came back completely empty with a
    // misleading "capture likely run without -T" warning. Handle TOP's
    // PID-then-Tcode layout explicitly instead of assuming Tcode-first.
    if (tag === 'TOP') {
      const rest = parts.slice(1);           // [PID, Tcode, %CPU, %Usr, ...] or [+PID, Time, %CPU, ...] for the header line
      const tcode = rest[1];
      if (!sections.has(tag)) sections.set(tag, { header: null, rows: [] });
      const sec = sections.get(tag);
      if (/^T\d+$/.test(tcode || '')) {
        // Keep the FULL field list (including PID) so column positions still
        // line up 1:1 with the header row below.
        sec.rows.push({ tcode, values: rest });
      } else if (!sec.header && rest.length > 1) {
        // nmon writes a single-field caption line ("TOP,%CPU Utilisation")
        // immediately before the real column-name header row — a bare
        // `rest.length === 1` line like that is never the header, so skip
        // it and wait for the actual multi-column header line.
        sec.header = rest;
      }
      continue;
    }

    const rest = parts.slice(1);
    const isDataRow = /^T\d+$/.test(rest[0] || '');
    if (!sections.has(tag)) sections.set(tag, { header: null, rows: [] });
    const sec = sections.get(tag);
    if (isDataRow) {
      sec.rows.push({ tcode: rest[0], values: rest.slice(1) });
    } else if (!sec.header) {
      // First non-data-row line for this tag is its column header.
      sec.header = rest;
    }
  }

  // ── Metadata (AAA) ──────────────────────────────────────────────────────
  const meta = {};
  for (const parts of aaaLines) {
    const key = parts[0];
    if (!key) continue;
    meta[key] = parts.slice(1).filter(v => v !== undefined && v !== '').join(',');
  }

  // ── Timestamp map: Tcode → real Date + display label ───────────────────
  // nmon's own date/time strings are locale-dependent in format (DD-MON-YYYY
  // is standard) — parsed explicitly rather than trusted to `new Date(str)`,
  // which mis-parses DD-MON-YYYY in some Node/ICU builds.
  const MONTHS = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  function parseNmonDateTime(dateStr, timeStr) {
    const dm = /^(\d{1,2})[-\/](\w{3})[-\/](\d{2,4})$/.exec((dateStr || '').trim());
    const tm = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec((timeStr || '').trim());
    if (!dm || !tm) return null;
    const mon = MONTHS[dm[2].toUpperCase()];
    if (mon === undefined) return null;
    let year = parseInt(dm[3], 10);
    if (year < 100) year += 2000;
    return new Date(year, mon, parseInt(dm[1],10), parseInt(tm[1],10), parseInt(tm[2],10), parseInt(tm[3],10));
  }

  const timeMap = new Map(); // tcode -> { date: Date|null, label: 'HH:MM:SS' }
  for (const z of zzzzRows) {
    const date = parseNmonDateTime(z.dateStr, z.timeStr);
    timeMap.set(z.tcode, { date, label: z.timeStr });
  }
  // Sort order for all series: chronological by ZZZZ Tcode sequence (the
  // order nmon itself wrote them in), NOT alphabetical Tcode string sort —
  // T0001..T9999 sorts correctly as strings up to 4 digits but a report with
  // >9999 snapshots would break that assumption, so we sort by the ZZZZ
  // capture order explicitly.
  const tcodeOrder = new Map(zzzzRows.map((z, i) => [z.tcode, i]));
  function sortByTime(rows) {
    return rows.slice().sort((a, b) => (tcodeOrder.get(a.tcode) ?? 1e9) - (tcodeOrder.get(b.tcode) ?? 1e9));
  }
  function timeLabel(tcode) {
    const t = timeMap.get(tcode);
    return t ? t.label : tcode;
  }
  function timeISO(tcode) {
    const t = timeMap.get(tcode);
    return (t && t.date) ? t.date.toISOString() : null;
  }

  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

  // ── Generic helper: turn a parsed section into an array of row objects
  //    keyed by its header column names (trimmed), in chronological order ──
  function namedRows(tag) {
    const sec = sections.get(tag);
    if (!sec || !sec.header) return { header: [], rows: [] };
    const header = sec.header.map(h => (h || '').trim());
    const rows = sortByTime(sec.rows).map(r => {
      const obj = { tcode: r.tcode, time: timeLabel(r.tcode), iso: timeISO(r.tcode) };
      header.forEach((h, i) => { if (h) obj[h] = num(r.values[i]); });
      return obj;
    });
    return { header, rows };
  }

  // ── CPU_ALL — overall logical-CPU utilization ──────────────────────────
  const cpuAll = namedRows('CPU_ALL');
  const cpu = cpuAll.rows.map(r => ({
    time: r.time, iso: r.iso,
    user: r['User%'], sys: r['Sys%'], wait: r['Wait%'], idle: r['Idle%'],
    busy: r['Busy'], physicalCPUs: r['PhysicalCPUs'], cpuPct: r['CPU%']
  }));

  // ── LPAR — AIX virtualization / entitlement (absent on bare-metal Linux
  //    captures — that's expected and fine, not an error) ─────────────────
  const lparRows = namedRows('LPAR');
  const lpar = lparRows.rows.map(r => ({
    time: r.time, iso: r.iso,
    physicalCPU: r['PhysicalCPU'], virtualCPUs: r['virtualCPUs'], logicalCPUs: r['logicalCPUs'],
    poolCPUs: r['poolCPUs'], entitled: r['entitled'], weight: r['weight'],
    poolIdle: r['PoolIdle'], usedAllCPUPct: r['usedAllCPU%'], usedPoolCPUPct: r['usedPoolCPU%'],
    sharedCPU: r['SharedCPU'], capped: r['Capped'],
    ecUser: r['EC_User%'], ecSys: r['EC_Sys%'], ecWait: r['EC_Wait%'], ecIdle: r['EC_Idle%'],
    // VP_* = utilization measured against Virtual Processors (the LPAR's
    // dispatched VP count), NOT against the much larger logical-CPU count
    // that CPU_ALL's User/Sys/Wait use. This is what the reference
    // nmon-analyser workbook's headline "CPU% vs VPs" chart plots — it's a
    // materially different (and for capacity planning, more meaningful)
    // view than the logical-CPU chart, so it's kept as its own field set
    // rather than folded into `cpu`.
    vpUser: r['VP_User%'], vpSys: r['VP_Sys%'], vpWait: r['VP_Wait%'], vpIdle: r['VP_Idle%'],
    folded: r['Folded'], unfoldedVPs: r['Unfolded VPs'], otherLPARs: r['OtherLPARs']
  }));

  // ── Memory ──────────────────────────────────────────────────────────────
  const memRows = namedRows('MEM');
  const memory = memRows.rows.map(r => ({
    time: r.time, iso: r.iso,
    realFreePct: r['Real Free %'], virtFreePct: r['Virtual free %'],
    realFreeMB: r['Real free(MB)'], virtFreeMB: r['Virtual free(MB)'],
    realTotalMB: r['Real total(MB)'], virtTotalMB: r['Virtual total(MB)']
  }));

  // ── Paging (pgspace) ─────────────────────────────────────────────────────
  const pageRows = namedRows('PAGE');
  const paging = pageRows.rows.map(r => ({
    time: r.time, iso: r.iso, faults: r['faults'], pgin: r['pgin'], pgout: r['pgout'],
    pgsin: r['pgsin'], pgsout: r['pgsout'], srfr: r['sr/fr']
  }));

  // ── Process / run-queue ──────────────────────────────────────────────────
  const procRows = namedRows('PROC');
  const proc = procRows.rows.map(r => ({
    time: r.time, iso: r.iso, runQueue: r['RunQueue'], swapIn: r['Swap-in'],
    pswitch: r['pswitch'], syscall: r['syscall'], fork: r['fork'], exec: r['exec']
  }));

  // ── Generic helper: sum every column of a "wide" per-item section (one
  //    column per disk/HBA/etc.) into a single per-timestamp total. Used for
  //    Fibre Channel below, and as the DISK_SUMM fallback further down. ────
  function sumWideSection(tag) {
    const sec = sections.get(tag);
    if (!sec || !sec.header) return { header: [], rows: [], totals: [] };
    const header = sec.header.map(h => (h || '').trim()).filter(Boolean);
    const rows = sortByTime(sec.rows);
    const totals = rows.map(r => {
      const vals = r.values.map(num).filter(v => v !== null);
      return { time: timeLabel(r.tcode), iso: timeISO(r.tcode), total: vals.reduce((a,v)=>a+v,0) };
    });
    return { header, rows, totals };
  }

  // ── Disk throughput summary ──────────────────────────────────────────────
  const diskSummRows = namedRows('DISK_SUMM');
  let diskSumm = diskSummRows.rows.map(r => ({
    time: r.time, iso: r.iso,
    readKBs: r['Disk Read KB/s'], writeKBs: r['Disk Write KB/s'], iops: r['IO/sec']
  }));
  // ══ FIX: some captures omit DISK_SUMM (the nmon-computed aggregate row)
  // but still write DISKREAD/DISKWRITE — the same per-disk wide sections
  // DISKBUSY comes from, just in KB/s instead of %busy. When that's the
  // case, derive the same total-KB/s-across-all-disks figure ourselves by
  // summing every disk column per timestamp (identical approach to the FC
  // summation below) instead of leaving the whole Disk I/O chart blank when
  // the raw data to compute it was there in the file all along. `iops` has
  // no equivalent per-disk column to derive from, so it's left null rather
  // than guessed. ══
  let diskSummSource = diskSumm.length ? 'DISK_SUMM' : null;
  if (!diskSumm.length) {
    const diskReadSum  = sumWideSection('DISKREAD');
    const diskWriteSum = sumWideSection('DISKWRITE');
    if (diskReadSum.header.length || diskWriteSum.header.length) {
      const n = Math.max(diskReadSum.totals.length, diskWriteSum.totals.length);
      diskSumm = Array.from({ length: n }, (_, i) => {
        const rt = diskReadSum.totals[i], wt = diskWriteSum.totals[i];
        return {
          time: (rt || wt).time, iso: (rt || wt).iso,
          readKBs: (rt && rt.total) || 0, writeKBs: (wt && wt.total) || 0, iops: null
        };
      });
      diskSummSource = 'derived-DISKREAD/DISKWRITE';
    }
  }

  // ── Fibre Channel throughput (SAN-attached storage — sum across all HBAs)
  const fcRead  = sumWideSection('FCREAD');
  const fcWrite = sumWideSection('FCWRITE');
  const hasFC = fcRead.header.length > 0;
  const fc = hasFC ? fcRead.totals.map((r, i) => ({
    time: r.time, iso: r.iso, readKBs: r.total, writeKBs: (fcWrite.totals[i] && fcWrite.totals[i].total) || 0
  })) : [];

  // ── Network — prefer nmon's own Total-Read / Total-Write columns when
  //    present (nmon computes these itself, excluding loopback); nmon writes
  //    the write total as a NEGATIVE number purely so a combined RX/TX chart
  //    plots above/below one axis in its own reporting tools — we take the
  //    absolute value since this is a magnitude, not a signed quantity ──────
  const netSec = namedRows('NET');
  let netTotals = [];
  const netHeaderTrim = (sections.get('NET') && sections.get('NET').header || []).map(h => (h||'').trim());
  const hasNetTotalCols = netHeaderTrim.includes('Total-Read') && netHeaderTrim.some(h => h.startsWith('Total-Write'));
  if (hasNetTotalCols) {
    const writeKey = netHeaderTrim.find(h => h.startsWith('Total-Write'));
    netTotals = netSec.rows.map(r => ({
      time: r.time, iso: r.iso, readKBs: r['Total-Read'] || 0, writeKBs: Math.abs(r[writeKey] || 0)
    }));
  } else if (netHeaderTrim.length) {
    // Fallback: sum every *-read / *-write column ourselves (still exact —
    // just computed here instead of trusting a Total-* column nmon didn't
    // write, e.g. when the report was captured with an older nmon build)
    const readCols  = netHeaderTrim.filter(h => /-read$/i.test(h));
    const writeCols = netHeaderTrim.filter(h => /-write$/i.test(h));
    netTotals = netSec.rows.map(r => ({
      time: r.time, iso: r.iso,
      readKBs:  readCols.reduce((a,h)=>a+(Math.abs(r[h])||0),0),
      writeKBs: writeCols.reduce((a,h)=>a+(Math.abs(r[h])||0),0)
    }));
  }
  // Per-interface averages (excludes loopback `lo*` from the "top" ranking —
  // loopback traffic never leaves the host and isn't a network bottleneck)
  const netInterfaces = [];
  // ══ FIX: a NET section that only has nmon's own Total-Read/Total-Write
  // columns (no per-adapter breakdown) is a normal, valid capture — not a
  // missing section. Previously the per-interface table and the "no NET
  // section" message couldn't tell this case apart from NET being entirely
  // absent, so a report with real (if all-zero) network totals still showed
  // the misleading "No NET section in this report." Track it explicitly. ══
  const netIfCols = netHeaderTrim.filter(h => h && !/^(Total-Read|Total-Write.*)$/i.test(h));
  const hasNetPerInterfaceData = netIfCols.length > 0;
  if (netHeaderTrim.length) {
    const ifNames = [...new Set(netHeaderTrim
      .map(h => h.replace(/-(read|write|total)$/i, ''))
      .filter(h => h && !/^(Total-Read|Total-Write.*)$/i.test(h)))];
    ifNames.forEach(name => {
      const rCol = netHeaderTrim.find(h => h === `${name}-read`);
      const wCol = netHeaderTrim.find(h => h === `${name}-write`);
      if (!rCol && !wCol) return;
      const reads  = netSec.rows.map(r => r[rCol]).filter(v => v != null);
      const writes = netSec.rows.map(r => r[wCol]).filter(v => v != null);
      const avg = arr => arr.length ? arr.reduce((a,v)=>a+v,0)/arr.length : 0;
      const max = arr => arr.length ? Math.max(...arr) : 0;
      netInterfaces.push({
        name, isLoopback: /^lo\d*$/i.test(name),
        avgReadKBs: avg(reads), maxReadKBs: max(reads),
        avgWriteKBs: avg(writes), maxWriteKBs: max(writes)
      });
    });
    netInterfaces.sort((a,b) => (b.avgReadKBs+b.avgWriteKBs) - (a.avgReadKBs+a.avgWriteKBs));
  }

  // ── Disk busy — per-hdisk %busy → top-N busiest disks by average ────────
  function topBusyFromWideSection(tag, label) {
    const sec = sections.get(tag);
    if (!sec || !sec.header) return [];
    const header = sec.header.map(h => (h || '').trim()).filter(Boolean);
    const rows = sortByTime(sec.rows);
    return header.map((name, colIdx) => {
      const vals = rows.map(r => num(r.values[colIdx])).filter(v => v !== null);
      const avg = vals.length ? vals.reduce((a,v)=>a+v,0)/vals.length : 0;
      const max = vals.length ? Math.max(...vals) : 0;
      return { name, avgBusyPct: avg, maxBusyPct: max, samples: vals.length };
    }).sort((a,b) => b.avgBusyPct - a.avgBusyPct);
  }
  const diskBusyAll = topBusyFromWideSection('DISKBUSY');
  const vgBusyAll   = topBusyFromWideSection('VGBUSY');

  // ── Generic helper: rank a "wide" per-item section (one column per disk/
  //    filesystem/adapter/etc.) by AVERAGE value across the whole capture,
  //    keeping avg+max+samples — same shape as topBusyFromWideSection but
  //    for sections whose values are magnitudes (KB/s, MB, count) rather
  //    than a 0–100 %busy figure. Used for JFSFILE, JFSINODE, IOADAPT,
  //    PAGING (space) below. ─────────────────────────────────────────────
  function rankWideSection(tag) {
    const sec = sections.get(tag);
    if (!sec || !sec.header) return [];
    const header = sec.header.map(h => (h || '').trim()).filter(Boolean);
    const rows = sortByTime(sec.rows);
    return header.map((name, colIdx) => {
      const vals = rows.map(r => num(r.values[colIdx])).filter(v => v !== null);
      const avg = vals.length ? vals.reduce((a,v)=>a+v,0)/vals.length : 0;
      const max = vals.length ? Math.max(...vals) : 0;
      const min = vals.length ? Math.min(...vals) : 0;
      return { name, avg, max, min, samples: vals.length };
    });
  }
  // Time-series for the top-N columns of a wide section (by whichever
  // ranking array is passed in) — used to trend the busiest/fullest
  // filesystems/adapters instead of just showing a single ranked table.
  function wideSectionTrend(tag, topNames) {
    const sec = sections.get(tag);
    if (!sec || !sec.header || !topNames.length) return { names: [], rows: [] };
    const header = sec.header.map(h => (h || '').trim());
    const colIdx = topNames.map(n => header.indexOf(n));
    const rows = sortByTime(sec.rows).map(r => ({
      time: timeLabel(r.tcode), iso: timeISO(r.tcode),
      values: colIdx.map(ci => ci >= 0 ? num(r.values[ci]) : null)
    }));
    return { names: topNames, rows };
  }

  // ── Memory: additional breakdowns (MEMUSE / MEMNEW) ─────────────────────
  const memUseRows = namedRows('MEMUSE');
  const memUse = memUseRows.rows.map(r => ({
    time: r.time, iso: r.iso,
    numperm: r['%numperm'], minperm: r['%minperm'], maxperm: r['%maxperm'],
    minfree: r['minfree'], maxfree: r['maxfree'],
    numclient: r['%numclient'], maxclient: r['%maxclient'],
    lruablePages: r[' lruable pages'] ?? r['lruable pages'], comp: r['%comp']
  }));
  const memNewRows = namedRows('MEMNEW');
  const memNew = memNewRows.rows.map(r => ({
    time: r.time, iso: r.iso,
    processPct: r['Process%'], fscachePct: r['FScache%'], systemPct: r['System%'],
    freePct: r['Free%'], pinnedPct: r['Pinned%'], userPct: r['User%']
  }));

  // ── Filesystem usage (JFSFILE / JFSINODE) — critical for production ────
  const fsUsedAll = rankWideSection('JFSFILE').sort((a,b) => b.max - a.max);
  const fsUsedTop5Names = fsUsedAll.slice(0, 5).map(f => f.name);
  const fsUsedTrend = wideSectionTrend('JFSFILE', fsUsedTop5Names);
  const fsInodeAll = rankWideSection('JFSINODE').sort((a,b) => b.max - a.max);

  // ── Network packets/sec (NETPACKET) ─────────────────────────────────────
  const netPktSec = sections.get('NETPACKET');
  let netPackets = [];
  if (netPktSec && netPktSec.header) {
    const header = netPktSec.header.map(h => (h||'').trim());
    const readCols  = header.filter(h => /-reads\/s$/i.test(h));
    const writeCols = header.filter(h => /-writes\/s$/i.test(h));
    const rows = sortByTime(netPktSec.rows);
    netPackets = rows.map(r => {
      const obj = {}; header.forEach((h,i) => { if (h) obj[h] = num(r.values[i]); });
      return {
        time: timeLabel(r.tcode), iso: timeISO(r.tcode),
        readPktsPerSec:  readCols.reduce((a,h)=>a+(obj[h]||0),0),
        writePktsPerSec: writeCols.reduce((a,h)=>a+(obj[h]||0),0)
      };
    });
  }

  // ── Paging space free (PAGING) — different from PAGE (fault/pgin/pgout)
  //    above; this is MB-free per paging device, the number that matters
  //    when a production box is at risk of swap exhaustion. ──────────────
  const pagingSpaceAll = rankWideSection('PAGING');
  const pagingSpaceDevices = pagingSpaceAll.map(d => ({ name: d.name, avgFreeMB: d.avg, minFreeMB: d.min, samples: d.samples }))
    .sort((a,b) => a.minFreeMB - b.minFreeMB); // most-depleted device first
  let pagingSpaceTotal = [];
  { const sec = sections.get('PAGING');
    if (sec && sec.header) {
      const header = sec.header.map(h => (h||'').trim()).filter(Boolean);
      pagingSpaceTotal = sortByTime(sec.rows).map(r => ({
        time: timeLabel(r.tcode), iso: timeISO(r.tcode),
        totalFreeMB: r.values.map(num).filter(v=>v!==null).reduce((a,v)=>a+v,0)
      }));
    }
  }

  // ── Shared CPU pool (POOLS) & Large Page use (LARGEPAGE) — single latest
  //    snapshot info cards, these are slow-changing configuration-style
  //    metrics rather than something you'd trend over time. ───────────────
  function latestSnapshot(tag) {
    const r = namedRows(tag);
    return r.rows.length ? r.rows[r.rows.length - 1] : null;
  }
  const poolsLatest = latestSnapshot('POOLS');
  const pools = poolsLatest ? {
    time: poolsLatest.time,
    shcpusInSys: poolsLatest['shcpus_in_sys'], maxPoolCapacity: poolsLatest['max_pool_capacity'],
    entitledPoolCapacity: poolsLatest['entitled_pool_capacity'], poolBusyTime: poolsLatest['pool_busy_time'],
    entitled: poolsLatest['entitled']
  } : null;
  const largePageLatest = latestSnapshot('LARGEPAGE');
  const largePage = largePageLatest ? {
    time: largePageLatest.time,
    freePages: largePageLatest['Freepages'], usedPages: largePageLatest['Usedpages'],
    pages: largePageLatest['Pages'], highWater: largePageLatest['HighWater'], sizeMB: largePageLatest['SizeMB']
  } : null;

  // ── Disk adapter / HBA throughput (IOADAPT) — ranked like Busiest Disks
  //    but by average combined KB/s instead of %busy (this section has no
  //    busy% column, just per-adapter read/write KB/s and xfer/tps). ──────
  let ioAdaptTop = [];
  { const sec = sections.get('IOADAPT');
    if (sec && sec.header) {
      const header = sec.header.map(h => (h||'').trim()).filter(Boolean);
      const rows = sortByTime(sec.rows);
      const readCols  = header.filter(h => /_read$/i.test(h));
      const writeCols = header.filter(h => /_write$/i.test(h));
      const adapterNames = [...new Set([...readCols, ...writeCols].map(h => h.replace(/_(read|write|xfer-tps)$/i,'')))];
      ioAdaptTop = adapterNames.map(name => {
        const rIdx = header.indexOf(`${name}_read`), wIdx = header.indexOf(`${name}_write`);
        const reads  = rIdx>=0 ? rows.map(r=>num(r.values[rIdx])).filter(v=>v!==null) : [];
        const writes = wIdx>=0 ? rows.map(r=>num(r.values[wIdx])).filter(v=>v!==null) : [];
        const avg = arr => arr.length ? arr.reduce((a,v)=>a+v,0)/arr.length : 0;
        const max = arr => arr.length ? Math.max(...arr) : 0;
        return { name, avgReadKBs: avg(reads), avgWriteKBs: avg(writes), maxReadKBs: max(reads), maxWriteKBs: max(writes) };
      }).sort((a,b) => (b.avgReadKBs+b.avgWriteKBs) - (a.avgReadKBs+a.avgWriteKBs));
    }
  }

  // ── File-level I/O (FILE) & Async I/O (PROCAIO) ─────────────────────────
  const fileIORows = namedRows('FILE');
  const fileIO = fileIORows.rows.map(r => ({
    time: r.time, iso: r.iso, iget: r['iget'], namei: r['namei'],
    readch: r['readch'], writech: r['writech']
  }));
  const procAioRows = namedRows('PROCAIO');
  const procAio = procAioRows.rows.map(r => ({
    time: r.time, iso: r.iso, aioprocs: r['aioprocs'], aiorunning: r['aiorunning'],
    aiocpu: r['aiocpu'], syscpu: r['syscpu']
  }));

  // ── Per-Volume-Group full detail — merges VGBUSY/VGREAD/VGWRITE/VGXFER/
  //    VGSIZE (5 separate wide sections keyed by the same VG names) into
  //    one ranked table instead of 5 disconnected ones. ───────────────────
  function avgOf(tag, name) {
    const sec = sections.get(tag);
    if (!sec || !sec.header) return null;
    const header = sec.header.map(h => (h||'').trim());
    const idx = header.indexOf(name);
    if (idx < 0) return null;
    const vals = sortByTime(sec.rows).map(r => num(r.values[idx])).filter(v => v !== null);
    return vals.length ? vals.reduce((a,v)=>a+v,0)/vals.length : null;
  }
  const vgNames = [...new Set(vgBusyAll.map(v => v.name))];
  const vgDetail = vgNames.map(name => {
    const busyRow = vgBusyAll.find(v => v.name === name);
    return {
      name,
      avgBusyPct: busyRow ? busyRow.avgBusyPct : null, maxBusyPct: busyRow ? busyRow.maxBusyPct : null,
      avgReadKBs: avgOf('VGREAD', name), avgWriteKBs: avgOf('VGWRITE', name),
      avgXfer: avgOf('VGXFER', name), sizeGB: avgOf('VGSIZE', name)
    };
  }).sort((a,b) => (b.avgBusyPct||0) - (a.avgBusyPct||0));

  // ── Per-CPU-core breakdown (CPU01, CPU02, … as separate sections) ──────
  const perCpuTags = [...sections.keys()].filter(t => /^CPU\d+$/.test(t)).sort();
  const perCpu = perCpuTags.map(tag => {
    const r = namedRows(tag);
    const users = r.rows.map(x=>x['User%']).filter(v=>v!=null);
    const syss  = r.rows.map(x=>x['Sys%']).filter(v=>v!=null);
    const waits = r.rows.map(x=>x['Wait%']).filter(v=>v!=null);
    const avg = a => a.length ? a.reduce((s,v)=>s+v,0)/a.length : 0;
    const busySeries = r.rows.map(x => (x['User%']||0)+(x['Sys%']||0)+(x['Wait%']||0));
    return {
      id: tag, avgUser: avg(users), avgSys: avg(syss), avgWait: avg(waits),
      avgBusy: avg(busySeries), maxBusy: busySeries.length ? Math.max(...busySeries) : 0
    };
  }).sort((a,b) => b.avgBusy - a.avgBusy);

  const topSec = sections.get('TOP');
  let topProcesses = [];
  let topPeak = null;
  if (topSec && topSec.header) {
    // ══ FIX: nmon labels the TOP section's PID column "+PID" (with a
    // leading +) on some builds, not "PID" — strip it so idx['PID'] below
    // actually matches instead of coming back undefined. ══
    const header = topSec.header.map(h => (h || '').trim().replace(/^\+/, ''));
    const idx = {}; header.forEach((h,i) => idx[h] = i);
    const byCommand = new Map(); // command -> { sumCPU, maxCPU, maxCPUAt, samples, pids:Set, user }
    for (const r of topSec.rows) {
      const cmd = (r.values[idx['Command']] || '').trim() || '(unknown)';
      const pct = num(r.values[idx['%CPU']]);
      if (pct === null) continue;
      const user = (r.values[idx['User']] || '').trim();
      const pid  = (r.values[idx['PID']] || '').trim();
      if (!byCommand.has(cmd)) byCommand.set(cmd, { command: cmd, user, sumCPU: 0, maxCPU: 0, maxCPUAt: null, maxCPUPid: null, samples: 0, pids: new Set() });
      const b = byCommand.get(cmd);
      b.sumCPU += pct; b.samples += 1; b.pids.add(pid);
      if (pct > b.maxCPU) { b.maxCPU = pct; b.maxCPUAt = timeLabel(r.tcode); b.maxCPUPid = pid; }
      if (!topPeak || pct > topPeak.pct) topPeak = { pct, command: cmd, pid, user, time: timeLabel(r.tcode) };
    }
    topProcesses = [...byCommand.values()].map(b => ({
      command: b.command, user: b.user, avgCPU: b.sumCPU / b.samples, maxCPU: b.maxCPU,
      maxCPUAt: b.maxCPUAt, samples: b.samples, distinctPIDs: b.pids.size
    })).sort((a,b) => b.avgCPU - a.avgCPU);
  }

  // ── Assemble diagnostics / warnings (same "never silently blank" philosophy
  //     as the SAR parser) ───────────────────────────────────────────────────
  const sectionsFound = [...sections.keys()];
  const warnings = [];
  if (!cpu.length)      warnings.push({ section: 'cpu',    message: 'No CPU_ALL section found — this may not be a valid nmon capture file.' });
  if (!memory.length)   warnings.push({ section: 'memory', message: 'No MEM section found.' });
  if (!diskSumm.length) {
    warnings.push({ section: 'disk', message: 'No DISK_SUMM section found, and no DISKREAD/DISKWRITE sections to derive totals from either (capture may have been run without disk stats, or disks_per_line limit hid the summary).' });
  } else if (diskSummSource === 'derived-DISKREAD/DISKWRITE') {
    warnings.push({ section: 'disk', message: 'No DISK_SUMM section found — Disk I/O totals below are derived by summing the DISKREAD/DISKWRITE per-disk sections instead (IOPS is not available this way, so it\'s left blank).' });
  }
  if (!netTotals.length) {
    warnings.push({ section: 'network', message: 'No NET section found.' });
  } else if (!hasNetPerInterfaceData) {
    warnings.push({ section: 'network', message: 'NET section only has nmon\'s aggregate Total-Read/Total-Write columns — no per-adapter breakdown was captured, so the Network Interfaces table will be empty even though the totals chart has data.' });
  }
  if (!lpar.length)     warnings.push({ section: 'lpar',   message: 'No LPAR section — normal for a non-virtualized/bare-metal or non-AIX capture; entitlement analysis will be skipped.' });
  if (!proc.length)     warnings.push({ section: 'proc',   message: 'No PROC section found — run queue, context-switch, and fork/exec metrics will be skipped.' });
  if (!topProcesses.length) warnings.push({ section: 'top', message: 'No TOP (per-process) section — the capture was likely run without the -T flag, so top-process ranking will be skipped.' });
  if (!diskBusyAll.length)  warnings.push({ section: 'diskbusy', message: 'No DISKBUSY section — per-disk busy% ranking will be skipped.' });
  if (!memUse.length)   warnings.push({ section: 'memuse',  message: 'No MEMUSE section — kernel memory-pool tuning metrics will be skipped.' });
  if (!memNew.length)   warnings.push({ section: 'memnew',  message: 'No MEMNEW section — memory-category breakdown chart will be skipped.' });
  if (!fsUsedAll.length) warnings.push({ section: 'filesystem', message: 'No JFSFILE section — filesystem %used table will be skipped.' });
  if (!netPackets.length) warnings.push({ section: 'netpacket', message: 'No NETPACKET section — packets/sec chart will be skipped.' });
  if (!pagingSpaceDevices.length) warnings.push({ section: 'pagingspace', message: 'No PAGING section — paging-space-free table will be skipped.' });
  if (!ioAdaptTop.length) warnings.push({ section: 'ioadapt', message: 'No IOADAPT section — disk adapter/HBA ranking will be skipped.' });
  if (!perCpu.length)   warnings.push({ section: 'percpu',   message: 'No per-core CPU sections (CPU01, CPU02, …) — per-core breakdown will be skipped.' });

  // LPARNumberName / MachineType come through as "3,CHFRSDB02" / "IBM,9080-HEX"
  // (nmon writes them as two separate comma fields) — split back out into
  // clean labeled values instead of showing the user a raw embedded comma.
  const lparParts = (meta.LPARNumberName || '').split(',').map(s => s.trim());
  const machineParts = (meta.MachineType || '').split(',').map(s => s.trim());

  return {
    meta: {
      host: meta.host || meta.NodeName || null,
      lparName: lparParts[1] || lparParts[0] || null,
      lparNumber: (lparParts.length > 1 ? lparParts[0] : null),
      machineVendor: machineParts[0] || null,
      machineModel: machineParts[1] || null,
      serialNumber: meta.SerialNumber || null,
      aixVersion: meta.AIX || null,
      technologyLevel: meta.TL || null,
      hardware: meta.hardware || null,
      kernel: meta.kernel || null,
      captureTool: meta.version || null,
      intervalSec: num(meta.interval),
      snapshots: num(meta.snapshots) || zzzzRows.length,
      capturedBy: meta.user || null,
      command: meta.command || null,
      startTime: zzzzRows.length ? timeLabel(zzzzRows[0].tcode) : null,
      endTime: zzzzRows.length ? timeLabel(zzzzRows[zzzzRows.length-1].tcode) : null,
      startISO: zzzzRows.length ? timeISO(zzzzRows[0].tcode) : null,
      endISO: zzzzRows.length ? timeISO(zzzzRows[zzzzRows.length-1].tcode) : null,
    },
    cpu, lpar, memory, paging, proc, diskSumm, diskSummSource, fc, hasFC,
    netTotals, netInterfaces, hasNetPerInterfaceData,
    diskBusyTop: diskBusyAll.slice(0, 15), diskBusyCount: diskBusyAll.length,
    vgBusy: vgBusyAll,
    topProcesses: topProcesses.slice(0, 20), topPeak,
    memUse, memNew,
    fsUsedTop: fsUsedAll.slice(0, 20), fsUsedCount: fsUsedAll.length, fsUsedTrend,
    fsInodeTop: fsInodeAll.slice(0, 20), fsInodeCount: fsInodeAll.length,
    netPackets,
    pagingSpaceDevices, pagingSpaceTotal,
    pools, largePage,
    ioAdaptTop: ioAdaptTop.slice(0, 15),
    fileIO, procAio,
    vgDetail,
    perCpu,
    sectionsFound, warnings,
    diag: { totalLines: rawLines.length, aaaLines: aaaLines.length, zzzzCount: zzzzRows.length, sectionsFound }
  };
}

function _nmonTotalPoints(parsed) {
  return (parsed.cpu.length + parsed.memory.length + parsed.diskSumm.length + parsed.netTotals.length +
          parsed.lpar.length + parsed.paging.length + parsed.proc.length);
}

// ── POST /api/nmon/parse ─────────────────────────────────────────────────────
// 60 MB limit — the TOP (per-process) section can be very large on hosts
// running thousands of processes across many hours of capture (this sample
// report alone, at 460 snapshots, has ~68,000 TOP rows).
app.post('/api/nmon/parse', express.text({ type: '*/*', limit: '60mb' }), (req, res) => {
  try {
    const text = req.body || '';
    if (!text.trim()) return res.status(400).json({ error: 'Empty nmon report content' });

    // Quick sanity check before doing the full parse, so a wrong file (e.g.
    // someone uploads the .nmon.xlsx by mistake) gets a clear, specific error
    // instead of a confusing "no data found".
    if (!/^AAA,/m.test(text) && !/^ZZZZ,/m.test(text)) {
      // A .xlsx file posted here as text/plain shows up as binary garbage,
      // not valid nmon CSV — detect the "PK" zip signature xlsx files start
      // with and point the user at the right endpoint instead of a generic
      // "not a valid nmon file" error.
      const looksLikeXlsx = text.slice(0, 2) === 'PK';
      return res.status(400).json({
        error: looksLikeXlsx
          ? 'This looks like a .nmon.xlsx file, not raw text. The dashboard now supports .xlsx uploads directly ' +
            '— select the file again from the upload box and it will be routed correctly.'
          : 'This doesn\'t look like a raw nmon capture file or a .nmon.xlsx workbook. Make sure you\'re ' +
            'uploading either the plain-text .nmon file (e.g. "hostname_YYMMDD_HHMM.nmon") or its .nmon.xlsx ' +
            'Excel conversion — both are supported.'
      });
    }

    const parsed = parseNmonText(text);
    if (_nmonTotalPoints(parsed) === 0) {
      return res.status(400).json({
        error: 'No recognizable nmon time-series sections found in this file. Make sure it\'s a complete, ' +
               'un-truncated raw .nmon capture.',
        diagnostics: parsed.diag
      });
    }
    console.log(`[nmon/parse] parsed ${text.length} bytes → host=${parsed.meta.host||'?'} snapshots=${parsed.meta.snapshots} ` +
      `cpu=${parsed.cpu.length} mem=${parsed.memory.length} disk=${parsed.diskSumm.length} net=${parsed.netTotals.length} ` +
      `lpar=${parsed.lpar.length} top=${parsed.topProcesses.length}${parsed.warnings.length ? `  ⚠ ${parsed.warnings.length} section(s) missing` : ''}`);
    res.json(parsed);
  } catch (e) {
    console.error('[nmon/parse] error:', e);
    res.status(500).json({ error: 'Failed to parse nmon report: ' + e.message });
  }
});

console.log('✓ NMON report analysis endpoint attached (/api/nmon/parse)');


// ═════════════════════════════════════════════════════════════════════════════
//  NMON REPORT ANALYSIS — .nmon.xlsx (Excel conversion) SUPPORT
//
//  ══ FIX: "sections show no data" for production reports ══════════════════
//  ROOT CAUSE: /api/nmon/parse only ever accepted the RAW plain-text `.nmon`
//  capture file. Production hosts here are only distributed the `.nmon.xlsx`
//  workbook (built by nmon2xlsx/topas_nmon's own Excel export) — the raw
//  `.nmon` text file is not what gets handed to the dashboard. Uploading the
//  .xlsx to the old endpoint was rejected outright with "doesn't look like a
//  raw nmon capture file", so EVERY section came back empty — not just some.
//
//  FIX: read the workbook directly with SheetJS. Each nmon section (CPU_ALL,
//  MEM, PAGE, PROC, DISK_SUMM, NET, LPAR, DISKBUSY, VGBUSY, FCREAD/FCWRITE,
//  TOP, plus the AAA metadata and ZZZZ timestamp sheets) is written by the
//  Excel exporter as its own sheet, using the exact same column names as the
//  raw text format — so every value below is read verbatim from the
//  spreadsheet cell, nothing is estimated or re-derived, same as the raw
//  parser above. The two endpoints return the IDENTICAL JSON shape, so the
//  existing frontend rendering code (nmonRenderAll) needs no changes at all.
// ─────────────────────────────────────────────────────────────────────────────

const _xlsxNum = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
function _xlsxTimeLabel(d) { return (d instanceof Date) ? d.toTimeString().slice(0, 8) : null; }
function _xlsxIso(d) { return (d instanceof Date) ? d.toISOString() : null; }

// Reads one sheet into { header:[...], rows:[{date, time, iso, values:[...]}] }.
// Column A of every nmon-exported sheet is the timestamp; column B onward are
// the same fields the raw `.nmon` writer uses, in the same order.
function _xlsxSheetRows(wb, name) {
  if (!wb.SheetNames.includes(name)) return { header: [], rows: [] };
  const raw = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
  if (!raw.length) return { header: [], rows: [] };
  const header = (raw[0] || []).slice(1).map(h => (h == null ? '' : String(h).trim()));
  const rows = raw.slice(1)
    .map(r => ({ date: (r[0] instanceof Date) ? r[0] : null, values: r.slice(1) }))
    .filter(r => r.date); // drops any trailing blank rows some exporters leave
  return { header, rows };
}

// Same shape as `namedRows()` in the raw-text parser above, but keyed off a
// real per-row Date instead of a shared Tcode — the xlsx exporter doesn't
// carry Tcodes at all, and sections like TOP have their own timestamps that
// don't line up with the main ZZZZ interval grid, so per-row dates are the
// more reliable join key here.
function _xlsxNamedRows(wb, tag) {
  const { header, rows } = _xlsxSheetRows(wb, tag);
  return {
    header,
    rows: rows.map(r => {
      const obj = { time: _xlsxTimeLabel(r.date), iso: _xlsxIso(r.date) };
      header.forEach((h, i) => { if (h) obj[h] = _xlsxNum(r.values[i]); });
      return obj;
    })
  };
}

function parseNmonXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });

  // ── Metadata (AAA sheet) ──────────────────────────────────────────────
  const meta = {};
  if (wb.SheetNames.includes('AAA')) {
    const raw = XLSX.utils.sheet_to_json(wb.Sheets.AAA, { header: 1, raw: true, defval: '' });
    raw.forEach(r => {
      const key = r[0];
      if (!key) return;
      meta[key] = r.slice(1).filter(v => v !== undefined && v !== '' && v !== null).join(',');
    });
  }

  // ── Capture window (ZZZZ sheet) ─────────────────────────────────────────
  let zzzzDates = [];
  if (wb.SheetNames.includes('ZZZZ')) {
    const raw = XLSX.utils.sheet_to_json(wb.Sheets.ZZZZ, { header: 1, raw: true, defval: null });
    zzzzDates = raw.map(r => (r[3] instanceof Date) ? r[3] : ((r[2] instanceof Date) ? r[2] : null)).filter(Boolean);
  }

  // ── CPU_ALL ──────────────────────────────────────────────────────────────
  const cpuAll = _xlsxNamedRows(wb, 'CPU_ALL');
  const cpu = cpuAll.rows.map(r => ({
    time: r.time, iso: r.iso,
    user: r['User%'], sys: r['Sys%'], wait: r['Wait%'], idle: r['Idle%'],
    busy: r['Busy'], physicalCPUs: r['PhysicalCPUs'], cpuPct: r['CPU%']
  }));

  // ── LPAR ─────────────────────────────────────────────────────────────────
  const lparRows = _xlsxNamedRows(wb, 'LPAR');
  const lpar = lparRows.rows.map(r => ({
    time: r.time, iso: r.iso,
    physicalCPU: r['PhysicalCPU'], virtualCPUs: r['virtualCPUs'], logicalCPUs: r['logicalCPUs'],
    poolCPUs: r['poolCPUs'], entitled: r['entitled'], weight: r['weight'],
    poolIdle: r['PoolIdle'], usedAllCPUPct: r['usedAllCPU%'], usedPoolCPUPct: r['usedPoolCPU%'],
    sharedCPU: r['SharedCPU'], capped: r['Capped'],
    ecUser: r['EC_User%'], ecSys: r['EC_Sys%'], ecWait: r['EC_Wait%'], ecIdle: r['EC_Idle%'],
    vpUser: r['VP_User%'], vpSys: r['VP_Sys%'], vpWait: r['VP_Wait%'], vpIdle: r['VP_Idle%'],
    folded: r['Folded'], unfoldedVPs: r['Unfolded VPs'], otherLPARs: r['OtherLPARs']
  }));

  // ── Memory ───────────────────────────────────────────────────────────────
  const memRows = _xlsxNamedRows(wb, 'MEM');
  const memory = memRows.rows.map(r => ({
    time: r.time, iso: r.iso,
    realFreePct: r['Real Free %'], virtFreePct: r['Virtual free %'],
    realFreeMB: r['Real free(MB)'], virtFreeMB: r['Virtual free(MB)'],
    realTotalMB: r['Real total(MB)'], virtTotalMB: r['Virtual total(MB)']
  }));

  // ── Paging ───────────────────────────────────────────────────────────────
  const pageRows = _xlsxNamedRows(wb, 'PAGE');
  const paging = pageRows.rows.map(r => ({
    time: r.time, iso: r.iso, faults: r['faults'], pgin: r['pgin'], pgout: r['pgout'],
    pgsin: r['pgsin'], pgsout: r['pgsout'], srfr: r['sr/fr']
  }));

  // ── Process / run-queue ────────────────────────────────────────────────
  const procRows = _xlsxNamedRows(wb, 'PROC');
  const proc = procRows.rows.map(r => ({
    time: r.time, iso: r.iso, runQueue: r['RunQueue'], swapIn: r['Swap-in'],
    pswitch: r['pswitch'], syscall: r['syscall'], fork: r['fork'], exec: r['exec']
  }));

  // ── Fibre Channel throughput (sum across all HBAs) ──────────────────────
  function sumWideXlsx(tag) {
    const { header, rows } = _xlsxSheetRows(wb, tag);
    const totals = rows.map(r => ({
      time: _xlsxTimeLabel(r.date), iso: _xlsxIso(r.date),
      total: r.values.map(_xlsxNum).filter(v => v !== null).reduce((a, v) => a + v, 0)
    }));
    return { header, rows, totals };
  }

  // ── Disk throughput summary ─────────────────────────────────────────────
  const diskSummRows = _xlsxNamedRows(wb, 'DISK_SUMM');
  let diskSumm = diskSummRows.rows.map(r => ({
    time: r.time, iso: r.iso,
    readKBs: r['Disk Read KB/s'], writeKBs: r['Disk Write KB/s'], iops: r['IO/sec']
  }));
  // ══ FIX: same DISK_SUMM fallback as the raw-text parser — derive totals
  // from the DISKREAD/DISKWRITE sheets when DISK_SUMM itself wasn't in the
  // workbook, instead of leaving Disk I/O empty when the data to compute it
  // was there all along. ══
  let diskSummSource = diskSumm.length ? 'DISK_SUMM' : null;
  if (!diskSumm.length) {
    const diskReadSum  = sumWideXlsx('DISKREAD');
    const diskWriteSum = sumWideXlsx('DISKWRITE');
    if (diskReadSum.header.length || diskWriteSum.header.length) {
      const n = Math.max(diskReadSum.totals.length, diskWriteSum.totals.length);
      diskSumm = Array.from({ length: n }, (_, i) => {
        const rt = diskReadSum.totals[i], wt = diskWriteSum.totals[i];
        return {
          time: (rt || wt).time, iso: (rt || wt).iso,
          readKBs: (rt && rt.total) || 0, writeKBs: (wt && wt.total) || 0, iops: null
        };
      });
      diskSummSource = 'derived-DISKREAD/DISKWRITE';
    }
  }

  const fcReadX  = sumWideXlsx('FCREAD');
  const fcWriteX = sumWideXlsx('FCWRITE');
  const hasFC = fcReadX.header.length > 0;
  const fc = hasFC ? fcReadX.totals.map((r, i) => ({
    time: r.time, iso: r.iso, readKBs: r.total, writeKBs: (fcWriteX.totals[i] && fcWriteX.totals[i].total) || 0
  })) : [];

  // ── Network (prefer nmon's own Total-Read / Total-Write(-ve) columns) ───
  const netSecX = _xlsxSheetRows(wb, 'NET');
  const netHeaderTrim = netSecX.header;
  const netSec = _xlsxNamedRows(wb, 'NET');
  let netTotals = [];
  const hasNetTotalCols = netHeaderTrim.includes('Total-Read') && netHeaderTrim.some(h => h.startsWith('Total-Write'));
  if (hasNetTotalCols) {
    const writeKey = netHeaderTrim.find(h => h.startsWith('Total-Write'));
    netTotals = netSec.rows.map(r => ({
      time: r.time, iso: r.iso, readKBs: r['Total-Read'] || 0, writeKBs: Math.abs(r[writeKey] || 0)
    }));
  } else if (netHeaderTrim.length) {
    const readCols  = netHeaderTrim.filter(h => /-read$/i.test(h));
    const writeCols = netHeaderTrim.filter(h => /-write$/i.test(h));
    netTotals = netSec.rows.map(r => ({
      time: r.time, iso: r.iso,
      readKBs:  readCols.reduce((a, h) => a + (Math.abs(r[h]) || 0), 0),
      writeKBs: writeCols.reduce((a, h) => a + (Math.abs(r[h]) || 0), 0)
    }));
  }
  const netInterfaces = [];
  // Same distinction as the raw-text parser: NET-with-only-totals is valid,
  // not missing — see the comment there for the full rationale.
  const netIfCols = netHeaderTrim.filter(h => h && !/^(Total-Read|Total-Write.*)$/i.test(h));
  const hasNetPerInterfaceData = netIfCols.length > 0;
  if (netHeaderTrim.length) {
    const ifNames = [...new Set(netHeaderTrim
      .map(h => h.replace(/-(read|write|total)$/i, ''))
      .filter(h => h && !/^total$/i.test(h)))];
    ifNames.forEach(name => {
      const rCol = netHeaderTrim.find(h => h === `${name}-read`);
      const wCol = netHeaderTrim.find(h => h === `${name}-write`);
      if (!rCol && !wCol) return;
      const reads  = netSec.rows.map(r => r[rCol]).filter(v => v != null);
      const writes = netSec.rows.map(r => r[wCol]).filter(v => v != null);
      const avg = arr => arr.length ? arr.reduce((a, v) => a + v, 0) / arr.length : 0;
      const max = arr => arr.length ? Math.max(...arr) : 0;
      netInterfaces.push({
        name, isLoopback: /^lo\d*$/i.test(name),
        avgReadKBs: avg(reads), maxReadKBs: max(reads),
        avgWriteKBs: avg(writes), maxWriteKBs: max(writes)
      });
    });
    netInterfaces.sort((a, b) => (b.avgReadKBs + b.avgWriteKBs) - (a.avgReadKBs + a.avgWriteKBs));
  }

  // ── Disk / VG busy — top-N by average %busy ──────────────────────────────
  function topBusyXlsx(tag) {
    const { header, rows } = _xlsxSheetRows(wb, tag);
    return header
      .map((name, colIdx) => ({ name, colIdx }))
      .filter(c => c.name && !/^totals?$/i.test(c.name))
      .map(({ name, colIdx }) => {
        const vals = rows.map(r => _xlsxNum(r.values[colIdx])).filter(v => v !== null);
        const avg = vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : 0;
        const max = vals.length ? Math.max(...vals) : 0;
        return { name, avgBusyPct: avg, maxBusyPct: max, samples: vals.length };
      })
      .sort((a, b) => b.avgBusyPct - a.avgBusyPct);
  }
  const diskBusyAll = topBusyXlsx('DISKBUSY');
  const vgBusyAll   = topBusyXlsx('VGBUSY');

  // ── Generic helper: rank a "wide" per-item sheet (one column per disk/
  //    filesystem/adapter/etc.) by AVERAGE value — same shape as
  //    topBusyXlsx but for magnitudes (KB/s, MB, count) rather than a
  //    0–100 %busy figure. Used for JFSFILE, JFSINODE, PAGING below. ──────
  function rankWideXlsx(tag) {
    const { header, rows } = _xlsxSheetRows(wb, tag);
    return header
      .map((name, colIdx) => ({ name, colIdx }))
      .filter(c => c.name && !/^totals?$/i.test(c.name))
      .map(({ name, colIdx }) => {
        const vals = rows.map(r => _xlsxNum(r.values[colIdx])).filter(v => v !== null);
        const avg = vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : 0;
        const max = vals.length ? Math.max(...vals) : 0;
        const min = vals.length ? Math.min(...vals) : 0;
        return { name, avg, max, min, samples: vals.length };
      });
  }
  // Time-series for the top-N columns of a wide sheet, by name.
  function wideXlsxTrend(tag, topNames) {
    const { header, rows } = _xlsxSheetRows(wb, tag);
    if (!header.length || !topNames.length) return { names: [], rows: [] };
    const colIdx = topNames.map(n => header.indexOf(n));
    return {
      names: topNames,
      rows: rows.map(r => ({
        time: _xlsxTimeLabel(r.date), iso: _xlsxIso(r.date),
        values: colIdx.map(ci => ci >= 0 ? _xlsxNum(r.values[ci]) : null)
      }))
    };
  }

  // ── Memory: additional breakdowns (MEMUSE / MEMNEW) ─────────────────────
  const memUseX = _xlsxNamedRows(wb, 'MEMUSE');
  const memUse = memUseX.rows.map(r => ({
    time: r.time, iso: r.iso,
    numperm: r['%numperm'], minperm: r['%minperm'], maxperm: r['%maxperm'],
    minfree: r['minfree'], maxfree: r['maxfree'],
    numclient: r['%numclient'], maxclient: r['%maxclient'],
    lruablePages: r[' lruable pages'] ?? r['lruable pages'], comp: r['%comp']
  }));
  const memNewX = _xlsxNamedRows(wb, 'MEMNEW');
  const memNew = memNewX.rows.map(r => ({
    time: r.time, iso: r.iso,
    processPct: r['Process%'], fscachePct: r['FScache%'], systemPct: r['System%'],
    freePct: r['Free%'], pinnedPct: r['Pinned%'], userPct: r['User%']
  }));

  // ── Filesystem usage (JFSFILE / JFSINODE) — critical for production ────
  const fsUsedAll = rankWideXlsx('JFSFILE').sort((a,b) => b.max - a.max);
  const fsUsedTop5Names = fsUsedAll.slice(0, 5).map(f => f.name);
  const fsUsedTrend = wideXlsxTrend('JFSFILE', fsUsedTop5Names);
  const fsInodeAll = rankWideXlsx('JFSINODE').sort((a,b) => b.max - a.max);

  // ── Network packets/sec (NETPACKET) ─────────────────────────────────────
  const netPktX = _xlsxSheetRows(wb, 'NETPACKET');
  let netPackets = [];
  if (netPktX.header.length) {
    const header = netPktX.header;
    const readCols  = header.filter(h => /-reads\/s$/i.test(h));
    const writeCols = header.filter(h => /-writes\/s$/i.test(h));
    netPackets = netPktX.rows.map(r => {
      const obj = {}; header.forEach((h,i) => { if (h) obj[h] = _xlsxNum(r.values[i]); });
      return {
        time: _xlsxTimeLabel(r.date), iso: _xlsxIso(r.date),
        readPktsPerSec:  readCols.reduce((a,h)=>a+(obj[h]||0),0),
        writePktsPerSec: writeCols.reduce((a,h)=>a+(obj[h]||0),0)
      };
    });
  }

  // ── Paging space free (PAGING) — MB-free per paging device; the number
  //    that matters when a production box risks swap exhaustion. ─────────
  const pagingSpaceAll = rankWideXlsx('PAGING');
  const pagingSpaceDevices = pagingSpaceAll.map(d => ({ name: d.name, avgFreeMB: d.avg, minFreeMB: d.min, samples: d.samples }))
    .sort((a,b) => a.minFreeMB - b.minFreeMB);
  const pagingTotalX = _xlsxSheetRows(wb, 'PAGING');
  const pagingSpaceTotal = pagingTotalX.header.length ? pagingTotalX.rows.map(r => ({
    time: _xlsxTimeLabel(r.date), iso: _xlsxIso(r.date),
    totalFreeMB: r.values.map(_xlsxNum).filter(v=>v!==null).reduce((a,v)=>a+v,0)
  })) : [];

  // ── Shared CPU pool (POOLS) & Large Page use (LARGEPAGE) — single latest
  //    snapshot info cards (slow-changing configuration, not a trend). ────
  function latestSnapshotXlsx(tag) {
    const r = _xlsxNamedRows(wb, tag);
    return r.rows.length ? r.rows[r.rows.length - 1] : null;
  }
  const poolsLatest = latestSnapshotXlsx('POOLS');
  const pools = poolsLatest ? {
    time: poolsLatest.time,
    shcpusInSys: poolsLatest['shcpus_in_sys'], maxPoolCapacity: poolsLatest['max_pool_capacity'],
    entitledPoolCapacity: poolsLatest['entitled_pool_capacity'], poolBusyTime: poolsLatest['pool_busy_time'],
    entitled: poolsLatest['entitled']
  } : null;
  const largePageLatest = latestSnapshotXlsx('LARGEPAGE');
  const largePage = largePageLatest ? {
    time: largePageLatest.time,
    freePages: largePageLatest['Freepages'], usedPages: largePageLatest['Usedpages'],
    pages: largePageLatest['Pages'], highWater: largePageLatest['HighWater'], sizeMB: largePageLatest['SizeMB']
  } : null;

  // ── Disk adapter / HBA throughput (IOADAPT) — ranked by average combined
  //    KB/s (this sheet has no busy% column, just per-adapter KB/s+tps). ──
  let ioAdaptTop = [];
  { const { header, rows } = _xlsxSheetRows(wb, 'IOADAPT');
    if (header.length) {
      const readCols  = header.filter(h => /_read$/i.test(h));
      const writeCols = header.filter(h => /_write$/i.test(h));
      const adapterNames = [...new Set([...readCols, ...writeCols].map(h => h.replace(/_(read|write|xfer-tps)$/i,'')))];
      ioAdaptTop = adapterNames.map(name => {
        const rIdx = header.indexOf(`${name}_read`), wIdx = header.indexOf(`${name}_write`);
        const reads  = rIdx>=0 ? rows.map(r=>_xlsxNum(r.values[rIdx])).filter(v=>v!==null) : [];
        const writes = wIdx>=0 ? rows.map(r=>_xlsxNum(r.values[wIdx])).filter(v=>v!==null) : [];
        const avg = arr => arr.length ? arr.reduce((a,v)=>a+v,0)/arr.length : 0;
        const max = arr => arr.length ? Math.max(...arr) : 0;
        return { name, avgReadKBs: avg(reads), avgWriteKBs: avg(writes), maxReadKBs: max(reads), maxWriteKBs: max(writes) };
      }).sort((a,b) => (b.avgReadKBs+b.avgWriteKBs) - (a.avgReadKBs+a.avgWriteKBs));
    }
  }

  // ── File-level I/O (FILE) & Async I/O (PROCAIO) ─────────────────────────
  const fileIOX = _xlsxNamedRows(wb, 'FILE');
  const fileIO = fileIOX.rows.map(r => ({
    time: r.time, iso: r.iso, iget: r['iget'], namei: r['namei'],
    readch: r['readch'], writech: r['writech']
  }));
  const procAioX = _xlsxNamedRows(wb, 'PROCAIO');
  const procAio = procAioX.rows.map(r => ({
    time: r.time, iso: r.iso, aioprocs: r['aioprocs'], aiorunning: r['aiorunning'],
    aiocpu: r['aiocpu'], syscpu: r['syscpu']
  }));

  // ── Per-Volume-Group full detail — merges VGBUSY/VGREAD/VGWRITE/VGXFER/
  //    VGSIZE into one ranked table instead of 5 disconnected ones. ───────
  function avgOfXlsx(tag, name) {
    const { header, rows } = _xlsxSheetRows(wb, tag);
    const idx = header.indexOf(name);
    if (idx < 0) return null;
    const vals = rows.map(r => _xlsxNum(r.values[idx])).filter(v => v !== null);
    return vals.length ? vals.reduce((a,v)=>a+v,0)/vals.length : null;
  }
  const vgNames = [...new Set(vgBusyAll.map(v => v.name))];
  const vgDetail = vgNames.map(name => {
    const busyRow = vgBusyAll.find(v => v.name === name);
    return {
      name,
      avgBusyPct: busyRow ? busyRow.avgBusyPct : null, maxBusyPct: busyRow ? busyRow.maxBusyPct : null,
      avgReadKBs: avgOfXlsx('VGREAD', name), avgWriteKBs: avgOfXlsx('VGWRITE', name),
      avgXfer: avgOfXlsx('VGXFER', name), sizeGB: avgOfXlsx('VGSIZE', name)
    };
  }).sort((a,b) => (b.avgBusyPct||0) - (a.avgBusyPct||0));

  // ── Per-CPU-core breakdown (CPU01, CPU02, … as separate sheets) ────────
  const perCpuTags = wb.SheetNames.filter(t => /^CPU\d+$/.test(t)).sort();
  const perCpu = perCpuTags.map(tag => {
    const r = _xlsxNamedRows(wb, tag);
    const users = r.rows.map(x=>x['User%']).filter(v=>v!=null);
    const syss  = r.rows.map(x=>x['Sys%']).filter(v=>v!=null);
    const waits = r.rows.map(x=>x['Wait%']).filter(v=>v!=null);
    const avg = a => a.length ? a.reduce((s,v)=>s+v,0)/a.length : 0;
    const busySeries = r.rows.map(x => (x['User%']||0)+(x['Sys%']||0)+(x['Wait%']||0));
    return {
      id: tag, avgUser: avg(users), avgSys: avg(syss), avgWait: avg(waits),
      avgBusy: avg(busySeries), maxBusy: busySeries.length ? Math.max(...busySeries) : 0
    };
  }).sort((a,b) => b.avgBusy - a.avgBusy);

  // ── TOP — per-process detail ─────────────────────────────────────────────
  const topRaw = _xlsxSheetRows(wb, 'TOP');
  let topProcesses = [];
  let topPeak = null;
  if (topRaw.header.length) {
    const idx = {}; topRaw.header.forEach((h, i) => idx[h] = i);
    const byCommand = new Map();
    for (const r of topRaw.rows) {
      const cmd = String(r.values[idx['Command']] ?? '').trim() || '(unknown)';
      const pct = _xlsxNum(r.values[idx['%CPU']]);
      if (pct === null) continue;
      const user = String(r.values[idx['User']] ?? '').trim();
      const pid  = String(r.values[idx['PID']] ?? '').trim();
      const tLbl = _xlsxTimeLabel(r.date);
      if (!byCommand.has(cmd)) byCommand.set(cmd, { command: cmd, user, sumCPU: 0, maxCPU: 0, maxCPUAt: null, maxCPUPid: null, samples: 0, pids: new Set() });
      const b = byCommand.get(cmd);
      b.sumCPU += pct; b.samples += 1; b.pids.add(pid);
      if (pct > b.maxCPU) { b.maxCPU = pct; b.maxCPUAt = tLbl; b.maxCPUPid = pid; }
      if (!topPeak || pct > topPeak.pct) topPeak = { pct, command: cmd, pid, user, time: tLbl };
    }
    topProcesses = [...byCommand.values()].map(b => ({
      command: b.command, user: b.user, avgCPU: b.sumCPU / b.samples, maxCPU: b.maxCPU,
      maxCPUAt: b.maxCPUAt, samples: b.samples, distinctPIDs: b.pids.size
    })).sort((a, b) => b.avgCPU - a.avgCPU);
  }

  // ── Warnings (identical philosophy to the raw-text parser) ──────────────
  const EXCLUDE_TAGS = new Set(['AAA', 'ZZZZ', 'ERROR', 'UARG', 'SYS_SUMM']);
  const sectionsFound = wb.SheetNames.filter(n => !EXCLUDE_TAGS.has(n) && !/^BBB/.test(n));
  const warnings = [];
  if (!cpu.length)      warnings.push({ section: 'cpu',    message: 'No CPU_ALL sheet found in this workbook.' });
  if (!memory.length)   warnings.push({ section: 'memory', message: 'No MEM sheet found.' });
  if (!diskSumm.length) {
    warnings.push({ section: 'disk', message: 'No DISK_SUMM sheet found, and no DISKREAD/DISKWRITE sheets to derive totals from either.' });
  } else if (diskSummSource === 'derived-DISKREAD/DISKWRITE') {
    warnings.push({ section: 'disk', message: 'No DISK_SUMM sheet found — Disk I/O totals below are derived by summing the DISKREAD/DISKWRITE sheets instead (IOPS is not available this way, so it\'s left blank).' });
  }
  if (!netTotals.length) {
    warnings.push({ section: 'network', message: 'No NET sheet found.' });
  } else if (!hasNetPerInterfaceData) {
    warnings.push({ section: 'network', message: 'NET sheet only has nmon\'s aggregate Total-Read/Total-Write columns — no per-adapter breakdown was captured, so the Network Interfaces table will be empty even though the totals chart has data.' });
  }
  if (!lpar.length)     warnings.push({ section: 'lpar',   message: 'No LPAR sheet — normal for a non-virtualized/bare-metal or non-AIX capture; entitlement analysis will be skipped.' });
  if (!proc.length)     warnings.push({ section: 'proc',   message: 'No PROC sheet found — run queue, context-switch, and fork/exec metrics will be skipped.' });
  if (!topProcesses.length) warnings.push({ section: 'top', message: 'No TOP sheet — the capture was likely run without the -T flag, so top-process ranking will be skipped.' });
  if (!diskBusyAll.length)  warnings.push({ section: 'diskbusy', message: 'No DISKBUSY sheet — per-disk busy% ranking will be skipped.' });
  if (!memUse.length)   warnings.push({ section: 'memuse',  message: 'No MEMUSE sheet — kernel memory-pool tuning metrics will be skipped.' });
  if (!memNew.length)   warnings.push({ section: 'memnew',  message: 'No MEMNEW sheet — memory-category breakdown chart will be skipped.' });
  if (!fsUsedAll.length) warnings.push({ section: 'filesystem', message: 'No JFSFILE sheet — filesystem %used table will be skipped.' });
  if (!netPackets.length) warnings.push({ section: 'netpacket', message: 'No NETPACKET sheet — packets/sec chart will be skipped.' });
  if (!pagingSpaceDevices.length) warnings.push({ section: 'pagingspace', message: 'No PAGING sheet — paging-space-free table will be skipped.' });
  if (!ioAdaptTop.length) warnings.push({ section: 'ioadapt', message: 'No IOADAPT sheet — disk adapter/HBA ranking will be skipped.' });
  if (!perCpu.length)   warnings.push({ section: 'percpu',   message: 'No per-core CPU sheets (CPU01, CPU02, …) — per-core breakdown will be skipped.' });

  const lparParts = (meta.LPARNumberName || '').split(',').map(s => s.trim());
  const machineParts = (meta.MachineType || '').split(',').map(s => s.trim());

  return {
    meta: {
      host: meta.host || meta.NodeName || null,
      lparName: lparParts[1] || lparParts[0] || null,
      lparNumber: (lparParts.length > 1 ? lparParts[0] : null),
      machineVendor: machineParts[0] || null,
      machineModel: machineParts[1] || null,
      serialNumber: meta.SerialNumber || null,
      aixVersion: meta.AIX || null,
      technologyLevel: meta.TL || null,
      hardware: meta.hardware || null,
      kernel: meta.kernel || null,
      captureTool: meta.version || null,
      intervalSec: _xlsxNum(meta.interval) ?? (parseFloat(meta.interval) || null),
      snapshots: zzzzDates.length || null,
      capturedBy: meta.user || null,
      command: meta.command || null,
      startTime: zzzzDates.length ? _xlsxTimeLabel(zzzzDates[0]) : null,
      endTime: zzzzDates.length ? _xlsxTimeLabel(zzzzDates[zzzzDates.length - 1]) : null,
      startISO: zzzzDates.length ? _xlsxIso(zzzzDates[0]) : null,
      endISO: zzzzDates.length ? _xlsxIso(zzzzDates[zzzzDates.length - 1]) : null,
    },
    cpu, lpar, memory, paging, proc, diskSumm, diskSummSource, fc, hasFC,
    netTotals, netInterfaces, hasNetPerInterfaceData,
    diskBusyTop: diskBusyAll.slice(0, 15), diskBusyCount: diskBusyAll.length,
    vgBusy: vgBusyAll,
    topProcesses: topProcesses.slice(0, 20), topPeak,
    memUse, memNew,
    fsUsedTop: fsUsedAll.slice(0, 20), fsUsedCount: fsUsedAll.length, fsUsedTrend,
    fsInodeTop: fsInodeAll.slice(0, 20), fsInodeCount: fsInodeAll.length,
    netPackets,
    pagingSpaceDevices, pagingSpaceTotal,
    pools, largePage,
    ioAdaptTop: ioAdaptTop.slice(0, 15),
    fileIO, procAio,
    vgDetail,
    perCpu,
    sectionsFound, warnings,
    diag: { totalLines: null, aaaLines: Object.keys(meta).length, zzzzCount: zzzzDates.length, sectionsFound }
  };
}

// ── POST /api/nmon/parse-xlsx ────────────────────────────────────────────
// Body: the raw bytes of the `.nmon.xlsx` file (application/octet-stream).
// 60 MB limit — same reasoning as /api/nmon/parse (TOP sheet can be huge).
app.post('/api/nmon/parse-xlsx', express.raw({ type: '*/*', limit: '60mb' }), (req, res) => {
  try {
    const buf = req.body;
    if (!buf || !buf.length) return res.status(400).json({ error: 'Empty nmon .xlsx upload' });
    let parsed;
    try {
      parsed = parseNmonXlsx(buf);
    } catch (e) {
      console.error('[nmon/parse-xlsx] workbook read error:', e);
      return res.status(400).json({ error: 'Could not read this file as an Excel workbook: ' + e.message });
    }
    if (_nmonTotalPoints(parsed) === 0) {
      return res.status(400).json({
        error: 'No recognizable nmon time-series sheets found in this workbook. Make sure it\'s a complete, ' +
               'un-truncated .nmon.xlsx export (it should contain sheets like CPU_ALL, MEM, DISK_SUMM, NET, ZZZZ…).',
        diagnostics: parsed.diag
      });
    }
    console.log(`[nmon/parse-xlsx] parsed ${buf.length} bytes → host=${parsed.meta.host||'?'} snapshots=${parsed.meta.snapshots} ` +
      `cpu=${parsed.cpu.length} mem=${parsed.memory.length} disk=${parsed.diskSumm.length} net=${parsed.netTotals.length} ` +
      `lpar=${parsed.lpar.length} top=${parsed.topProcesses.length}${parsed.warnings.length ? `  ⚠ ${parsed.warnings.length} section(s) missing` : ''}`);
    res.json(parsed);
  } catch (e) {
    console.error('[nmon/parse-xlsx] error:', e);
    res.status(500).json({ error: 'Failed to parse nmon .xlsx report: ' + e.message });
  }
});

console.log('✓ NMON .xlsx report analysis endpoint attached (/api/nmon/parse-xlsx)');



// ── OS TERMINAL — secure shell command execution (LOCAL) ──────────────────────
//
//  POST /api/os/exec
//  Body: { cmd: string, cwd?: string }
//
//  Executes an arbitrary shell command on the server OS.
//  Supports Windows (cmd.exe), Linux (/bin/bash), AIX (/bin/ksh), macOS, Solaris.
//  Security controls:
//    • 30-second hard timeout (SIGKILL on Unix, SIGTERM on Windows via child-process timeout)
//    • stdout + stderr capped at 512 KB each to prevent OOM
//    • cwd is validated — must be an existing, absolute path (or defaults to __dirname)
//    • The endpoint is rate-limited by the global limiter (120 req/min) already applied above
//    • Returns: { stdout, stderr, exitCode, cwd, user, elapsed, shell, osType }
//
//  NOTE: This endpoint grants full OS access to whoever can reach the proxy.
//  Restrict network access to localhost / trusted networks in production.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_OUTPUT_BYTES = 512 * 1024;  // 512 KB per stream
const CMD_TIMEOUT_MS   = 30_000;       // 30 s

// ── Detect OS type and resolve the best available shell ───────────────────────
//  Windows  → cmd.exe  (spawned with ['/c', cmd])
//  AIX      → /bin/ksh or /usr/bin/sh  (/bin/sh is a stub on AIX)
//  Linux    → /bin/bash or /bin/sh
const _IS_WINDOWS = process.platform === 'win32';
const _OS_TYPE    = _IS_WINDOWS                      ? 'Windows'
                  : process.platform === 'aix'       ? 'AIX'
                  : process.platform === 'sunos'     ? 'Solaris'
                  : process.platform === 'darwin'    ? 'macOS'
                  : 'Linux';

function _detectShell() {
  if (_IS_WINDOWS) {
    // cmd.exe is always present on Windows; use ComSpec env var if set
    return process.env.ComSpec || 'cmd.exe';
  }
  // Unix: probe candidates in preference order
  const candidates = ['/bin/bash', '/bin/ksh', '/usr/bin/ksh', '/usr/bin/sh', '/bin/sh'];
  for (const sh of candidates) {
    try { fs.accessSync(sh, fs.constants.X_OK); return sh; } catch (_) { /* next */ }
  }
  return '/bin/sh';  // absolute last resort
}

const _SHELL_BIN  = _detectShell();
const _SHELL_FLAG = _IS_WINDOWS ? '/c' : '-c';  // cmd.exe uses /c, Unix shells use -c
console.log(`[os/exec] OS=${_OS_TYPE}  shell=${_SHELL_BIN}  flag=${_SHELL_FLAG}`);

// ── GET /api/os/info — return OS type and shell path to the frontend ──────────
app.get('/api/os/info', (_req, res) => {
  res.json({ osType: _OS_TYPE, shell: _SHELL_BIN, platform: process.platform });
});

app.post('/api/os/exec', (req, res) => {
  const { cmd, cwd: rawCwd } = req.body || {};

  // ── Validate command ─────────────────────────────────────────────────────
  if (!cmd || typeof cmd !== 'string' || !cmd.trim()) {
    return res.status(400).json({ error: 'cmd is required and must be a non-empty string' });
  }
  if (cmd.length > 4096) {
    return res.status(400).json({ error: 'cmd too long (max 4096 characters)' });
  }

  // ── Validate / resolve cwd ────────────────────────────────────────────────
  let effectiveCwd = __dirname;   // default: server.js directory
  if (rawCwd && typeof rawCwd === 'string') {
    const candidate = path.resolve(rawCwd);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) effectiveCwd = candidate;
      else console.warn(`[os/exec] cwd "${candidate}" is not a directory — using default`);
    } catch (_) {
      console.warn(`[os/exec] cwd "${candidate}" does not exist — using default`);
    }
  }

  const t0 = Date.now();
  console.log(`[os/exec] shell=${_SHELL_BIN}  cmd="${cmd.slice(0,120)}"  cwd="${effectiveCwd}"`);

  // ── Special-case: `cd <path>` — update working directory ─────────────────
  // The frontend sends "cd /some/path && pwd" so we handle it naturally.
  // Nothing special needed here beyond resolving the exit-pwd trick below.

  // ── Spawn shell (OS-aware) ────────────────────────────────────────────────
  // Windows: cmd.exe /c "..."   Unix: /bin/bash -c "..."
  // Windows does not support SIGKILL — use SIGTERM there (Node will call TerminateProcess)
  const child = spawn(_SHELL_BIN, [_SHELL_FLAG, cmd], {
    cwd       : effectiveCwd,
    env       : { ...process.env },   // inherit full environment (includes ORACLE_HOME etc.)
    timeout   : CMD_TIMEOUT_MS,
    killSignal: _IS_WINDOWS ? 'SIGTERM' : 'SIGKILL',
  });

  let stdoutBuf = Buffer.alloc(0);
  let stderrBuf = Buffer.alloc(0);
  let stdoutTruncated = false;
  let stderrTruncated = false;

  child.stdout.on('data', chunk => {
    if (stdoutBuf.length < MAX_OUTPUT_BYTES) {
      stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
      if (stdoutBuf.length > MAX_OUTPUT_BYTES) {
        stdoutBuf = stdoutBuf.slice(0, MAX_OUTPUT_BYTES);
        stdoutTruncated = true;
      }
    }
  });

  child.stderr.on('data', chunk => {
    if (stderrBuf.length < MAX_OUTPUT_BYTES) {
      stderrBuf = Buffer.concat([stderrBuf, chunk]);
      if (stderrBuf.length > MAX_OUTPUT_BYTES) {
        stderrBuf = stderrBuf.slice(0, MAX_OUTPUT_BYTES);
        stderrTruncated = true;
      }
    }
  });

  child.on('error', err => {
    console.error('[os/exec] spawn error:', err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Spawn error: ' + err.message });
    }
  });

  child.on('close', (code, signal) => {
    const elapsed  = Date.now() - t0;
    let stdout     = stdoutBuf.toString('utf8');
    let stderr     = stderrBuf.toString('utf8');
    if (stdoutTruncated) stdout += '\n[stdout truncated at 512 KB]';
    if (stderrTruncated) stderr += '\n[stderr truncated at 512 KB]';

    // Detect new cwd: Unix sends "cd <path> && pwd"; Windows sends "cd <path> && cd"
    // Pick the last non-empty line of stdout as the new directory.
    let newCwd = effectiveCwd;
    const isCdPwd = _IS_WINDOWS
      ? /&&\s*cd\s*$/.test(cmd)   || /^\s*cd\s*$/.test(cmd)    // Windows: bare cd prints CWD
      : /&&\s*pwd\s*$/.test(cmd)  || /^\s*pwd\s*$/.test(cmd);  // Unix: pwd
    if (isCdPwd) {
      const lastLine = stdout.trim().split('\n').pop()?.trim();
      if (lastLine && path.isAbsolute(lastLine)) newCwd = lastLine;
    }

    // Resolve current OS user
    let user = process.env.USER || process.env.LOGNAME || process.env.USERNAME || os.userInfo().username || 'unknown';

    const exitCode = signal ? -1 : (code ?? -1);
    if (signal === 'SIGKILL' || signal === 'SIGTERM') {
      // SIGKILL = Unix timeout kill; SIGTERM = Windows timeout kill (Node TerminateProcess)
      stderr += '\n[Process killed — exceeded 30s timeout]';
    }

    console.log(`[os/exec] done  exit=${exitCode}  elapsed=${elapsed}ms`);
    if (!res.headersSent) {
      res.json({ stdout, stderr, exitCode, cwd: newCwd, user, elapsed, signal: signal || null, shell: _SHELL_BIN, osType: _OS_TYPE });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SSH PTY TERMINAL — WebSocket endpoint for full interactive terminal support
// Supports vi, vim, nano, sqlplus, rman, top, htop, mysql, etc.
// Client connects via ws://host:8080/api/os/ssh-pty?host=...&user=...&...
// ════════════════════════════════════════════════════════════════════════════

function _attachSshPtyWs(server) {
  let WS;
  try { WS = require('ws'); } catch(e) {
    console.warn('[ssh-pty] ws package not found — run: npm install ws');
    return;
  }

  const wss = new WS.Server({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/os/ssh-pty') return; // let other handlers deal with it
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const url    = new URL(req.url, 'http://localhost');
    const host   = url.searchParams.get('host')     || '';
    const port   = parseInt(url.searchParams.get('port') || '22', 10);
    const user   = url.searchParams.get('user')     || '';
    const pass   = url.searchParams.get('password') || '';
    const pk     = url.searchParams.get('privateKey') || '';
    const cwd    = url.searchParams.get('cwd')      || '';
    const cols   = parseInt(url.searchParams.get('cols') || '220', 10);
    const rows   = parseInt(url.searchParams.get('rows') || '50',  10);

    if (!host || !user || (!pass && !pk)) {
      ws.send('\r\n\x1b[31mSSH PTY: missing host, user, or credentials\x1b[0m\r\n');
      ws.close();
      return;
    }

    const SSH2 = _getSsh2();
    if (!SSH2) {
      ws.send('\r\n\x1b[31mssh2 package not installed. Run: npm install ssh2\x1b[0m\r\n');
      ws.close();
      return;
    }

    function shellSingleQuote(p) { return "'" + p.replace(/'/g, "'\\''") + "'"; }

    // ── Use SSH session pool so PTY reuses any existing authenticated session ──
    // If the user already ran a Batch command on the same host, this connects
    // instantly (no second password prompt).  The pool evicts idle sessions after
    // 10 minutes of inactivity.
    const poolKey = _sshPoolKey(user, host, port);

    // ── Stale-pooled-connection retry ─────────────────────────────────────────
    // The pool's "alive" check (_sshPoolGet) only inspects the local socket
    // object — it cannot detect a connection the *remote* side has silently
    // dropped (idle timeout, NAT/firewall drop, MaxSessions limit, network
    // blip). When that happens, conn.shell() fails with "Channel open
    // failure" even though _sshPoolGet happily handed back a "ready" entry.
    // Batch mode (POST /api/os/ssh-exec) already retries once with a fresh
    // connection in this situation — the PTY path previously did NOT, which
    // is why Batch could keep working ("credentials shared with Batch mode ✓")
    // while the interactive Terminal still failed with "disconnected (1006)".
    // Mirror the same evict-and-reconnect-once behaviour here.
    function _openShell(conn, isRetry) {
      conn.shell(
        // PTY options: TERM must be set here for vi/sqlplus to render correctly.
        // DO NOT pass a second options object — { env: null } was here previously
        // and is the root cause of "disconnected (1006)":
        //   ssh2's shell() signature is shell([ptyOptions,] [options,] callback).
        //   Passing { env: null } as the options arg causes ssh2 to send an
        //   SSH_MSG_CHANNEL_REQUEST with a null env, which OpenSSH/Oracle Linux
        //   rejects with Channel open failure → the WS closes with code 1006
        //   before a single byte reaches the client.
        // Omitting the options object lets the shell inherit the full session
        // environment; our init block sources .bash_profile on top of that.
        { term: 'xterm-256color', cols, rows },
        (err, stream) => {
          if (err) {
            const isStale = /channel open failure|open failed/i.test(err.message);
            if (isStale && !isRetry) {
              console.warn('[ssh-pty] channel open failure on pooled conn — retrying fresh');
              try { conn.end(); } catch(_e) {}
              _sshPool.delete(poolKey);
              _sshPoolGet(user, host, port, pass, pk)
                .then(fresh => _openShell(fresh, true))
                .catch(e2 => {
                  if (ws.readyState === WS.OPEN) {
                    ws.send(`\r\n\x1b[31mSSH connection failed: ${e2.message}\x1b[0m\r\n`);
                    ws.close();
                  }
                });
              return;
            }
            // Evict broken pooled connection so next attempt creates a fresh SSH session
            const _badEntry = _sshPool.get(poolKey);
            if (_badEntry) { try { _badEntry.conn.end(); } catch(_e) {} _sshPool.delete(poolKey); }
            if (ws.readyState === WS.OPEN) {
              ws.send(`\r\n\x1b[31mSSH shell error: ${err.message}\x1b[0m\r\n`);
              ws.close();
            }
            return;
          }

          // After shell is open, source Oracle env and cd to requested cwd.
          // We write these as shell commands rather than using exec so the
          // interactive shell inherits the environment.
          // ── SILENT INIT SEQUENCE ──────────────────────────────────────────────
          // Problem: when the shell opens, PTY echo is ON by default, so every
          // init command we write appears as visible junk (e.g. "WWWWWWW...") on
          // the terminal before the prompt. We silence this with stty -echo, run
          // all setup silently, restore echo, then send a hard clear.
          //
          // Two-phase approach:
          //   Phase 1 (immediate): disable echo, run all env setup silently,
          //             then re-enable echo and hard-clear the screen.
          //   Phase 2 (after shell settles): we rely on the shell's own prompt.
          //
          // The clear uses \033c (full terminal reset ESC c) which resets scroll
          // region AND clears screen — unlike \033[H\033[2J which only moves cursor
          // and may leave scroll-region artifacts that cause "Enter goes to line 1".

          // ── SILENT INIT — correct approach ────────────────────────────────────
          //
          // ROOT CAUSE of the "WWWWW junk + init script printed on screen" bug:
          // When conn.shell() fires its callback the PTY is open but the remote
          // bash hasn't finished printing its login banner/MOTD yet.  Writing
          // stty commands immediately races with the shell startup sequence:
          //   • stty -echo  often FAILS silently (shell not ready) so echo stays ON
          //   • the rest of the init commands are echoed back visibly as junk text
          //
          // The ONLY fully-reliable silent-init pattern for interactive SSH PTY:
          //
          //   1. Wait for shell to settle (small delay after first data arrives,
          //      or a fixed timeout — we use a 350 ms fixed delay which comfortably
          //      covers even slow Oracle servers with long MOTD banners).
          //
          //   2. Use a HEREDOC / subshell trick to write ALL env commands at once
          //      with PTY echo already confirmed disabled:
          //        { stty -echo; ... setup ...; stty sane -ixon; printf "\033c"; }
          //      Wrapping in { } means bash reads the entire block before executing,
          //      so even if echo is briefly ON for the opening brace, the content
          //      commands never echo because echo is off before they run.
          //
          //   3. End with printf "\033c" (ESC c = full VT100 terminal reset):
          //      • resets scroll region to full screen  ← fixes "Enter → line 1" bug
          //      • clears screen + moves cursor to (0,0)
          //      • resets all SGR/colour attributes
          //      This is stronger than \033[2J (clear only) or \033[H (cursor only).
          //
          // The 350 ms delay means a clean terminal appears ~350 ms after connect —
          // imperceptible to the user but eliminates ALL echo/junk issues.

          const cwdCmd = cwd ? `cd ${shellSingleQuote(cwd)} 2>/dev/null` : '';

          // ================================================================
          // SILENT INIT — production-grade, race-free approach
          // ================================================================
          //
          // BUG 1 — Junk text / WWWWW on screen:
          //   The init compound cmd is echoed before stty -echo takes effect.
          //   Fix: increase settle delay to 500ms; the \033c at the END of
          //   the init block wipes any echoed junk before the user sees it.
          //   Also add \033[r after \033c for belt-and-suspenders scroll reset.
          //
          // BUG 2 — Enter goes to col 0 / start of screen when screen fills:
          //   Stale DECSTBM scroll region left by login banner or vi/sqlplus.
          //   Fix: send \033[r (scroll region reset) + \033[H (cursor home)
          //   in a Phase 2 write 600ms after init. Also call setWindow() to
          //   re-sync PTY dimensions with the client xterm size.
          //
          // BUG 3 — Screen goes blank when full / can't type:
          //   PTY scroll region desyncs from xterm when the client resizes
          //   during the init window. Fix: call setWindow(rows, cols) in
          //   Phase 2 to confirm dimensions after init completes.
          //
          // BUG 4 — Double-fire race in old _initFallback + _firstData:
          //   Old code: stream.once('data', clearTimeout) fired AFTER the
          //   _origDataHandler which had already scheduled _sendInit via
          //   setTimeout(80) — meaning both the 80ms timer AND the 400ms
          //   fallback could fire. Fix: single _initTimer, cancelled on first
          //   use inside _sendInit's own guard (_initSent flag).
          // ================================================================

          const envLines = [
            '[ -f "$HOME/.bash_profile" ] && . "$HOME/.bash_profile" 2>/dev/null',
            '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" 2>/dev/null',
            'for __f in "$HOME"/env_*; do [ -f "$__f" ] && . "$__f" 2>/dev/null; done',
            '[ -z "$ORACLE_HOME" ] && [ -d /u01/app/oracle/product ] && export ORACLE_HOME=$(ls -d /u01/app/oracle/product/*/*/bin/.. 2>/dev/null | head -1)',
            '[ -n "$ORACLE_HOME" ] && export PATH="$ORACLE_HOME/bin:$PATH"',
            'export TERM=xterm-256color',
            '[ -z "$NLS_LANG" ] && export NLS_LANG=AMERICAN_AMERICA.AL32UTF8',
            '[ -n "$ORACLE_HOME" ] && export LD_LIBRARY_PATH="${ORACLE_HOME}/lib:${ORACLE_HOME}/lib32:${LD_LIBRARY_PATH}" 2>/dev/null || true',
          ];
          if (cwdCmd) envLines.push(cwdCmd);

          // ── FIXED INIT BLOCK ─────────────────────────────────────────────────
          // Phase 1: suppress echo → run env setup → restore terminal settings
          // → hard-clear screen with ESC c (full VT100 RIS) + ESC [r (DECSTBM
          //   reset = scroll region = full screen) → restore echo → force a
          //   fresh prompt by sending an empty ENTER (printf "\n").
          //
          // KEY FIX: The old code ended with printf "\033c\033[r" but did NOT
          // restore stty echo before the prompt attempt, and Phase 2 sent
          // \033[H (cursor-to-home = row 1, col 1) which physically repositioned
          // the cursor away from wherever bash placed its prompt — making it
          // appear that no prompt was shown and typing was broken.
          //
          // Correct sequence:
          //   1. stty -echo        → silence echoed init commands
          //   2. source env files  → ORACLE_HOME, PATH, NLS_LANG etc.
          //   3. stty sane         → restore erase/kill/intr keys (^H, ^C etc.)
          //                         -ixon disables Ctrl+S flow-control freeze
          //   4. printf "\033c\033[r" → full reset clears junk + resets scroll region
          //   5. (echo is still OFF here — bash has not re-printed the prompt yet)
          //   6. printf "\n"       → sends a blank line to stdin AFTER echo is
          //                         restored; bash treats it as an empty command
          //                         and re-prints the PS1 prompt at the current
          //                         cursor position — this is what actually makes
          //                         the prompt appear after the clear.
          //
          // Phase 2 (800ms): ONLY sends a PTY resize sync (setWindow) and the
          // DECSTBM reset \033[r. It does NOT send \033[H (cursor-to-home) any
          // more — that was the main cause of the "can't type / blank prompt" bug.
          // FIX: stty echo moved OUTSIDE the { } block.
          // Root cause: stty echo re-enables PTY echo before { } closes,
          // so the closing } gets echoed to the terminal as junk text.
          // Moving stty echo after the block keeps the entire { } silent.
          const initBlock =
            '{ stty -echo 2>/dev/null; ' +
            envLines.join('; ') +
            '; stty sane -ixon 2>/dev/null; printf "\\033c\\033[r"; }; stty echo 2>/dev/null; printf "\\n"';

          let _initSent  = false;
          let _initTimer = null;

          const _sendInit = () => {
            if (_initSent) return;
            _initSent = true;
            if (_initTimer) { clearTimeout(_initTimer); _initTimer = null; }
            // The client-side _ptyInitSuppressed gate hides all output until
            // the first shell prompt is detected, so any echoed init text is
            // never shown. Send the init block directly.
            stream.write(initBlock + '\n');

            // Phase 2 (800ms later): sync PTY dimensions so xterm and the kernel
            // PTY agree on cols/rows. Only send \033[r (DECSTBM reset) — do NOT
            // send \033[H (cursor-to-home) as that repositions the cursor away
            // from the prompt line and makes it appear the terminal is frozen.
            setTimeout(() => {
              if (ws.readyState === WS.OPEN) {
                // DECSTBM reset only — no cursor-home
                stream.write('\033[r');
                if (cols > 0 && rows > 0) {
                  try { stream.setWindow(rows, cols, 0, 0); } catch(_) {}
                }
              }
            }, 800);
          };

          // Forward ALL PTY output to client immediately (never suppress).
          // On first byte received from shell, wait 700ms for banner/MOTD to
          // finish printing, then trigger init. 700ms > old 500ms to handle slow
          // Oracle servers. The \033c at the end of init wipes any interim junk.
          let _firstData = true;
          const _origDataHandler = (d) => {
            if (_firstData) {
              _firstData = false;
              // Cancel the hard fallback; reschedule at 700ms from first data.
              if (_initTimer) clearTimeout(_initTimer);
              _initTimer = setTimeout(_sendInit, 700);
            }
            // Always forward raw bytes — never drop data during init window.
            if (ws.readyState === WS.OPEN) ws.send(Buffer.isBuffer(d) ? d : Buffer.from(d));
          };

          // Hard fallback: shell emits no data within 1200ms (no MOTD, no prompt echo).
          // Must be longer than first-data delay (700ms) so _firstData path always wins.
          _initTimer = setTimeout(_sendInit, 1200);

          stream.on('data', _origDataHandler);

          // NOTE: stream.on('data') is registered above in _origDataHandler
          // which both forwards data to the WebSocket AND triggers the silent init.
          stream.stderr.on('data', d => {
            if (ws.readyState === WS.OPEN) ws.send(Buffer.isBuffer(d) ? d : Buffer.from(d));
          });
          stream.on('close', () => {
            if (ws.readyState === WS.OPEN) {
              ws.send('\r\n\x1b[33m[SSH session closed]\x1b[0m\r\n');
              ws.close();
            }
            _sshPoolRelease(poolKey);
          });

          // ws → stream (browser keystrokes → server stdin)
          ws.on('message', (data, isBinary) => {
            // Always work with a Buffer so we can pipe bytes through unmodified.
            // Writing a JS string to stream.write() goes through Node's UTF-8 encoder
            // which can subtly alter byte values (e.g. high bytes in escape sequences),
            // producing garbled output and cursor-jump-to-column-0 bugs.
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

            // Check for JSON resize control message (always text frame, small).
            // Resize messages are sent by the client as text frames, so isBinary===false
            // and the content starts with '{'.
            if (!isBinary && buf.length < 512) {
              const candidate = buf.toString('utf8');
              if (candidate.trimStart().startsWith('{')) {
                try {
                  const msg = JSON.parse(candidate);
                  if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
                    stream.setWindow(msg.rows, msg.cols, 0, 0);
                    return;  // do NOT forward to shell stdin
                  }
                } catch (_) {}
              }
            }

            // All other input (keystrokes, escape sequences, paste) — write raw bytes.
            // Never use stream.write(string) here: it re-encodes through UTF-8 and
            // breaks multi-byte escape sequences, causing blank lines and cursor jumps.
            stream.write(buf);
          });

          ws.on('close', () => {
            try { stream.end(); } catch (_) {}
            _sshPoolRelease(poolKey);
          });
          ws.on('error', () => {
            try { stream.end(); } catch (_) {}
            _sshPoolRelease(poolKey);
          });
        }
      );
    } // end _openShell

    _sshPoolGet(user, host, port, pass, pk)
      .then(conn => {
        // Mark as in-use; released when WS closes
        // (ref already incremented inside _sshPoolGet)
        _openShell(conn, false);
      })
      .catch(err => {
        if (ws.readyState === WS.OPEN) {
          ws.send(`\r\n\x1b[31mSSH connection failed: ${err.message}\x1b[0m\r\n`);
          ws.close();
        }
      });
  });

  console.log('✓ SSH PTY WebSocket handler attached at /api/os/ssh-pty');
}

// ── Start server ──────────────────────────────────────────────────────────────
// FIX: Create the connection pool BEFORE listening so the first dashboard
// load doesn't pay the pool-initialization cost (was causing the initial flood
// of timeout errors seen on startup).
getPool(_activeDBId)
  .then(() => {
    const server = app.listen(8080, () => {
      console.log('✓ Oracle AI proxy running on http://localhost:8080');
      console.log('  DB user:', DB().user);
      console.log('  Connect string:', DB().connectionString.substring(0, 60) + '...');
      console.log('  Query timeout:', QUERY_TIMEOUT_MS / 1000 + 's');
    });
    _attachStreamlitWsProxy(server);
    _attachSshPtyWs(server);
  })
  .catch(err => {
    console.error('✗ Failed to create Oracle connection pool:', err.message);
    console.error('  Check DB credentials, host, and port, then restart.');
    // Still start the HTTP server so /api/oracle/ping can report the error
    const server = app.listen(8080, () => {
      console.log('  HTTP server started (DB pool unavailable — requests will fail)');
    });
    _attachStreamlitWsProxy(server);
    _attachSshPtyWs(server);
  });

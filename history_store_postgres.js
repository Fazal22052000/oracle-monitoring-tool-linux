'use strict';
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// history_store_postgres.js  -  OraDeck panel history stored in POSTGRESQL  (the Oracle-table version is history_store.js)
//
// History Manager -> "Store history in: [Oracle table] [PostgreSQL]" chooses where NEW snapshots are written and read from.
// Nothing is moved or deleted when you switch: the Oracle table and the PostgreSQL table each keep their own data.
//
// HOW IT IS CONNECTED
//   history_store.js stays the ONE entry point (server.js is unchanged). It loads this file, and while "PostgreSQL" is selected
//     - every snapshot (browser or background collector) is handed to save() below instead of the Oracle INSERT
//     - the storage endpoints  /api/history/{endpoints,table-info,setup,prune,delete,at,data,verify}  are answered by router below
//   The collector, the retention days, the per-panel ON/OFF boxes and the throttling are shared, so they behave exactly the same.
//
// WHAT IS STORED: ONE table (default public.oradeck_history), one row per snapshot of one panel - the same idea as the Oracle table:
//   snap_id, snap_ts (ms), snap_time (timestamptz), scope ('137@orcl' = database@container), panel_key, panel_name, query_params, source,
//   db_id, con_name, con_id, payload_bytes, summary (plain text), row_count, payload (JSON = the panel response, exactly as it was)
// ... plus READABLE VIEWS, one per panel list, with real columns (no JSON in your queries):
//   SELECT * FROM v_deep_sessions_sessions WHERE scope = '137@orcl' ORDER BY snap_time DESC, row_no LIMIT 50;
//   SELECT captured_at, cpu_usage, buffer_hit, sessions_active_sessions FROM v_metrics ORDER BY snap_time DESC LIMIT 20;
//
// SETUP (server .env)
//   npm install pg
//   POSTGRES_URL=postgresql://oradeck:password@host:5432/oradeck           (add ?sslmode=require for SSL)
//     (or the standard libpq variables PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE)
//   POSTGRES_SCHEMA=public            (default public; the schema must exist and the user needs CREATE on it for the Create step)
//   POSTGRES_TABLE=oradeck_history    (default oradeck_history)
//   HISTORY_PG_MAX_MB=2048            (stop recording above this size per database+container; default = HISTORY_MAX_MB)
//   HISTORY_PG_TZ=Asia/Kolkata        (time zone of the captured_at column of the views; default = the server's)
// The table, its 2 indexes and the views are created ONLY when you press History Manager -> Table & SQL -> Create
// (or run the SQL shown there as a DBA). The server never creates tables by itself.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════

const URL_ = () => String(process.env.POSTGRES_URL || process.env.HISTORY_PG_URL || '').trim();
const configured = () => !!URL_() || !!(process.env.PGHOST || process.env.PGDATABASE || process.env.PGUSER);
const SCHEMA = () => String(process.env.POSTGRES_SCHEMA || process.env.HISTORY_PG_SCHEMA || 'public').trim();
const TABLE = () => String(process.env.POSTGRES_TABLE || process.env.HISTORY_PG_TABLE || 'oradeck_history').trim();
const MAX_BYTES_TOTAL = (+process.env.HISTORY_PG_MAX_MB || +process.env.HISTORY_MAX_MB || 2048) * 1048576;
const VIEW_TZ = String(process.env.HISTORY_PG_TZ || (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; } })()).replace(/[^A-Za-z0-9_\/+\-]/g, '') || 'UTC';
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const qi = id => '"' + String(id).replace(/"/g, '""') + '"';                    // quoted identifier
const ql = s => "'" + String(s).replace(/'/g, "''") + "'";                        // quoted literal
function assertNames() {
  if (!IDENT.test(SCHEMA())) throw new Error('POSTGRES_SCHEMA "' + SCHEMA() + '" is not a simple identifier (letters, digits, _ only)');
  if (!IDENT.test(TABLE())) throw new Error('POSTGRES_TABLE "' + TABLE() + '" is not a simple identifier (letters, digits, _ only)');
}
const T = () => { assertNames(); return qi(SCHEMA()) + '.' + qi(TABLE()); };
const mask = u => String(u || '').replace(/(\/\/[^:@/]+:)([^@]*)@/, '$1***@');
const errLine = e => String((e && e.message) || e).split('\n')[0].slice(0, 300);
const mbTxt = b => (b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
const dayStr = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const isNetErr = e => /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EHOSTUNREACH|Connection terminated|timeout expired|server closed the connection|terminating connection|the database system is (starting|shutting)/i.test(String((e && (e.code + ' ' + e.message)) || e));

// ══ READABLE VIEWS ═══════════════════════════════════════════════════════════════════════════════════════════
// A view stores nothing: it re-shapes the JSON of ONE table when you read it (like the Oracle ORADECK_V_* views).
const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const okKey = k => !!k && !/[\0]/.test(k);
const RESERVED = new Set('all analyse analyze and any array as asc both case cast check collate column constraint create current_date current_time current_timestamp current_user default desc distinct do else end except fetch for foreign from grant group having in initially intersect into leading limit localtime localtimestamp not null offset on only or order placing primary references returning select session_user some symmetric table then to trailing union unique user using variadic when where window with'.split(' '));
const META = ['snap_id', 'snap_time', 'captured_at', 'scope', 'database_name', 'db_role', 'container', 'con_id', 'container_type', 'parameters', 'row_no', 'section'];
const snake = s => (String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'x');
const hash4 = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h.toString(36).padStart(4, '0').slice(-4); };
function colOf(label, used) {
  let n = snake(label); if (!/^[a-z]/.test(n)) n = 'c_' + n;
  if (RESERVED.has(n) || META.includes(n)) n += '_';
  n = n.slice(0, 60); let m = n, i = 2; while (used.has(m)) m = n + '_' + i++;
  used.add(m); return m;
}
const viewName = (ep, suffix) => { const n = 'v_' + snake(ep) + (suffix ? '_' + snake(suffix) : ''); return n.length > 63 ? n.slice(0, 57) + '_' + hash4(n) : n; };
const path = (base, keys) => base + keys.map(k => '->' + ql(k)).join('');                         // json value
const pathTxt = (base, keys) => keys.length ? path(base, keys.slice(0, -1)) + '->>' + ql(keys[keys.length - 1]) : '(' + base + " #>> '{}')";   // text value
// typed, NULL-safe column expression: a value of another type becomes NULL / text instead of making the whole view fail
function expr(kind, base, keys) {
  if (kind === 'number') return 'CASE WHEN json_typeof(' + path(base, keys) + ") = 'number' THEN (" + pathTxt(base, keys) + ')::numeric END';
  if (kind === 'bool') return 'CASE WHEN json_typeof(' + path(base, keys) + ") = 'boolean' THEN (" + pathTxt(base, keys) + ')::boolean END';
  if (kind === 'json') return path(base, keys);
  return pathTxt(base, keys);
}
function kindOf(values) {
  const v = values.filter(x => x !== null && x !== undefined);
  if (!v.length) return 'text';
  if (v.some(x => typeof x === 'object')) return 'json';
  if (v.every(x => typeof x === 'number')) return 'number';
  if (v.every(x => typeof x === 'boolean')) return 'bool';
  return 'text';
}
const metaCols = tz => 'h.snap_id, h.snap_time, to_char(h.snap_time AT TIME ZONE ' + ql(tz || VIEW_TZ) + ", 'YYYY-MM-DD HH24:MI:SS') AS captured_at, h.scope, h.db_name AS database_name, h.db_role AS db_role, h.con_name AS container, h.con_id::integer AS con_id, CASE WHEN h.con_id = 0 THEN 'NON-CDB' WHEN h.con_id = 1 THEN 'CDB$ROOT' WHEN h.con_id > 1 THEN 'PDB' END AS container_type, h.query_params AS parameters";
function mainViewSql(schema, table, tz) {
  return 'CREATE OR REPLACE VIEW ' + qi(schema) + '.v_history AS\nSELECT snap_id, snap_time, to_char(snap_time AT TIME ZONE ' + ql(tz || VIEW_TZ) + ", 'YYYY-MM-DD HH24:MI:SS') AS captured_at, scope, db_name AS database_name, db_role,\n       panel_name AS panel, panel_key, query_params AS parameters, source, con_name AS container, con_id::integer AS con_id, CASE WHEN con_id = 0 THEN 'NON-CDB' WHEN con_id = 1 THEN 'CDB$ROOT' WHEN con_id > 1 THEN 'PDB' END AS container_type, row_count,\n       round(payload_bytes / 1024.0, 1) AS size_kb, summary\nFROM " + qi(schema) + '.' + qi(table);
}
// endpoint + a real response -> [{ name, sql }]  ONE view per panel. Every list / group of single values of the panel is one SECTION (UNION ALL):
//   snap_id, snap_time, ..., section (which list the row comes from), row_no (position inside the list), then the columns of ALL sections
//   (a column that a section does not have is NULL in its rows). Single values of the panel = section 'values' (one row per snapshot).
function buildViews(endpoint, data, schema, table, tz) {
  const T2 = qi(schema) + '.' + qi(table), top = isPlain(data) ? data : null, where = 'WHERE h.panel_key = ' + ql(endpoint);
  const parts = [];      // { section, list, key, cols:[{label,keys,kind,name}] }
  const scal = [];
  if (top) for (const k of Object.keys(top)) {
    if (!okKey(k) || scal.length >= 60) continue;
    const v = top[k];
    if (v === null || typeof v !== 'object') scal.push({ label: k, keys: [k], kind: kindOf([v]) });
    else if (isPlain(v)) for (const sk of Object.keys(v)) if (okKey(sk) && scal.length < 60 && (v[sk] === null || typeof v[sk] !== 'object')) scal.push({ label: k + '_' + sk, keys: [k, sk], kind: kindOf([v[sk]]) });
  }
  if (scal.length) parts.push({ section: 'values', list: false, key: null, cols: scal });
  const arrs = [];
  if (Array.isArray(data)) { if (data.length) arrs.push({ key: null, rows: data }); }
  else if (top) for (const k of Object.keys(top)) if (okKey(k) && Array.isArray(top[k]) && top[k].length && arrs.length < 12) arrs.push({ key: k, rows: top[k] });
  for (const a of arrs) {
    if (!a.rows.some(isPlain)) {      // a list of plain values (e.g. ["ORACLE_OCM", ...]) -> one 'item' column
      parts.push({ section: a.key === null ? 'items' : a.key, list: true, key: a.key, plain: true, cols: [{ label: 'item', keys: [], kind: kindOf(a.rows.slice(0, 100)) }] });
      continue;
    }
    const keys = [], vals = {};
    for (const r of a.rows.slice(0, 100)) if (isPlain(r)) for (const k of Object.keys(r)) if (okKey(k)) { if (!(k in vals)) { if (keys.length >= 60) continue; keys.push(k); vals[k] = []; } vals[k].push(r[k]); }
    if (keys.length) parts.push({ section: a.key === null ? 'items' : a.key, list: true, key: a.key, cols: keys.map(k => ({ label: k, keys: [k], kind: kindOf(vals[k]) })) });
  }
  if (!parts.length) return [];
  const glob = new Map();      // column name -> kind (a name used with different kinds in several sections becomes text)
  for (const pt of parts) {
    const used = new Set();
    for (const c of pt.cols) { c.name = colOf(c.label, used); const g = glob.get(c.name); if (g === undefined) glob.set(c.name, c.kind); else if (g !== c.kind) glob.set(c.name, 'text'); }
  }
  const gnames = [...glob.keys()].slice(0, 900);
  const nullOf = k => k === 'number' ? 'NULL::numeric' : k === 'bool' ? 'NULL::boolean' : k === 'json' ? 'NULL::json' : 'NULL::text';
  const selects = parts.map(pt => {
    const byName = new Map(pt.cols.map(c => [c.name, c]));
    const cols = gnames.map(n => (byName.has(n) ? expr(glob.get(n), pt.list ? 'e.item' : 'h.payload', byName.get(n).keys) : nullOf(glob.get(n))) + ' AS ' + qi(n));
    if (!pt.list) return 'SELECT ' + metaCols(tz) + ", 'values'::text AS section, NULL::bigint AS row_no,\n  " + cols.join(',\n  ') + '\nFROM ' + T2 + ' h\n' + where + " AND json_typeof(h.payload) = 'object'";
    const src = pt.key === null ? 'h.payload' : path('h.payload', [pt.key]);
    return 'SELECT ' + metaCols(tz) + ', ' + ql(pt.section) + '::text AS section, e.ord::bigint AS row_no,\n  ' + cols.join(',\n  ') + '\nFROM ' + T2 + ' h\nCROSS JOIN LATERAL json_array_elements(CASE WHEN json_typeof(' + src + ") = 'array' THEN " + src + ' END) WITH ORDINALITY AS e(item, ord)\n' + where + (pt.plain ? '' : " AND json_typeof(e.item) = 'object'");
  });
  const nm = viewName(endpoint, '');
  return [{ name: nm, sql: 'CREATE OR REPLACE VIEW ' + qi(schema) + '.' + qi(nm) + ' AS\n' + selects.join('\nUNION ALL\n') }];
}
// one row per panel: what is stored, which view to read it from, how many snapshots
function panelsViewSql(schema, table) {
  return 'CREATE OR REPLACE VIEW ' + qi(schema) + '.v_panels AS\nSELECT scope, panel_key, max(panel_name) AS panel, (array_agg(view_names ORDER BY snap_ts DESC))[1] AS view_name, count(*) AS snapshots,\n       min(snap_time) AS first_snapshot, max(snap_time) AS last_snapshot\nFROM ' + qi(schema) + '.' + qi(table) + " WHERE panel_key NOT LIKE '\\_\\_verify\\_\\_%'\nGROUP BY scope, panel_key";
}

module.exports = function installPostgres(app, currentDbId, opts, shared) {
  opts = opts || {};
  const express = require('express');
  const router = express.Router();

  // ── connection (lazy: the server starts and works even if the driver or PostgreSQL is missing; only saving fails, with a clear message) ──
  let pool = null;
  function driver() {
    try { return require('pg'); }
    catch (_) { throw new Error("the npm package 'pg' is not installed on the server - run:  npm install pg   (then restart)"); }
  }
  const driverInstalled = () => { try { require.resolve('pg'); return true; } catch (_) { return false; } };
  function getPool() {
    if (pool) return pool;
    if (!configured()) throw new Error('POSTGRES_URL is not set - add it to the server .env (e.g. POSTGRES_URL=postgresql://user:pass@host:5432/dbname) and restart');
    const { Pool } = driver();
    const c = { max: 5, connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000, statement_timeout: 60000, application_name: 'OraDeck-history' };
    if (URL_()) c.connectionString = URL_();
    pool = new Pool(c);
    pool.on('error', e => console.warn('[history] PostgreSQL pool error: ' + errLine(e)));
    return pool;
  }
  const resetPool = () => { const p = pool; pool = null; if (p) { try { p.end().catch(() => {}); } catch (_) {} } };
  async function query(text, params) {
    try { return await getPool().query(text, params); }
    catch (e) { if (isNetErr(e)) resetPool(); throw e; }
  }
  async function ping() {
    const r = await query('SELECT version() AS v, current_user AS u, current_database() AS d');
    return { ok: true, version: String(r.rows[0].v).replace(/^PostgreSQL\s+/, '').split(' ')[0], user: r.rows[0].u, database: r.rows[0].d };
  }
  function dbNameFromUrl() { try { return decodeURIComponent(new URL(URL_()).pathname.replace(/^\//, '')) || ''; } catch (_) { return process.env.PGDATABASE || ''; } }
  function info() {
    return { available: true, driver: driverInstalled(), configured: configured(), uri: URL_() ? mask(URL_()) : (configured() ? 'PG* environment variables' : ''), db: dbNameFromUrl(), schema: SCHEMA(), collection: SCHEMA() + '.' + TABLE() };
  }

  // ── size limit per database+container (cached, so a save does not count the table every time) ──
  const usageBy = new Map();
  async function usage(sc0, force) {
    let u = usageBy.get(sc0);
    if (u && !force && Date.now() - u.ts < 60000) return u;
    let bytes = 0, n = 0;
    try {
      const r = await query('SELECT COALESCE(SUM(payload_bytes), 0)::bigint AS bytes, COUNT(*)::bigint AS n FROM ' + T() + ' WHERE scope = $1', [sc0]);
      bytes = Number(r.rows[0].bytes) || 0; n = Number(r.rows[0].n) || 0;
    } catch (e) { if (e && e.code === '42P01') return { bytes: 0, n: 0, ts: Date.now(), paused: false, missing: true }; if (u) return u; throw e; }
    u = { bytes, n, ts: Date.now(), paused: bytes >= MAX_BYTES_TOTAL };
    usageBy.set(sc0, u); return u;
  }

  // which optional columns (view_names, db_name) does the table have? An older table may lack them: saving then simply skips them (nothing fails)
  let colsCache = null;
  async function tableCols(force) {
    if (!force && colsCache && Date.now() - colsCache.ts < 300000) return colsCache.set;
    try { const r = await query('SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', [SCHEMA(), TABLE()]); colsCache = { set: new Set(r.rows.map(x => x.column_name)), ts: Date.now() }; }
    catch (e) { if (isNetErr(e)) throw e; colsCache = { set: new Set(), ts: Date.now() }; }
    return colsCache.set;
  }
  // database id -> the name it was registered with in the dashboard (e.g. "Primary", "Standby-1")
  const dbNames = new Map(); let dbNamesTs = 0;
  function httpJson(p) {
    const http = require('http');
    return new Promise(resolve => {
      try {
        const rq = http.get({ host: '127.0.0.1', port: opts.getPort ? opts.getPort() : 8080, path: p, timeout: 8000 }, resp => { let b = ''; resp.on('data', d => { if (b.length < 2e6) b += d; }); resp.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } }); });
        rq.on('timeout', () => { rq.destroy(); resolve(null); }); rq.on('error', () => resolve(null));
      } catch (_) { resolve(null); }
    });
  }
  async function dbNameOf(id) {
    if (Date.now() - dbNamesTs > 60000) {
      dbNamesTs = Date.now();
      const j = await httpJson('/api/oracle/databases');
      if (j && Array.isArray(j.databases)) { dbNames.clear(); for (const d of j.databases) if (d && d.id) dbNames.set(String(d.id), String(d.name || '').slice(0, 200)); }
    }
    return dbNames.get(String(id)) || null;
  }
  // ── SAVE one snapshot (called by history_store.js instead of the Oracle INSERT) ──
  async function save(it) {
    const sc0 = it.db;
    const u = await usage(sc0);
    if (u.paused) return { ok: false, why: 'PostgreSQL history is full (' + mbTxt(u.bytes) + ' of ' + mbTxt(MAX_BYTES_TOTAL) + ') - recording is PAUSED, nothing is saved (raise HISTORY_PG_MAX_MB or delete old history)' };
    const parts = String(sc0).split('@'), con = it.con || {};
    try {
      const base = [it.ts, sc0, it.endpoint, (shared.CATALOG && shared.CATALOG[it.endpoint]) || it.endpoint, it.q ? String(it.q).slice(0, 1000) : null, it.src, parts[0] || null,
        con.name || parts[1] || null, con.id != null && isFinite(+con.id) ? +con.id : null, it.bytes, it.summary || null, it.rows == null ? null : it.rows, it.json];
      const doInsert = async extras => {
        const names = ['snap_ts', 'snap_time', 'scope', 'panel_key', 'panel_name', 'query_params', 'source', 'db_id', 'con_name', 'con_id', 'payload_bytes', 'summary', 'row_count'];
        const vals = ['$1::bigint', 'to_timestamp($1::bigint / 1000.0)', '$2', '$3', '$4', '$5', '$6', '$7', '$8', '$9', '$10::bigint', '$11', '$12::int'];
        const args = base.slice();
        if (extras && extras.has('db_name')) { args.push(await dbNameOf(parts[0])); names.push('db_name'); vals.push('$' + args.length + '::text'); }
        if (extras && extras.has('db_role')) { args.push((it.dbMeta && it.dbMeta.role) || null); names.push('db_role'); vals.push('$' + args.length + '::text'); }
        if (extras && extras.has('view_names')) {   // the same list as the newest earlier snapshot of this panel (set by Create); NULL until the first Create
          args.push(sc0, it.endpoint); names.push('view_names');
          vals.push('(SELECT view_names FROM ' + T() + ' WHERE scope = $' + (args.length - 1) + '::text AND panel_key = $' + args.length + '::text AND view_names IS NOT NULL ORDER BY snap_ts DESC LIMIT 1)');
        }
        names.push('payload'); vals.push('$13::json');
        await query('INSERT INTO ' + T() + ' (' + names.join(', ') + ') VALUES (' + vals.join(', ') + ')', args);
      };
      let done = false;
      try { await doInsert(await tableCols()); done = true; }
      catch (e) {
        if (isNetErr(e) || (e && (e.code === '42P01' || e.code === '42501'))) throw e;
        colsCache = null; console.warn('[history] PostgreSQL: saving with the optional columns failed (' + errLine(e) + ') - saving without them');   // the snapshot is saved anyway
      }
      if (!done) await doInsert(null);
    } catch (e) {
      if (e && e.code === '42P01') { usageBy.delete(sc0); return { ok: false, why: 'table ' + SCHEMA() + '.' + TABLE() + ' does not exist in PostgreSQL - History Manager -> Table & SQL -> Create' }; }
      if (e && e.code === '42501') return { ok: false, why: 'not allowed to insert into ' + SCHEMA() + '.' + TABLE() + ': ' + errLine(e) };
      throw e;
    }
    u.bytes += it.bytes; u.n++; if (u.bytes >= MAX_BYTES_TOTAL) u.paused = true;
    return { ok: true, why: 'saved' };
  }

  // ── helpers for the readers ──
  const rowOut = r => ({ ts: Number(r.snap_ts), q: r.query_params || '', con: r.con_name ? { name: r.con_name, id: r.con_id == null ? null : Number(r.con_id) } : null, data: typeof r.payload === 'string' ? (() => { try { return JSON.parse(r.payload); } catch (_) { return null; } })() : r.payload });
  const sc = () => shared.scope();
  const conOf = () => { try { return (opts.conInfo && opts.conInfo()) || null; } catch (_) { return null; } };
  const dbErr = (res, e) => { if (isNetErr(e)) resetPool(); res.status(500).json({ error: errLine(e) }); };

  async function tableInfo() {
    const s = sc(), parts = String(s).split('@'), ci = conOf();
    const base = {
      backend: 'postgres', scope: s, name: SCHEMA() + '.' + TABLE(), table: TABLE(), owner: SCHEMA(), previewOwner: SCHEMA(), configuredOwner: '', loginSchema: SCHEMA(),
      loginUser: '', container: (ci && ci.name) || parts[1] || '', conId: ci && ci.id != null ? Number(ci.id) : null,
      exists: false, rows: 0, bytes: 0, maxBytes: MAX_BYTES_TOTAL, paused: false, loginIsSys: false, uri: info().uri, database: ''
    };
    assertNames();
    const w = await query('SELECT current_user AS u, current_database() AS d, to_regclass($1) IS NOT NULL AS ex', [qi(SCHEMA()) + '.' + qi(TABLE())]);
    base.loginUser = w.rows[0].u; base.database = w.rows[0].d; base.exists = !!w.rows[0].ex;
    if (base.exists) { const u = await usage(s, true); base.rows = u.n; base.bytes = u.bytes; base.paused = u.paused; }
    return base;
  }
  // the statements of the Create step (also shown in the dialog so a DBA can run them by hand)
  const ddl = () => {
    const t = T(), s = SCHEMA(), tb = TABLE(), out = [];
    if (s.toLowerCase() !== 'public') out.push({ kind: 'schema', name: s, sql: 'CREATE SCHEMA ' + qi(s) });
    out.push({ kind: 'table', name: tb, sql: 'CREATE TABLE ' + t + ' (\n  snap_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  snap_ts        bigint       NOT NULL,\n  snap_time      timestamptz  NOT NULL,\n  scope          text         NOT NULL,\n  panel_key      varchar(100) NOT NULL,\n  panel_name     varchar(200),\n  query_params   varchar(1000),\n  source         varchar(10),\n  db_id          varchar(128),\n  db_name        varchar(200),\n  con_name       varchar(128),\n  con_id         integer,\n  payload_bytes  bigint,\n  summary        text,\n  row_count      integer,\n  view_names     text,\n  payload        json         NOT NULL\n)' });
    out.push({ kind: 'column', name: 'view_names', sql: 'ALTER TABLE ' + t + ' ADD COLUMN IF NOT EXISTS view_names text' });
    out.push({ kind: 'column', name: 'db_role', sql: 'ALTER TABLE ' + t + ' ADD COLUMN IF NOT EXISTS db_role varchar(30)' });
    out.push({ kind: 'column', name: 'db_name', sql: 'ALTER TABLE ' + t + ' ADD COLUMN IF NOT EXISTS db_name varchar(200)' });
    out.push({ kind: 'index', name: (tb + '_ix1').slice(0, 63), sql: 'CREATE INDEX ' + qi((tb + '_ix1').slice(0, 63)) + ' ON ' + t + ' (scope, panel_key, snap_ts DESC)' });
    out.push({ kind: 'index', name: (tb + '_ix2').slice(0, 63), sql: 'CREATE INDEX ' + qi((tb + '_ix2').slice(0, 63)) + ' ON ' + t + ' (scope, snap_ts)' });
    out.push({ kind: 'comment', name: null, sql: 'COMMENT ON TABLE ' + t + " IS 'OraDeck dashboard: one row per snapshot of one panel - payload is the panel response as JSON'" });
    return out;
  };

  // ── ENDPOINTS: the panel list with what is stored here ──
  router.get('/endpoints', async (req, res) => {
    const s = sc(); let table = null, stats = {}, dberr = null;
    try {
      table = await tableInfo();
      if (table.exists) {
        const r = await query('SELECT panel_key, COUNT(*)::bigint AS cnt, COALESCE(SUM(payload_bytes), 0)::bigint AS bytes, MIN(snap_ts) AS mints, MAX(snap_ts) AS maxts FROM ' + T() + ' WHERE scope = $1 GROUP BY panel_key', [s]);
        for (const x of r.rows) stats[x.panel_key] = x;
      }
    } catch (e) { dberr = errLine(e); if (isNetErr(e)) resetPool(); }
    try {
      const CAT = shared.CATALOG, cfg = shared.cfg;
      const names = [...new Set([...Object.keys(CAT), ...Object.keys(stats)])].sort((x, y) => (CAT[x] || x).localeCompare(CAT[y] || y));
      let totalBytes = 0;
      const out = names.map(ep => {
        const st = stats[ep], cnt = st ? Number(st.cnt) : 0, bytes = st ? Number(st.bytes) : 0; totalBytes += bytes;
        const o = shared.outcome.get(s + '|' + ep);
        return { endpoint: ep, label: CAT[ep] || ep, enabled: shared.isOn(ep), keepDays: (cfg.keepDays && cfg.keepDays[ep]) || null, collectable: shared.COLLECTABLE.has(ep), collect: shared.COLLECTABLE.has(ep) && cfg.collect[ep] !== false,
          status: shared.collectStatus[s + '|' + ep] || null, problem: o && !o.ok ? { ts: o.ts, msg: o.why } : null, readableViews: [], detailTables: [],
          snapshots: cnt, bytes, firstDay: st && st.mints ? dayStr(new Date(Number(st.mints))) : null, lastDay: st && st.maxts ? dayStr(new Date(Number(st.maxts))) : null };
      });
      const lp = shared.lastPass();
      res.json({ now: Date.now(), container: String(s).split('@')[1] || '', con: table ? { name: table.container, id: table.conId } : conOf(),
        allContainers: !!cfg.collectAllContainers, collector: { enabled: cfg.collectEnabled, intervalMin: cfg.collectIntervalMin, running: shared.running(), lastPass: lp, nextPass: Math.max(Date.now(), lp + cfg.collectIntervalMin * 60000) },
        collecting: shared.running(), retentionDays: shared.RETENTION_DAYS, intervalMin: shared.INTERVAL_MS / 60000, collectEnabled: cfg.collectEnabled, collectIntervalMin: cfg.collectIntervalMin,
        table, dbError: dberr, storage: { bytes: table ? table.bytes : totalBytes, maxBytes: MAX_BYTES_TOTAL, paused: !!(table && table.paused) },
        store: shared.storeInfo(), backend: 'postgres', endpoints: out });
    } catch (e) { dbErr(res, e); }
  });

  // the time zone of the views' captured_at column must be known to PostgreSQL (its list differs from the JS one: Asia/Calcutta vs Asia/Kolkata)
  const TZ_ALIAS = { 'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Kolkata': 'Asia/Calcutta', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Kathmandu': 'Asia/Katmandu', 'Asia/Rangoon': 'Asia/Yangon', 'Asia/Yangon': 'Asia/Rangoon', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Ho_Chi_Minh': 'Asia/Saigon', 'Asia/Dacca': 'Asia/Dhaka', 'Asia/Dhaka': 'Asia/Dacca' };
  let tzCache = null;
  async function viewTz() {
    if (tzCache && Date.now() - tzCache.ts < 600000) return tzCache;
    let v = null;
    for (const c of [VIEW_TZ, TZ_ALIAS[VIEW_TZ]].filter(Boolean)) { try { if ((await query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [c])).rows.length) { v = c; break; } } catch (_) {} }
    tzCache = { v: v || 'UTC', want: VIEW_TZ, fallback: !v, ts: Date.now() };
    return tzCache;
  }
  // ── the newest real response of every panel of this database/container -> view specs (one index-assisted query) ──
  async function viewSpecs() {
    const tz = (await viewTz()).v;
    const r = await query('SELECT DISTINCT ON (panel_key) panel_key, payload::text AS p FROM ' + T() + ' WHERE scope = $1 ORDER BY panel_key, snap_ts DESC', [sc()]);
    const specs = [{ name: 'v_history', sql: mainViewSql(SCHEMA(), TABLE(), tz) }, { name: 'v_panels', sql: panelsViewSql(SCHEMA(), TABLE()) }];
    let panels = 0;
    for (const x of r.rows) {
      if (/^__verify__/.test(x.panel_key)) continue;
      panels++;
      let d; try { d = JSON.parse(x.p); } catch (_) { continue; }
      for (const v of buildViews(x.panel_key, d, SCHEMA(), TABLE(), tz)) specs.push({ ...v, panel: x.panel_key });
    }
    return { specs, panels };
  }
  async function ensureViews(steps) {
    const { specs, panels } = await viewSpecs();
    const have = new Set((await query('SELECT viewname FROM pg_views WHERE schemaname = $1', [SCHEMA()])).rows.map(x => x.viewname));
    let made = 0, upd = 0; const bad = [];
    for (const sp of specs) {
      const existed = have.has(sp.name);
      try {
        try { await query(sp.sql); }
        catch (e) {
          if (e && (e.code === '42P16' || e.code === '42809')) { await query('DROP VIEW ' + qi(SCHEMA()) + '.' + qi(sp.name)); await query(sp.sql); }    // column set changed: re-create
          else throw e;
        }
        if (existed) upd++; else made++;
      } catch (e) { bad.push({ sql: 'CREATE OR REPLACE VIEW ' + SCHEMA() + '.' + sp.name, status: 'error', error: errLine(e) + (e && e.code === '42501' ? ' (needs CREATE on schema ' + SCHEMA() + ')' : '') }); }
    }
    console.log('[history] PostgreSQL views for scope ' + sc() + ': ' + panels + ' panel(s), ' + made + ' created, ' + upd + ' rewritten, ' + bad.length + ' failed' + bad.slice(0, 20).map(b => '\n   ' + b.sql + ' -> ' + b.error).join(''));
    // which views belong to which panel -> view_names column (all snapshots of that panel)
    let vnote = '';
    try {
      const has = (await query('SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3', [SCHEMA(), TABLE(), 'view_names'])).rows.length > 0;
      if (has) {
        colsCache = null; const failed = new Set(bad.map(b => b.sql.replace(/^.* /, ''))), by = new Map();
        for (const sp of specs) if (sp.panel && !failed.has(SCHEMA() + '.' + sp.name)) by.set(sp.panel, (by.get(sp.panel) || []).concat(sp.name));
        let n = 0;
        for (const [pk, names] of by) { const r = await query('UPDATE ' + T() + ' SET view_names = $1 WHERE panel_key = $2 AND view_names IS DISTINCT FROM $1', [names.join(', '), pk]); n += r.rowCount || 0; }
        vnote = ' | view_names column filled for ' + by.size + ' panel(s) (' + n + ' row(s) updated)';
        // database_name: the name each database id was registered with in the dashboard (fills the older snapshots too)
        const hasDn = (await query('SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3', [SCHEMA(), TABLE(), 'db_name'])).rows.length > 0;
        if (hasDn) {
          dbNamesTs = 0; let dn = 0, miss = [];
          for (const x of (await query('SELECT DISTINCT db_id FROM ' + T() + ' WHERE db_name IS NULL AND db_id IS NOT NULL')).rows) {
            const nm = await dbNameOf(x.db_id);
            if (nm) dn += (await query('UPDATE ' + T() + ' SET db_name = $1 WHERE db_id = $2 AND db_name IS NULL', [nm, x.db_id])).rowCount || 0; else miss.push(x.db_id);
          }
          vnote += ' | database_name filled (' + dn + ' row(s))' + (miss.length ? ', no registered name found for ' + miss.join(', ') : '');
        } else vnote += ' | db_name column missing - press Create once more';
      } else vnote = ' | view_names column missing - press Create once more';
    } catch (e) { vnote = ' | view_names update failed: ' + errLine(e); }
    steps.push({ sql: 'readable views for ' + sc() + ': ' + panels + ' panel(s) checked, ' + made + ' created, ' + upd + ' (re)written' + (bad.length ? ', ' + bad.length + ' FAILED' : '') + vnote + '   (v_history, v_<panel>, v_<panel>_<list>)', status: bad.length ? 'error' : 'done', error: bad.length ? 'see the lines below' : undefined });
    for (const b of bad.slice(0, 40)) steps.push(b);
    if (!panels) steps.push({ sql: 'no panel data found for ' + sc() + ' in ' + SCHEMA() + '.' + TABLE() + ' - only v_history was created. Press Collect now, wait a minute, then press Create again', status: 'done' });
    const tzi = await viewTz();
    if (tzi.fallback) steps.push({ sql: 'captured_at is shown in UTC: time zone "' + tzi.want + '" is not known to this PostgreSQL - set HISTORY_PG_TZ (e.g. Asia/Kolkata) and press Create again', status: 'done' });
  }

  // ── Create table: preview (GET) and execute (POST). Nothing is ever dropped; every statement is skipped if the object already exists ──
  router.get('/table-info', async (req, res) => {
    try {
      const t = await tableInfo(); let views = null;
      if (req.query.endpoint && t.exists) {      // the readable views that belong to one panel (used by the snapshot viewer's query helper)
        const r = await query('SELECT payload::text AS p FROM ' + T() + ' WHERE scope = $1 AND panel_key = $2 ORDER BY snap_ts DESC LIMIT 1', [sc(), String(req.query.endpoint)]);
        views = r.rows.length ? buildViews(String(req.query.endpoint), JSON.parse(r.rows[0].p), SCHEMA(), TABLE()).map(v => v.name) : [];
      }
      res.json({ ...t, views, sql: ddl().map(d => d.sql + ';').concat(['-- + one read-only view per panel list with real columns: v_history, v_metrics, v_deep_sessions_sessions ... (built from the newest snapshot of every panel)']),
        note: 'The server only creates objects when you press Create. A DBA can run the statements above by hand instead.' });
    } catch (e) { dbErr(res, e); }
  });
  async function setupHere() {
    const steps = [], ci = conOf(), first = l => l.split('\n')[0];
    let tableFailed = false;
    for (const d of ddl()) {
      const label = first(d.sql);
      try {
        if (d.kind === 'schema') { if ((await query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [d.name])).rows.length) { steps.push({ sql: label, status: 'exists' }); continue; } }
        else if (d.kind === 'table') { if ((await query('SELECT to_regclass($1) IS NOT NULL AS ex', [T()])).rows[0].ex) { steps.push({ sql: label, status: 'exists' }); continue; } }
        else if (d.kind === 'column') { if ((await query('SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3', [SCHEMA(), TABLE(), d.name])).rows.length) { steps.push({ sql: label, status: 'exists' }); continue; } }
        else if (d.kind === 'index') { if ((await query('SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2', [SCHEMA(), d.name])).rows.length) { steps.push({ sql: label, status: 'exists' }); continue; } }
        await query(d.sql);
        if (d.kind === 'column') colsCache = null;
        steps.push({ sql: label, status: d.kind === 'comment' ? 'done' : 'created' });
      } catch (e) { steps.push({ sql: label, status: 'error', error: errLine(e) + (e && e.code === '42501' ? ' (the login lacks the privilege - a DBA can run the statements shown in the dialog)' : '') }); if (d.kind === 'table' || d.kind === 'schema') { tableFailed = true; break; } }
    }
    if (!tableFailed) { try { await ensureViews(steps); } catch (e) { steps.push({ sql: 'readable views', status: 'error', error: errLine(e) }); } }
    usageBy.delete(sc());
    return { container: (ci && ci.name) || String(sc()).split('@')[1] || '', owner: SCHEMA(), steps, ok: !steps.some(x => x.status === 'error' && !/^COMMENT ON/i.test(x.sql)) };
  }
  router.post('/setup', async (req, res) => { try { res.json(await setupHere()); } catch (e) { dbErr(res, e); } });
  router.get('/views-sql', async (req, res) => {
    try {
      const { specs } = await viewSpecs();
      res.type('text/plain').send('-- PostgreSQL readable views of ' + SCHEMA() + '.' + TABLE() + ' (psql). Same as History Manager -> Table & SQL -> Create. Safe to run again.\n' +
        "-- Use them like:  SELECT * FROM " + qi(SCHEMA()) + '.v_metrics WHERE scope = ' + ql(sc()) + ' ORDER BY snap_time DESC LIMIT 20;\n\n' + specs.map(v => v.sql + ';').join('\n\n') + '\n');
    } catch (e) { dbErr(res, e); }
  });

  // ── retention + manual delete (this database/container only) ──
  router.post('/prune', async (req, res) => {
    try {
      const cut = Date.now() - shared.RETENTION_DAYS * 86400000; let total = 0;
      for (let i = 0; i < 400; i++) {      // small batches, so locks and WAL stay small
        const r = await query('DELETE FROM ' + T() + ' WHERE snap_id IN (SELECT snap_id FROM ' + T() + ' WHERE scope = $1 AND snap_ts < $2::numeric::bigint LIMIT 5000)', [sc(), cut]);
        total += r.rowCount || 0; if ((r.rowCount || 0) < 5000) break;
      }
      for (const [pk, days] of Object.entries(shared.cfg.keepDays || {})) {          // panels that are kept for fewer days than the normal retention
        if (!(days >= 1)) continue;
        const pcut = Date.now() - days * 86400000;
        for (let i = 0; i < 400; i++) {
          const r = await query('DELETE FROM ' + T() + ' WHERE snap_id IN (SELECT snap_id FROM ' + T() + ' WHERE scope = $1 AND panel_key = $2 AND snap_ts < $3::numeric::bigint LIMIT 5000)', [sc(), pk, pcut]);
          total += r.rowCount || 0; if ((r.rowCount || 0) < 5000) break;
        }
      }
      usageBy.delete(sc());
      res.json({ ok: true, deleted: total });
    } catch (e) { if (e && e.code === '42P01') return res.json({ ok: true, deleted: 0 }); dbErr(res, e); }
  });
  // {endpoint|everything:true, all:true} | {olderThanDays:N} | {fromTs:ms, toTs:ms}
  router.post('/delete', async (req, res) => {
    try {
      const b = req.body || {}, s = sc();
      if (!b.everything && !b.endpoint) return res.status(400).json({ error: 'endpoint required' });
      const where = ['scope = $1'], p = [s];
      if (!b.everything) { p.push(String(b.endpoint)); where.push('panel_key = $' + p.length); }
      if (b.all) { /* no time limit */ }
      else if (b.olderThanDays != null) { if (!(+b.olderThanDays >= 0)) return res.status(400).json({ error: 'bad olderThanDays' }); p.push(Date.now() - (+b.olderThanDays) * 86400000); where.push('snap_ts <= $' + p.length + '::numeric::bigint'); }
      else if (b.fromTs != null && b.toTs != null) {
        const lo = +b.fromTs, hi = +b.toTs;
        if (!isFinite(lo) || !isFinite(hi)) return res.status(400).json({ error: 'bad time range' });
        if (lo > hi) return res.status(400).json({ error: 'start is after end' });
        p.push(lo); where.push('snap_ts >= $' + p.length + '::numeric::bigint'); p.push(hi); where.push('snap_ts <= $' + p.length + '::numeric::bigint');
      } else return res.status(400).json({ error: 'scope required (all, olderThanDays, or fromTs+toTs)' });
      const r = await query('DELETE FROM ' + T() + ' WHERE ' + where.join(' AND '), p);
      shared.clearThrottle(s); usageBy.delete(s);
      res.json({ ok: true, removedSnapshots: r.rowCount || 0 });
    } catch (e) { if (e && e.code === '42P01') return res.json({ ok: true, removedSnapshots: 0 }); dbErr(res, e); }
  });

  // ── readers: "time travel" and the snapshot viewer ──
  async function readAt(s, endpoint, ts, qp, lookbackDays) {
    const lo = ts - lookbackDays * 86400000, cols = 'snap_ts, query_params, con_name, con_id, payload';
    if (qp != null) {
      const r = await query('SELECT ' + cols + ' FROM ' + T() + ' WHERE scope = $1 AND panel_key = $2 AND snap_ts <= $3::numeric::bigint AND snap_ts >= $4::numeric::bigint AND query_params IS NOT DISTINCT FROM $5 ORDER BY snap_ts DESC LIMIT 1', [s, endpoint, ts, lo, qp === '' ? null : qp.slice(0, 1000)]);
      if (r.rows.length) return Object.assign(rowOut(r.rows[0]), { approx: false });
    }
    const r2 = await query('SELECT ' + cols + ' FROM ' + T() + ' WHERE scope = $1 AND panel_key = $2 AND snap_ts <= $3::numeric::bigint AND snap_ts >= $4::numeric::bigint ORDER BY snap_ts DESC LIMIT 1', [s, endpoint, ts, lo]);
    return r2.rows.length ? Object.assign(rowOut(r2.rows[0]), { approx: qp != null }) : null;
  }
  router.get('/at', async (req, res) => {
    try {
      const ep = String(req.query.endpoint || ''), ts = +req.query.ts;
      if (!ep || !ts) return res.status(400).json({ error: 'endpoint and ts required' });
      const r = await readAt(sc(), ep, ts, req.query.q === undefined ? null : String(req.query.q), +req.query.lookbackDays || 7);
      res.json(r ? { found: true, ts: r.ts, q: r.q, approx: r.approx, con: r.con, data: r.data } : { found: false });
    } catch (e) { if (e && e.code === '42P01') return res.json({ found: false }); dbErr(res, e); }
  });
  router.get('/data', async (req, res) => {
    try {
      const ep = String(req.query.endpoint || ''); if (!ep) return res.status(400).json({ error: 'endpoint required' });
      const to = +req.query.to || Date.now(), from = +req.query.from || to - shared.RETENTION_DAYS * 86400000, s = sc();
      if (req.query.ts) {
        const r = await query('SELECT snap_ts, query_params, con_name, con_id, payload FROM ' + T() + ' WHERE scope = $1 AND panel_key = $2 AND snap_ts = $3::numeric::bigint ORDER BY snap_id LIMIT 1', [s, ep, +req.query.ts]);
        return r.rows.length ? res.json(rowOut(r.rows[0])) : res.status(404).json({ error: 'snapshot not found' });
      }
      const r = await query('SELECT snap_ts, query_params FROM ' + T() + ' WHERE scope = $1 AND panel_key = $2 AND snap_ts BETWEEN $3::numeric::bigint AND $4::numeric::bigint ORDER BY snap_ts LIMIT 200000', [s, ep, from, to]);
      res.json({ snapshots: r.rows.map(x => ({ ts: Number(x.snap_ts), q: x.query_params || '' })), unreadable: 0 });
    } catch (e) { if (e && e.code === '42P01') return res.json({ snapshots: [], unreadable: 0 }); dbErr(res, e); }
  });

  // ── Oracle-only things (SUMMARY backfill, detail tables): nothing to do here ──
  const notNeeded = { ok: true, backend: 'postgres', note: 'not needed with PostgreSQL: SUMMARY is written with every snapshot and the views read the JSON directly' };
  router.get('/detail-sql', (req, res) => res.type('text/plain').send('-- PostgreSQL: no detail tables needed (see GET /api/history/views-sql for the readable views).\n'));
  router.get('/backfill', (req, res) => res.json({ running: false, never: true, backend: 'postgres' }));
  router.post('/backfill', (req, res) => res.json(notNeeded));
  router.post('/make-readable', (req, res) => res.json(notNeeded));

  // ── VERIFY: audits this database/container's PostgreSQL history ──
  router.get('/verify', async (req, res) => {
    const s = sc(), now = Date.now(), checks = [], cfg = shared.cfg, iv = cfg.collectIntervalMin * 60000;
    const add = (level, endpoint, msg) => checks.push({ level, endpoint, msg });
    let con = conOf(); con = con ? { name: con.name, id: con.id } : { name: String(s).split('@')[1] || '', id: null };
    try {
      const pg = await ping();
      add('ok', 'database', 'connected to PostgreSQL ' + pg.version + ' as ' + pg.user + ', database ' + pg.database + ' (' + info().uri + ')');
      const t = await tableInfo();
      if (!t.exists) add('bad', 'table', 'table ' + t.name + ' does not exist - History Manager -> Table & SQL -> Create (or run the SQL shown there as a DBA)');
      else {
        add('ok', 'table', 'table ' + t.name + ' exists: ' + t.rows + ' snapshot(s) of this container, ' + mbTxt(t.bytes) + ' of ' + mbTxt(MAX_BYTES_TOTAL));
        if (t.paused) add('bad', 'table', 'size limit reached - recording is PAUSED (raise HISTORY_PG_MAX_MB or lower the retention)');
        else if (t.bytes > 0.8 * MAX_BYTES_TOTAL) add('warn', 'table', 'table size is over 80% of the limit');
        const ix = (await query('SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2', [SCHEMA(), TABLE()])).rows.map(x => x.indexname);
        const miss = ddl().filter(d => d.kind === 'index' && !ix.includes(d.name)).map(d => d.name);
        if (miss.length) add('warn', 'indexes', 'missing index(es) ' + miss.join(', ') + ' - reads get slow as history grows: History Manager -> Table & SQL -> Create');
        else add('ok', 'indexes', 'both indexes exist');
        const nv = Number((await query("SELECT COUNT(*)::int AS n FROM pg_views WHERE schemaname = $1 AND viewname LIKE 'v\\_%'", [SCHEMA()])).rows[0].n);
        if (!nv) add('warn', 'views', 'no readable views yet (v_history, v_metrics ...) - History Manager -> Table & SQL -> Create creates them');
        else add('ok', 'views', nv + ' readable view(s) exist, e.g. SELECT * FROM ' + SCHEMA() + '.v_history ORDER BY snap_time DESC LIMIT 20');
        // round trip with a BIG payload containing accents / Indian / CJK / emoji characters: it must come back IDENTICAL (the json column keeps the exact text)
        const marker = '__verify__' + process.pid;
        const probe = JSON.stringify({ probe: 'ok', items: Array.from({ length: 2500 }, (_, i) => ({ i, t: 'Zürich é ü ñ 日本語 हिन्दी 🙂 row ' + i, n: i * 1.5 })) });
        try {
          await query('INSERT INTO ' + T() + ' (snap_ts, snap_time, scope, panel_key, panel_name, source, con_name, payload_bytes, payload) VALUES ($1::bigint, to_timestamp($1::bigint / 1000.0), $2, $3, $4, $5, $6, $7::bigint, $8::json)',
            [now, s, marker, 'verify probe', 'VERIFY', con.name, Buffer.byteLength(probe), probe]);
          const back = await query('SELECT payload::text AS p FROM ' + T() + ' WHERE scope = $1 AND panel_key = $2', [s, marker]);
          await query('DELETE FROM ' + T() + ' WHERE scope = $1 AND panel_key = $2', [s, marker]);
          if (back.rows.length === 1 && back.rows[0].p === probe) add('ok', 'table', 'write test passed: a ' + Math.round(Buffer.byteLength(probe) / 1024) + ' KB probe with accents, Hindi, Japanese and emoji was inserted, read back IDENTICAL and deleted');
          else add('bad', 'table', 'write test FAILED: the probe came back ' + (back.rows.length ? 'different' : 'empty'));
        } catch (e) { add('bad', 'table', 'write test FAILED: ' + errLine(e)); try { await query('DELETE FROM ' + T() + ' WHERE scope = $1 AND panel_key = $2', [s, marker]); } catch (_) {} }
        const per = {};
        for (const r of (await query('SELECT panel_key, COUNT(*)::bigint AS cnt, MAX(snap_ts) AS last_ts, (array_agg(con_name ORDER BY snap_ts DESC))[1] AS last_con FROM ' + T() + ' WHERE scope = $1 GROUP BY panel_key', [s])).rows) per[r.panel_key] = r;
        for (const ep of [...shared.COLLECTABLE].sort()) {
          if (!shared.isOn(ep) || cfg.collect[ep] === false) continue;
          const st = shared.collectStatus[s + '|' + ep], o = shared.outcome.get(s + '|' + ep), p = per[ep];
          if (!p) {
            if (st && st.ok) add('bad', ep, 'collector reports OK but NOTHING is saved' + (o && !o.ok ? ' - ' + o.why : ''));
            else if (st) add('bad', ep, 'collector is failing: ' + st.msg);
            else add('warn', ep, 'no snapshot yet (the collector has not reached this panel for this container)');
            continue;
          }
          const lastTs = Number(p.last_ts), ageMin = Math.round((now - lastTs) / 60000);
          if (o && !o.ok) add('bad', ep, 'last save attempt failed: ' + o.why);
          else if (cfg.collectEnabled && now - lastTs > 2.5 * iv) add('warn', ep, 'newest snapshot is ' + ageMin + ' min old (expected every ' + cfg.collectIntervalMin + ' min)' + (st && !st.ok ? ' - collector: ' + st.msg : ''));
          else add('ok', ep, 'newest snapshot ' + ageMin + ' min old, ' + p.cnt + ' stored' + (p.last_con ? ', container ' + p.last_con : ''));
        }
      }
    } catch (e) { add('bad', 'database', 'cannot talk to PostgreSQL: ' + errLine(e)); if (isNetErr(e)) resetPool(); }
    const lp = shared.lastPass(), running = shared.running();
    if (!Array.isArray(cfg.dbAllow) || !cfg.dbAllow.length) add('bad', 'databases', 'NO database is ticked in History Manager -> Databases to store: nothing is saved (tick the databases you want and press Save)');
    else if (!cfg.dbAllow.includes(String(s).split('@')[0])) add('warn', 'databases', 'this database is not ticked in Databases to store: nothing is saved for it');
    if (!cfg.collectEnabled) add('warn', 'collector', 'background collection is OFF - only panels opened in a browser are saved');
    else if (!lp) add('warn', 'collector', 'no collection pass has run yet');
    else if (!running && now - lp > 2.5 * iv) add('bad', 'collector', 'last pass was ' + Math.round((now - lp) / 60000) + ' min ago, but it should run every ' + cfg.collectIntervalMin + ' min');
    else add('ok', 'collector', 'last pass ' + Math.round((now - lp) / 60000) + ' min ago' + (running ? ' (running now)' : '') + ', interval ' + cfg.collectIntervalMin + ' min' + (cfg.collectAllContainers ? ', ALL containers' : ', selected container only'));
    if (shared.queueLen()) add('warn', 'queue', shared.queueLen() + ' snapshot(s) are waiting to be written');
    const summary = { ok: 0, warn: 0, bad: 0 }; checks.forEach(c => summary[c.level]++);
    res.json({ container: String(s).split('@')[1] || '', con, summary, checks, at: now, backend: 'postgres' });
  });

  console.log('[history] PostgreSQL storage module loaded (inactive until History Manager -> "Store history in" -> PostgreSQL). ' + (configured() ? (URL_() ? 'URL ' + mask(URL_()) : 'PG* environment') + ', ' + SCHEMA() + '.' + TABLE() : 'POSTGRES_URL is not set yet'));
  return { save, router, ping, info, shared };
};
module.exports._test = { panelsViewSql, buildViews, mainViewSql, snake, colOf, viewName, qi, ql, expr, kindOf };

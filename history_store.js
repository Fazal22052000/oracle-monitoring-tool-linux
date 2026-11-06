// history_store.js — panel history stored INSIDE the Oracle database, in ONE audit-style table for every panel.
//
//   <owner>.ORADECK_HISTORY   (one row per snapshot of one panel)
//     SNAP_ID, SNAP_TS (epoch ms), SNAP_TIME (db clock), PANEL_KEY, PANEL_NAME, QUERY_PARAMS, SOURCE,
//     DB_NAME / CON_NAME / CON_ID (filled by the DATABASE itself), PAYLOAD_BYTES, PAYLOAD (CLOB, IS JSON)
//
// The table lives in the container the data came from (CDB$ROOT has its own, every PDB has its own), so root and PDB
// history can never mix. Query any panel with plain SQL (JSON_TABLE on PAYLOAD) - see oradeck_history.sql.
//
// Every successful GET /api/oracle/* response is snapshotted (throttled) by INSERT. Nothing is dropped silently:
// the last outcome of every save is kept and shown in the History Manager / Verify.
//
// READABLE: PAYLOAD stays raw JSON (time-travel needs it), but every snapshot also gets a plain-text SUMMARY + ROW_COUNT, the view
//   <TABLE>_V (clean columns) and one view per panel with real columns (ORADECK_V_<PANEL>). Added automatically, additive only.
//   Env: HISTORY_READABLE=0 switches it off, HISTORY_PANEL_VIEWS=0 switches off only the per-panel views.
//   PAYLOAD itself is stored as indented JSON (one field per line); HISTORY_PRETTY=0 = compact.
//   The server does NOT create/alter anything on its own (table = your oradeck_history_readable.sql); HISTORY_AUTO_DDL=1 turns that on.
//   DETAIL TABLES (ORADECK_D_<PANEL>, one row per item, one column per field) are filled by INSERT only; they are created by you
//   (History Manager -> Create table, POST /api/history/make-readable, or the script of GET /api/history/detail-sql).
// Settings kept in files (they are not history): HISTORY_DIR/_config.json, _state.json
// Env: HISTORY_RETENTION_DAYS (30), HISTORY_INTERVAL_MIN (5), HISTORY_MAX_KB (16384 per snapshot),
//      HISTORY_MAX_MB (2048 per container table), HISTORY_SCHEMA (owner of the table; default = login schema),
//      HISTORY_TABLE (ORADECK_HISTORY), HISTORY_DIR, HISTORY_EXCLUDE
const fs = require('fs');
const path = require('path');
const http = require('http');

const MAX_BYTES_TOTAL = (+process.env.HISTORY_MAX_MB || 2048) * 1048576;   // stop recording above this payload size (per container table)
const GAP_MS = +process.env.HISTORY_GAP_MS || 1000;          // pause between two panels of one collection pass
const RETENTION_DAYS = +process.env.HISTORY_RETENTION_DAYS || 30;
const INTERVAL_MS    = (+process.env.HISTORY_INTERVAL_MIN || 5) * 60000;
const MAX_BYTES      = (+process.env.HISTORY_MAX_KB || 16384) * 1024;
const ROOT = process.env.HISTORY_DIR || path.join(__dirname, 'history');    // only _config.json / _state.json live here now
const EXTRA_SKIP = (process.env.HISTORY_EXCLUDE || '').split(',').map(x => x.trim()).filter(Boolean);  // e.g. audit,users,failed-logins
const SKIP = /^(databases|ping|defaults|set-container|sql-text|history|ddl)(\/|$)/;   // ddl, ddl/objects = DDL generator tools (the user types owner/name/type), not monitoring data
const IGNORE_Q = new Set(['dbId', 'container', '_panel', '_collector', '_', 't', 'ts', 'nocache', 'cb', 'bust']);

const IDENT = /^[A-Za-z][A-Za-z0-9_$#]*$/;
const TABLE = String(process.env.HISTORY_TABLE || 'ORADECK_HISTORY').toUpperCase();
if (!IDENT.test(TABLE) || TABLE.length > 24) throw new Error('HISTORY_TABLE must be a plain Oracle identifier of at most 24 characters');
const ENV_SCHEMA = String(process.env.HISTORY_SCHEMA || '').toUpperCase();
if (ENV_SCHEMA && (!IDENT.test(ENV_SCHEMA) || ENV_SCHEMA.length > 128)) throw new Error('HISTORY_SCHEMA is not a valid Oracle identifier');

const dayStr = d => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errLine = e => String((e && e.message) || e).split('\n')[0].slice(0, 300);
const CATALOG = {
  'metrics':'Dashboard KPIs','instances':'Instances','top-sql':'Top SQL (dashboard)','topsql':'Top SQL panel','sessions':'Sessions','locks':'Locks',
  'tablespaces':'Storage / Tablespaces','performance':'Performance','performance-range':'Performance (range)','alerts':'Alerts',
  'schema':'Schema Explorer','anomaly-signals':'Anomaly AI signals','io-stats':'I/O stats','pdbs-live':'Pluggable DBs',
  'logs/alert':'Logs - Alert log','logs/listener':'Logs - Listener','logs/trace-files':'Logs - Trace files','logs/diag-info':'Logs - Diag info',
  'rman':'RMAN','ash':'ASH','awr/snapshots':'AWR snapshots','redo':'Redo logs','scheduler':'Scheduler','datapump':'Data Pump','autotask':'Auto tasks',
  'dataguard':'Data Guard','rac':'RAC','users':'Users','audit':'Audit','privesc':'Privilege escalation','archivelog':'Archive logs',
  'plsql/stats':'PL/SQL stats','plsql/owners':'PL/SQL owners','plsql/objects':'PL/SQL objects','failed-logins':'Failed logins'
};
// endpoints that work with NO parameters, so the server can collect them by itself in the background
const COLLECTABLE = new Set(['metrics','instances','top-sql','sessions','locks','tablespaces','performance','alerts','schema','anomaly-signals','io-stats',
  'pdbs-live','rman','ash','awr/snapshots','redo','scheduler','datapump','autotask','dataguard','rac','users','audit','privesc','archivelog',
  'plsql/stats','plsql/owners','failed-logins','logs/diag-info',
  'topsql','logs/alert','logs/listener','logs/trace-files','performance-range','plsql/objects']);
// the exact query string each panel sends by default, so collected snapshots match what the panel asks for (time-travel looks them up by it)
const COLLECT_QS = {
  'rman': ['days=7'], 'archivelog': ['hours=24'], 'scheduler': ['filter=ALL&owner=ALL'], 'users': ['filter=ALL'],
  'audit': ['from=&to=&user=&action=&hours=24'], 'failed-logins': ['from=&to=&user=&errorCode=&hours=24'],
  'ash': ['minutes=30'], 'awr/snapshots': ['days=0&inst_id=0&dbid=0'],
  'topsql': ['days=3&metric=elapsed'], 'logs/alert': ['from=&to='], 'logs/listener': ['from=&to='], 'logs/trace-files': ['from=&to='],
  // AWR range panel: the last 6 hours (UTC, tzOffset=0). A function = the query string is built fresh at every pass.
  'performance-range': [() => { const f = d => new Date(d).toISOString().slice(0, 16), n = Date.now(); return 'beginTime=' + f(n - 6 * 3600000) + '&endTime=' + f(n) + '&tzOffset=0'; }]
};

// ── settings + collector state (files; they are not history) ──
try { fs.mkdirSync(ROOT, { recursive: true }); } catch (e) { console.warn('[history] cannot create ' + ROOT + ' (' + e.message + ') - settings will not survive a restart; set HISTORY_DIR'); }
const collectStatus = {};
const STATE_FILE = path.join(ROOT, '_state.json');
let lastPassPersisted = 0;
try { const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); Object.assign(collectStatus, st.status || {}); lastPassPersisted = st.lastPass || 0; } catch (_) {}
const saveState = (lp) => { try { fs.writeFileSync(STATE_FILE, JSON.stringify({ lastPass: lp, status: collectStatus })); } catch (_) {} };   // scope|endpoint -> { ts, ok, msg }
const CFG_FILE = path.join(ROOT, '_config.json');
let cfg = { enabled: {}, collect: {}, collectEnabled: true, collectIntervalMin: 5, collectAllContainers: false, historySchema: '', backend: 'oracle', dbAllow: null, keepDays: {} };   // backend: where history is stored - 'oracle' (this file) or 'postgres' (history_store_postgres.js)   // enabled[endpoint] === false -> not recorded
try { cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))); } catch (_) {}
const saveCfg = () => { try { fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 1)); } catch (_) {} };
const isOn = ep => cfg.enabled[ep] !== false;

// ── table naming + DDL ──
const ownerName = () => String(cfg.historySchema || ENV_SCHEMA || '').toUpperCase();        // '' = the login's own schema
const qual = (o) => (o ? o + '.' : '') + TABLE;
const tbl = () => qual(ownerName());
function ddlStatements(o) {
  const t = qual(o);
  return [
`CREATE TABLE ${t} (
  SNAP_ID        NUMBER GENERATED ALWAYS AS IDENTITY,
  SNAP_TS        NUMBER(14)                   NOT NULL,
  SNAP_TIME      TIMESTAMP(3) WITH TIME ZONE  DEFAULT SYSTIMESTAMP NOT NULL,
  PANEL_KEY      VARCHAR2(100)                NOT NULL,
  PANEL_NAME     VARCHAR2(200),
  QUERY_PARAMS   VARCHAR2(1000),
  SOURCE         VARCHAR2(10),
  DB_NAME        VARCHAR2(128) DEFAULT SYS_CONTEXT('USERENV','DB_NAME'),
  CON_NAME       VARCHAR2(128) DEFAULT SYS_CONTEXT('USERENV','CON_NAME'),
  CON_ID         NUMBER        DEFAULT TO_NUMBER(SYS_CONTEXT('USERENV','CON_ID')),
  PAYLOAD_BYTES  NUMBER,
  SUMMARY        VARCHAR2(4000),
  VIEW_NAMES     VARCHAR2(1000),
  DB_LABEL       VARCHAR2(200),
  DB_ROLE        VARCHAR2(30),
  ROW_COUNT      NUMBER,
  PAYLOAD        CLOB                         NOT NULL,
  CONSTRAINT ${TABLE}_PK   PRIMARY KEY (SNAP_ID),
  CONSTRAINT ${TABLE}_JSON CHECK (PAYLOAD IS JSON)
)`,
`CREATE INDEX ${TABLE}_IX1 ON ${t} (PANEL_KEY, SNAP_TS, PAYLOAD_BYTES)`,
`CREATE INDEX ${TABLE}_IX2 ON ${t} (SNAP_TS)`,
`COMMENT ON TABLE ${t} IS 'OraDeck dashboard: one row per snapshot of one panel - PAYLOAD is the panel response as JSON'`
  ];
}

// ── SQL used by the store (one place, so the SQL script / docs / tests stay in sync) ──
const SQL = {
  tableExists: `SELECT COUNT(*) AS CNT FROM ALL_TABLES WHERE OWNER = NVL(:own, SYS_CONTEXT('USERENV','CURRENT_SCHEMA')) AND TABLE_NAME = :tn`,
  indexExists: `SELECT COUNT(*) AS CNT FROM ALL_INDEXES WHERE OWNER = NVL(:own, SYS_CONTEXT('USERENV','CURRENT_SCHEMA')) AND INDEX_NAME = :ix`,
  userExists:  `SELECT COUNT(*) AS CNT FROM ALL_USERS WHERE USERNAME = :u`,
  who:         `SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS CUR_SCHEMA, SYS_CONTEXT('USERENV','SESSION_USER') AS SESS_USER, SYS_CONTEXT('USERENV','CON_NAME') AS CON_NAME, SYS_CONTEXT('USERENV','CON_ID') AS CON_ID FROM DUAL`,
  insert:      () => `INSERT INTO ${tbl()} (SNAP_TS, PANEL_KEY, PANEL_NAME, QUERY_PARAMS, SOURCE, PAYLOAD_BYTES, PAYLOAD) VALUES (:ts, :pk, :pn, :qp, :src, :bytes, :payload)`,
  insertViews: () => `INSERT INTO ${tbl()} (SNAP_TS, PANEL_KEY, PANEL_NAME, QUERY_PARAMS, SOURCE, PAYLOAD_BYTES, PAYLOAD, SUMMARY, ROW_COUNT, VIEW_NAMES) VALUES (:ts, :pk, :pn, :qp, :src, :bytes, :payload, :summary, :rowcnt, :vnames)`,
  insertMeta:  (withViews) => `INSERT INTO ${tbl()} (SNAP_TS, PANEL_KEY, PANEL_NAME, QUERY_PARAMS, SOURCE, PAYLOAD_BYTES, PAYLOAD, SUMMARY, ROW_COUNT${withViews ? ', VIEW_NAMES' : ''}, DB_LABEL, DB_ROLE) VALUES (:ts, :pk, :pn, :qp, :src, :bytes, :payload, :summary, :rowcnt${withViews ? ', :vnames' : ''}, :dblabel, :dbrole)`,
  insertRich:  () => `INSERT INTO ${tbl()} (SNAP_TS, PANEL_KEY, PANEL_NAME, QUERY_PARAMS, SOURCE, PAYLOAD_BYTES, PAYLOAD, SUMMARY, ROW_COUNT) VALUES (:ts, :pk, :pn, :qp, :src, :bytes, :payload, :summary, :rowcnt)`,
  columns:     `SELECT COLUMN_NAME FROM ALL_TAB_COLUMNS WHERE OWNER = :own AND TABLE_NAME = :tn`,
  columnTypes: `SELECT COLUMN_NAME, DATA_TYPE FROM ALL_TAB_COLUMNS WHERE OWNER = :own AND TABLE_NAME = :tn`,
  detailTables:`SELECT TABLE_NAME, COMMENTS FROM ALL_TAB_COMMENTS WHERE OWNER = :own AND TABLE_NAME LIKE :p ESCAPE '\\' AND COMMENTS LIKE 'ORADECK-DETAIL panel=%'`,
  stats:       () => `SELECT PANEL_KEY, COUNT(*) AS CNT, NVL(SUM(PAYLOAD_BYTES), 0) AS BYTES, MIN(SNAP_TS) AS MINTS, MAX(SNAP_TS) AS MAXTS FROM ${tbl()} GROUP BY PANEL_KEY`,
  usage:       () => `SELECT NVL(SUM(PAYLOAD_BYTES), 0) AS BYTES, COUNT(*) AS N FROM ${tbl()}`,
  list:        () => `SELECT SNAP_TS, QUERY_PARAMS FROM ${tbl()} WHERE PANEL_KEY = :pk AND SNAP_TS BETWEEN :f AND :t ORDER BY SNAP_TS`,
  one:         () => `SELECT SNAP_TS, QUERY_PARAMS, CON_NAME, CON_ID, PAYLOAD FROM ${tbl()} WHERE PANEL_KEY = :pk AND SNAP_TS = :ts ORDER BY SNAP_ID FETCH FIRST 1 ROWS ONLY`,
  atQ:         (qIsNull) => `SELECT SNAP_TS, QUERY_PARAMS, CON_NAME, CON_ID, PAYLOAD FROM ${tbl()} WHERE PANEL_KEY = :pk AND SNAP_TS <= :ts AND SNAP_TS >= :lo AND ${qIsNull ? 'QUERY_PARAMS IS NULL' : 'QUERY_PARAMS = :qp'} ORDER BY SNAP_TS DESC FETCH FIRST 1 ROWS ONLY`,
  atAny:       () => `SELECT SNAP_TS, QUERY_PARAMS, CON_NAME, CON_ID, PAYLOAD FROM ${tbl()} WHERE PANEL_KEY = :pk AND SNAP_TS <= :ts AND SNAP_TS >= :lo ORDER BY SNAP_TS DESC FETCH FIRST 1 ROWS ONLY`,
  prune:       () => `DELETE FROM ${tbl()} WHERE SNAP_TS < :cut AND ROWNUM <= 5000`,
  latestPerPanel: () => `SELECT PANEL_KEY, COUNT(*) AS CNT, MAX(SNAP_TS) AS LAST_TS, MAX(CON_NAME) KEEP (DENSE_RANK LAST ORDER BY SNAP_TS) AS LAST_CON FROM ${tbl()} GROUP BY PANEL_KEY`,
  probeDelete: () => `DELETE FROM ${tbl()} WHERE PANEL_KEY = :pk`,
  probeRead:   () => `SELECT PAYLOAD, CON_NAME FROM ${tbl()} WHERE PANEL_KEY = :pk`
};

// ══ READABLE LAYER ══════════════════════════════════════════════════════════════════════════════════════════════
// PAYLOAD stays the raw JSON (needed for time-travel), but nobody should have to read it. On top of it every snapshot gets
//   SUMMARY    plain-text, line by line, human readable   (also ROW_COUNT = number of rows in the panel's main list)
//   <TABLE>_V  one clean view: captured-at, panel, parameters, container, rows, size KB, summary
//   ORADECK_V_<PANEL>  one view per panel with REAL COLUMNS (built from the real data shape; JSON_TABLE) -> plain SELECT * works
// Switch off with HISTORY_READABLE=0 (everything) or HISTORY_PANEL_VIEWS=0 (only the per-panel views).
const READABLE = process.env.HISTORY_READABLE !== '0';
const VIEWS_ON = READABLE && process.env.HISTORY_PANEL_VIEWS !== '0';       // one view per panel list over the single history table (created by YOU, see below)
// The running dashboard NEVER runs CREATE / ALTER by itself (your table is created by oradeck_history_readable.sql). It only uses the SUMMARY / ROW_COUNT
// columns when they exist. DDL happens only when you press Create table / call POST /api/history/make-readable, or if you set HISTORY_AUTO_DDL=1.
const AUTO_DDL = process.env.HISTORY_AUTO_DDL === '1';
// PAYLOAD is stored as INDENTED JSON (one field per line, 2 spaces) instead of one 50,000-character line, so a plain
// SELECT * FROM ORADECK_HISTORY is readable in SQL*Plus / SQL Developer / any viewer. HISTORY_PRETTY=0 = compact again (about 35% smaller).
const PRETTY = process.env.HISTORY_PRETTY !== '0';
const VIEW_PREFIX = ((TABLE.replace(/_?HISTORY$/, '') || TABLE.slice(0, 8)).slice(0, 12)) + '_V_';
const MAIN_VIEW = TABLE + '_V';
const vq = (o, n) => (o ? o + '.' : '') + n;
const RESERVED = new Set(('ACCESS ADD ALL ALTER AND ANY AS ASC AUDIT BETWEEN BY CHAR CHECK CLUSTER COLUMN COMMENT COMPRESS CONNECT CREATE CURRENT DATE DECIMAL DEFAULT DELETE DESC DISTINCT DROP ELSE EXCLUSIVE EXISTS FILE FLOAT FOR FROM GRANT GROUP HAVING IDENTIFIED IMMEDIATE IN INCREMENT INDEX INITIAL INSERT INTEGER INTERSECT INTO IS LEVEL LIKE LOCK LONG MAXEXTENTS MINUS MODE MODIFY NOAUDIT NOCOMPRESS NOT NOWAIT NULL NUMBER OF OFFLINE ON ONLINE OPTION OR ORDER PCTFREE PRIOR PUBLIC RAW RENAME RESOURCE REVOKE ROW ROWID ROWNUM ROWS SELECT SESSION SET SHARE SIZE SMALLINT START SUCCESSFUL SYNONYM SYSDATE TABLE THEN TO TRIGGER UID UNION UNIQUE UPDATE USER VALIDATE VALUES VARCHAR VARCHAR2 VIEW WHENEVER WHERE WITH PATH').split(' '));

const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const okKey = k => !/["\\\u0000-\u001f]/.test(k);
const truncBytes = (s, n) => { s = String(s); if (Buffer.byteLength(s) <= n) return s; return Buffer.from(s).subarray(0, n).toString('utf8').replace(/�+$/, ''); };
const hash4 = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h.toString(36).toUpperCase().padStart(4, '0').slice(-4); };
const safeName = s => { let n = String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'X'; return /^[A-Z]/.test(n) ? n : 'P' + n; };

// value -> short readable text
function fmtVal(v) {
  if (v === null || v === undefined || v === '') return '-';
  if (typeof v === 'object') return Array.isArray(v) ? '[' + v.length + ' items]' : '{...}';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}
const rowText = (o, maxF) => { const ks = Object.keys(o); return ks.slice(0, maxF).map(k => k + '=' + fmtVal(o[k])).join(', ') + (ks.length > maxF ? ', ...' : ''); };

// panel response -> { text, rows }.  text = readable multi-line summary (<= 3900 bytes, fits VARCHAR2(4000)), rows = size of the main list
function summarize(data) {
  const lines = []; let big = 0;
  const top = Array.isArray(data) ? { items: data } : (isPlain(data) ? data : { value: data });
  for (const k of Object.keys(top)) {
    const v = top[k];
    if (Array.isArray(v)) {
      if (v.length > big) big = v.length;
      if (!v.length) lines.push(k + ': 0 rows');
      else if (isPlain(v[0])) {
        lines.push(k + ': ' + v.length + ' row(s)');
        v.slice(0, 3).forEach((r, i) => lines.push('   ' + (i + 1) + ') ' + (isPlain(r) ? rowText(r, 6) : fmtVal(r))));
        if (v.length > 3) lines.push('   ... +' + (v.length - 3) + ' more row(s) - all rows are in the ORADECK_D_ tables / PAYLOAD');
      } else lines.push(k + ': ' + v.slice(0, 10).map(fmtVal).join(', ') + (v.length > 10 ? ' ... (' + v.length + ' items)' : ''));
    } else if (isPlain(v)) {
      const sc = Object.keys(v).filter(x => v[x] === null || typeof v[x] !== 'object');
      lines.push(k + ': ' + sc.slice(0, 8).map(x => x + '=' + fmtVal(v[x])).join(', ') + (Object.keys(v).length > 8 ? ', ...' : ''));
    } else lines.push(k + ': ' + fmtVal(v));
  }
  return { text: truncBytes(lines.join('\n'), 3900) || '(no data)', rows: big || 1 };
}

// JSON key -> clean Oracle column name (physicalReads -> PHYSICAL_READS, reserved words get a trailing _, unique, <= 30 chars)
function colName(label, used) {
  let n = String(label).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase().replace(/[^A-Z0-9_$#]+/g, '_').replace(/^_+|_+$/g, '');
  if (!n || !/^[A-Z]/.test(n)) n = 'C_' + n;
  if (RESERVED.has(n)) n += '_';
  n = n.slice(0, 30);
  let m = n, i = 2;
  while (used.has(m)) { const s = '_' + i++; m = n.slice(0, 30 - s.length) + s; }
  used.add(m); return m;
}

// the main readable view (no JSON in it): what a DBA / auditor selects from
function mainViewSql(owner, withViews, withMeta) {
  return 'CREATE OR REPLACE VIEW ' + vq(owner, MAIN_VIEW) + ' AS\n' +
    "SELECT SNAP_ID, TO_CHAR(SNAP_TIME, 'YYYY-MM-DD HH24:MI:SS TZH:TZM') AS CAPTURED_AT, PANEL_NAME AS PANEL, PANEL_KEY," + (withViews ? ' VIEW_NAMES,' : '') + (withMeta ? ' DB_LABEL AS DATABASE_NAME, DB_ROLE,' : '') + "\n" +
    "       REPLACE(QUERY_PARAMS, CHR(38), ', ') AS PARAMETERS, SOURCE, CON_NAME AS CONTAINER, CON_ID, CASE WHEN CON_ID = 0 THEN 'NON-CDB' WHEN CON_ID = 1 THEN 'CDB$ROOT' WHEN CON_ID > 1 THEN 'PDB' END AS CONTAINER_TYPE, ROW_COUNT,\n" +
    '       ROUND(PAYLOAD_BYTES / 1024, 1) AS SIZE_KB, SUMMARY\n' +
    'FROM ' + qual(owner);
}

// ONE view per panel with REAL, typed columns (JSON_TABLE over the single history table; nothing extra is stored).
// -> [{ name, sql }] (always one entry).  Every list / group of single values of the panel is one SECTION of the view (UNION ALL):
//   SNAP_ID, SNAP_TIME, ..., SECTION (which list the row comes from), ROW_NO (position inside the list), then the columns of ALL sections
//   (a column that a section does not have is NULL in its rows).  Single values of the panel = SECTION 'values' (one row per snapshot).
const CT = "CASE WHEN h.CON_ID = 0 THEN 'NON-CDB' WHEN h.CON_ID = 1 THEN 'CDB$ROOT' WHEN h.CON_ID > 1 THEN 'PDB' END";
function buildViews(endpoint, data, owner, withMeta) {
  const T = qual(owner), q = s => String(s).replace(/'/g, "''"), ep = q(endpoint), base = VIEW_PREFIX + safeName(endpoint);
  const fresh = () => new Set(['SNAP_ID', 'SNAP_TIME', 'CAPTURED_AT', 'CONTAINER', 'CON_ID', 'CONTAINER_TYPE', 'PARAMETERS', 'ROW_NO', 'SECTION', 'DATABASE_NAME', 'DB_ROLE']);
  const nm = base.length > 30 ? base.slice(0, 25) + '_' + hash4(base) : base;
  const top = isPlain(data) ? data : null;
  const collect = () => { const m = new Map(); return { m, add(label, path, v) {
    let e = m.get(path); if (!e) { if (m.size >= 80) return; e = { label, path, json: false, num: true, seen: false }; m.set(path, e); }
    if (v === null || v === undefined) return;
    e.seen = true; if (typeof v === 'object') { e.json = true; e.num = false; } else if (typeof v !== 'number' || !isFinite(v)) e.num = false;
  }, list() { return [...m.values()].map(e => ({ ...e, num: e.seen && e.num })); } }; };
  const parts = [];      // { section, list: bool, key, ents:[{label,path,num,json}] }
  // single values at the top (one level of nested objects is flattened: a.b -> A_B)
  const sc = collect();
  if (top) for (const k of Object.keys(top)) {
    if (!okKey(k)) continue;
    const v = top[k];
    if (v === null || typeof v !== 'object') sc.add(k, '$."' + k + '"', v);
    else if (isPlain(v)) for (const s of Object.keys(v)) if (okKey(s) && (v[s] === null || typeof v[s] !== 'object')) sc.add(k + '_' + s, '$."' + k + '"."' + s + '"', v[s]);
  }
  const scl = sc.list(); if (scl.length) parts.push({ section: 'values', list: false, key: null, ents: scl });
  const arrs = [];
  if (Array.isArray(data)) { if (data.length) arrs.push({ key: null, rows: data }); }
  else if (top) for (const k of Object.keys(top)) if (okKey(k) && Array.isArray(top[k]) && top[k].length && arrs.length < 12) arrs.push({ key: k, rows: top[k] });
  for (const a of arrs) {
    const c = collect();
    for (const r of a.rows) {
      if (!isPlain(r)) { c.add('ITEM', '$', r); continue; }
      for (const k of Object.keys(r)) {
        if (!okKey(k)) continue;
        const v = r[k];
        if (isPlain(v)) {
          const subs = Object.keys(v).filter(s => okKey(s) && (v[s] === null || typeof v[s] !== 'object'));
          if (subs.length) subs.forEach(s => c.add(k + '_' + s, '$."' + k + '"."' + s + '"', v[s])); else c.add(k, '$."' + k + '"', v);
        } else c.add(k, '$."' + k + '"', v);
      }
    }
    const ents = c.list(); if (ents.length) parts.push({ section: a.key === null ? 'items' : a.key, list: true, key: a.key, ents });
  }
  if (!parts.length) return [];
  // column names per section, then ONE global column list (same name in several sections = same column)
  const glob = new Map();      // name -> { num, json }
  for (const pt of parts) {
    const used = fresh();
    pt.cols = pt.ents.map(e => ({ ...e, name: colName(e.label, used) }));
    for (const c of pt.cols) { const g = glob.get(c.name); if (!g) glob.set(c.name, { num: c.num }); else g.num = g.num && c.num; }
  }
  const gnames = [...glob.keys()].slice(0, 900);
  const meta = "h.SNAP_ID, h.SNAP_TIME, TO_CHAR(h.SNAP_TIME, 'YYYY-MM-DD HH24:MI:SS') AS CAPTURED_AT, " + (withMeta ? 'h.DB_LABEL AS DATABASE_NAME, h.DB_ROLE AS DB_ROLE, ' : '') + 'h.CON_NAME AS CONTAINER, h.CON_ID AS CON_ID, ' + CT + ' AS CONTAINER_TYPE, h.QUERY_PARAMS AS PARAMETERS';
  const selects = parts.map(pt => {
    const byName = new Map(pt.cols.map(c => [c.name, c]));
    const defs = (pt.list ? ['ROW_NO FOR ORDINALITY'] : []).concat(pt.cols.filter(c => glob.has(c.name) && gnames.includes(c.name)).map(c => c.name + (glob.get(c.name).num ? ' NUMBER' : ' VARCHAR2(4000)' + (c.json ? ' FORMAT JSON' : '')) + " PATH '" + q(c.path) + "'"));
    if (!pt.list && !defs.length) return null;
    const sel = gnames.map(n => byName.has(n) ? 'j.' + n : 'CAST(NULL AS ' + (glob.get(n).num ? 'NUMBER' : 'VARCHAR2(4000)') + ') AS ' + n).join(', ');
    const jt = pt.list && pt.key !== null ? "JSON_TABLE(h.PAYLOAD, '$' COLUMNS (NESTED PATH '$.\"" + q(pt.key) + "\"[*]' COLUMNS (\n    " + defs.join(',\n    ') + '\n  ))) j'
      : pt.list ? "JSON_TABLE(h.PAYLOAD, '$[*]' COLUMNS (\n  " + defs.join(',\n  ') + '\n)) j'
      : "JSON_TABLE(h.PAYLOAD, '$' COLUMNS (\n  " + defs.join(',\n  ') + '\n)) j';
    return 'SELECT ' + meta + ", '" + q(pt.section) + "' AS SECTION, " + (pt.list ? 'j.ROW_NO' : 'CAST(NULL AS NUMBER) AS ROW_NO') + (sel ? ', ' + sel : '') + '\nFROM ' + T + ' h, ' + jt + "\nWHERE h.PANEL_KEY = '" + ep + "'";
  }).filter(Boolean);
  if (!selects.length) return [];
  return [{ name: nm, sql: 'CREATE OR REPLACE VIEW ' + vq(owner, nm) + ' AS\n' + selects.join('\nUNION ALL\n') }];
}

// one row per panel (what is stored, how many snapshots, which view to read it from)
function panelsViewSql(owner, withViews) {
  const pv = TABLE.replace(/_?HISTORY$/, '') || TABLE.slice(0, 8);
  const nm = pv + '_PANELS';
  return { name: nm, sql: 'CREATE OR REPLACE VIEW ' + vq(owner, nm) + ' AS\nSELECT PANEL_KEY, MAX(PANEL_NAME) AS PANEL, ' + (withViews ? 'MAX(VIEW_NAMES) KEEP (DENSE_RANK LAST ORDER BY SNAP_TS) AS VIEW_NAME, ' : '') + 'COUNT(*) AS SNAPSHOTS, MIN(SNAP_TIME) AS FIRST_SNAPSHOT, MAX(SNAP_TIME) AS LAST_SNAPSHOT\nFROM ' + qual(owner) + "\nWHERE PANEL_KEY NOT LIKE '\\_\\_verify\\_\\_%' ESCAPE '\\'\nGROUP BY PANEL_KEY" };
}

// ══ DETAIL TABLES (audit-style) ═════════════════════════════════════════════════════════════════════════════════════
// Besides the raw JSON row in ORADECK_HISTORY, every panel snapshot is also stored as REAL ROWS and COLUMNS, like DBA_AUDIT_TRAIL:
//   ORADECK_D_<PANEL>   SNAP_ID, SNAP_TS, SNAP_TIME, ROW_NO, <one column per field of the panel>      (one row per item of the panel)
// e.g. ORADECK_D_LOGS_TRACE_FILES: one row per trace file with NAME, PATH, SOURCE, SIZE_, MODIFIED.  Panels that return several lists get one
// table per list (ORADECK_D_PERFORMANCE_RANGE_TOPWAITS); single-value panels (KPIs) get one row per snapshot. Tables and columns are created
// from the real data the first time a panel is seen, new fields are added with ALTER TABLE ADD. Switch off with HISTORY_DETAIL=0.
const DETAIL_ON = process.env.HISTORY_DETAIL === '1';      // OFF by default: the readable layer is the per-panel VIEWS over ONE table (HISTORY_DETAIL=1 = old separate ORADECK_D_ tables)
const D_PREFIX = ((TABLE.replace(/_?HISTORY$/, '') || TABLE.slice(0, 8)).slice(0, 12)) + '_D_';
const DEEP_MAX_ROWS = +process.env.HISTORY_DEEP_MAX_ROWS || 20000;   // rows kept per query of a deep/ui panel (was 2000)
const MAX_DETAIL_ROWS = +process.env.HISTORY_DETAIL_MAX_ROWS || 20000;     // rows stored per list per snapshot (the raw JSON always keeps everything)
const D_FIXED = ['SNAP_ID', 'SNAP_TS', 'SNAP_TIME', 'ROW_NO'];
const D_SQLT = { N: 'NUMBER', V: 'VARCHAR2(4000)', C: 'CLOB' };
const cellOf = v => v === null || v === undefined ? null : (typeof v === 'number' || typeof v === 'string') ? v : typeof v === 'boolean' ? String(v) : JSON.stringify(v);

function detailTableName(endpoint, suffix) {
  const base = D_PREFIX + safeName(endpoint);
  if (!suffix) return base.length > 30 ? base.slice(0, 25) + '_' + hash4(base) : base;
  const suf = safeName(suffix).slice(0, 18), n = base + '_' + suf;
  return n.length > 30 ? base.slice(0, 30 - 1 - suf.length) + '_' + suf : n;
}
// a row object -> flat object (nested objects: a.b -> a_b, nested lists -> JSON text)
function flatRow(r) {
  if (!isPlain(r)) return { ITEM: cellOf(r) };
  const o = {};
  for (const k of Object.keys(r)) {
    const v = r[k];
    if (isPlain(v)) { for (const s of Object.keys(v)) o[k + '_' + s] = cellOf(v[s]); }
    else o[k] = cellOf(v);
  }
  return o;
}
// panel response -> [{ table, rows: [flat objects] }]
function datasetsOf(endpoint, data) {
  const top = isPlain(data) ? data : null, parts = [];
  if (top) {
    const kpi = {};
    for (const k of Object.keys(top)) {
      const v = top[k];
      if (v === null || typeof v !== 'object') kpi[k] = cellOf(v);
      else if (isPlain(v)) for (const s of Object.keys(v)) if (v[s] === null || typeof v[s] !== 'object') kpi[k + '_' + s] = cellOf(v[s]);
    }
    if (Object.keys(kpi).length) parts.push({ key: '', rows: [kpi] });
    for (const k of Object.keys(top)) if (Array.isArray(top[k]) && top[k].length && parts.length < 8) parts.push({ key: k, rows: top[k].slice(0, MAX_DETAIL_ROWS).map(flatRow) });
  } else if (Array.isArray(data) && data.length) parts.push({ key: '', rows: data.slice(0, MAX_DETAIL_ROWS).map(flatRow) });
  else if (data !== null && data !== undefined && !Array.isArray(data) && typeof data !== 'object') parts.push({ key: '', rows: [{ VALUE: cellOf(data) }] });
  return parts.map(p => ({ table: detailTableName(endpoint, parts.length === 1 ? '' : p.key), key: p.key, rows: p.rows }));
}
// column plan from ALL rows: [{ key, name, type }]  type N = every value is a number, C = long text, V = text
function colPlan(rows) {
  const keys = new Map();
  for (const r of rows) for (const k of Object.keys(r)) {
    let m = keys.get(k);
    if (!m) { if (keys.size >= 60) continue; m = { num: true, seen: false, len: 0 }; keys.set(k, m); }
    const v = r[k]; if (v === null || v === undefined) continue;
    m.seen = true; if (typeof v !== 'number' || !isFinite(v)) m.num = false;
    const l = String(v).length; if (l > m.len) m.len = l;
  }
  const used = new Set(D_FIXED), names = new Map();
  for (const k of [...keys.keys()].sort()) names.set(k, colName(k, used));      // sorted pass = names stay stable between snapshots
  return [...keys].map(([k, m]) => ({ key: k, name: names.get(k), type: m.seen && m.num ? 'N' : m.len > 2000 ? 'C' : 'V' }));
}

// What really happened to the LAST attempt to save a snapshot of scope|endpoint. Nothing is dropped silently:
// the collector, the Manager table and the Verify button all read this.
const outcome = new Map();      // scope|endpoint -> { ts, ok, why, p }
function setOutcome(db, endpoint, ok, why) {
  const k = db + '|' + endpoint, o = outcome.get(k) || {};
  o.ts = Date.now(); o.ok = ok; o.why = why; outcome.set(k, o); return o;
}
const mbTxt = n => (n / 1048576).toFixed(1) + ' MB';
const last = new Map();           // throttle: scope|endpoint|q -> ms of the last SUCCESSFUL save (a failed save never blocks the next try)
const pending = new Set();        // keys with a snapshot currently waiting for / in its INSERT (no duplicates)
const failedAt = new Map();       // key -> ms of the last FAILED save: browser requests back off 30 s, the collector always retries
const tableOk = new Map();        // scope -> { exists, ts }
const usageBy = new Map();        // scope -> { bytes, n, ts, paused }

module.exports = function install(app, currentDbId, opts) {
  opts = opts || {};
  const oracledb = opts.oracledb;
  if (!oracledb || typeof opts.getPool !== 'function') throw new Error('history_store needs { oracledb, getPool } from server.js');
  // history is kept per DATABASE + CONTAINER (CDB$ROOT and every PDB each have their own table) - they must never mix
  const scope = opts.scopeKey || currentDbId;
  // storage backend: 'oracle' = the table handled by this file, 'postgres' = history_store_postgres.js (loaded at the end of this function). Chosen in History Manager.
  let pgstore = null;
  const mode = () => (cfg.backend === 'postgres' && pgstore ? 'postgres' : 'oracle');
  const port = () => (opts.getPort && opts.getPort()) || 8080;

  // ── database access (always the connection pool of THIS request's database + container) ──
  async function withConn(fn) {
    const pool = await opts.getPool();
    const conn = await pool.getConnection();
    try { return await fn(conn); } finally { try { await conn.close(); } catch (_) {} }
  }
  const OBJ = { outFormat: oracledb.OUT_FORMAT_OBJECT };
  const S = (v) => ({ val: v === undefined ? null : v, type: oracledb.STRING });
  const N = (v) => ({ val: v === undefined ? null : v, type: oracledb.NUMBER });

  async function tableExists(conn, sc, force) {
    const c = tableOk.get(sc);
    if (!force && c && Date.now() - c.ts < (c.exists ? 600000 : 30000)) return c.exists;
    const r = await conn.execute(SQL.tableExists, { own: S(ownerName() || null), tn: S(TABLE) }, OBJ);
    const exists = Number(r.rows && r.rows[0] && r.rows[0].CNT) > 0;
    tableOk.set(sc, { exists, ts: Date.now() });
    return exists;
  }
  async function usageFor(conn, sc) {
    let u = usageBy.get(sc);
    if (!u || Date.now() - u.ts > 300000) {
      const r = await conn.execute(SQL.usage(), {}, OBJ);
      const bytes = Number(r.rows[0].BYTES) || 0;
      u = { bytes, n: Number(r.rows[0].N) || 0, ts: Date.now(), paused: bytes >= MAX_BYTES_TOTAL };
      usageBy.set(sc, u);
    }
    return u;
  }

  // ── readable layer (per database + container): summary columns, main view, per-panel views ──
  const readyBy = new Map();     // scope -> { ok, eff, ts, err }   ok = SUMMARY / ROW_COUNT columns exist, so inserts can fill them
  const viewSig = new Map();     // scope|view -> { sig, ok, err, ts }  (a view is only re-created when the data shape changed)
  const viewInfo = new Map();    // scope|endpoint -> [{ name, ok, err }]
  async function effOwner(conn) { return ownerName() || String((await conn.execute(SQL.who, {}, OBJ)).rows[0].CUR_SCHEMA || ''); }

  // additive only: adds the two nullable columns if missing and (re)creates the main view. Never drops or rewrites anything.
  async function ensureReadable(conn, sc, eff, steps, allowDdl) {
    steps = steps || [];
    const t = qual(eff), st = { ok: false, eff, ts: Date.now() };
    try {
      const have = new Set((await conn.execute(SQL.columns, { own: S(eff), tn: S(TABLE) }, OBJ)).rows.map(r => r.COLUMN_NAME));
      for (const [col, type] of [['SUMMARY', 'VARCHAR2(4000)'], ['ROW_COUNT', 'NUMBER']]) {
        if (have.has(col)) continue;
        if (!allowDdl) throw new Error('column ' + col + ' is missing in ' + t + ' - run oradeck_history_readable.sql (snapshots are still saved, without SUMMARY)');
        await conn.execute('ALTER TABLE ' + t + ' ADD (' + col + ' ' + type + ')', {}, {});
        steps.push({ sql: 'ALTER TABLE ' + t + ' ADD (' + col + ' ' + type + ')', status: 'created' });
      }
      st.ok = true;
      st.viewCol = have.has('VIEW_NAMES');
      if (!st.viewCol && allowDdl) {        // optional column: which per-panel views belong to the panel of this row
        try { await conn.execute('ALTER TABLE ' + t + ' ADD (VIEW_NAMES VARCHAR2(1000))', {}, {}); st.viewCol = true; steps.push({ sql: 'ALTER TABLE ' + t + ' ADD (VIEW_NAMES VARCHAR2(1000))', status: 'created' }); }
        catch (e) { steps.push({ sql: 'ALTER TABLE ' + t + ' ADD (VIEW_NAMES VARCHAR2(1000))', status: 'error', error: errLine(e) }); }
      }
      // optional columns: the NAME the database was registered with in the dashboard, and its Data Guard role (PRIMARY / PHYSICAL STANDBY) at the time of the snapshot
      st.metaCol = have.has('DB_LABEL') && have.has('DB_ROLE');
      if (!st.metaCol && allowDdl) {
        st.metaCol = true;
        for (const [col, type] of [['DB_LABEL', 'VARCHAR2(200)'], ['DB_ROLE', 'VARCHAR2(30)']]) {
          if (have.has(col)) continue;
          try { await conn.execute('ALTER TABLE ' + t + ' ADD (' + col + ' ' + type + ')', {}, {}); steps.push({ sql: 'ALTER TABLE ' + t + ' ADD (' + col + ' ' + type + ')', status: 'created' }); }
          catch (e) { st.metaCol = false; steps.push({ sql: 'ALTER TABLE ' + t + ' ADD (' + col + ' ' + type + ')', status: 'error', error: errLine(e) }); }
        }
      }
    } catch (e) { st.err = errLine(e); steps.push({ sql: 'ALTER TABLE ' + t + ' ADD (SUMMARY, ROW_COUNT)', status: 'error', error: st.err }); }
    readyBy.set(sc, st);
    if (st.ok && allowDdl) {
      try { await conn.execute(mainViewSql(eff, st.viewCol, st.metaCol), {}, {}); steps.push({ sql: 'CREATE OR REPLACE VIEW ' + vq(eff, MAIN_VIEW), status: 'done' }); }
      catch (e) { steps.push({ sql: 'CREATE OR REPLACE VIEW ' + vq(eff, MAIN_VIEW), status: 'error', error: errLine(e) }); }
      try { const pv = panelsViewSql(eff, st.viewCol); await conn.execute(pv.sql, {}, {}); steps.push({ sql: 'CREATE OR REPLACE VIEW ' + vq(eff, pv.name), status: 'done' }); }
      catch (e) { steps.push({ sql: 'CREATE OR REPLACE VIEW ' + vq(eff, panelsViewSql(eff).name), status: 'error', error: errLine(e) }); }
    }
    return st;
  }
  async function readyFor(conn, sc) {
    const c = readyBy.get(sc);
    if (c && (c.ok || Date.now() - c.ts < 300000)) return c;
    return ensureReadable(conn, sc, await effOwner(conn), null, AUTO_DDL);
  }

  // per-panel views, built from a real response; re-created only when the column set changed (and at most every 10 min)
  async function ensurePanelViews(conn, sc, eff, endpoint, data, force) {
    if (!VIEWS_ON) return 0;
    const rdy = readyBy.get(sc); let specs; try { specs = buildViews(endpoint, data, eff, !!(rdy && rdy.metaCol)); } catch (_) { return 0; }
    const info = []; let changed = 0;
    for (const sp of specs) {
      const k = sc + '|' + sp.name, prev = viewSig.get(k);
      if (!force && prev && (prev.sig === sp.sql || Date.now() - prev.ts < 600000)) { info.push({ name: sp.name, ok: prev.ok, err: prev.err }); continue; }
      let rec = { sig: sp.sql, ok: true, ts: Date.now() };
      try { await conn.execute(sp.sql, {}, {}); changed++; }
      catch (e) { rec = { sig: sp.sql, ok: false, err: errLine(e), ts: Date.now() }; console.warn('[history] cannot create view ' + sp.name + ': ' + rec.err); }
      viewSig.set(k, rec); info.push({ name: sp.name, ok: rec.ok, err: rec.err });
    }
    viewInfo.set(sc + '|' + endpoint, info);
    return changed;
  }

  // names of the per-panel views that belong to a panel (same names buildViews creates) - cached, they only change when the data shape changes
  const vnCache = new Map();
  function viewNamesFor(sc, endpoint, data, eff) {
    const k = sc + '|' + endpoint, c = vnCache.get(k);
    if (c && Date.now() - c.ts < 3600000) return c.v;
    let v = '';
    try { v = truncBytes(buildViews(endpoint, data, eff).map(x => x.name).join(', '), 1000); } catch (_) { v = ''; }
    vnCache.set(k, { v, ts: v ? Date.now() : Date.now() - 3540000 }); return v;      // an empty answer (panel had no rows yet) is re-checked after 1 minute, not 1 hour
  }

  // fills SUMMARY / ROW_COUNT of snapshots stored before the readable layer existed
  async function backfillSummaries(conn, eff, max, fromId) {
    const t = qual(eff), cond = PRETTY ? '(SUMMARY IS NULL OR DBMS_LOB.INSTR(PAYLOAD, CHR(10)) = 0)' : 'SUMMARY IS NULL';
    let done = 0, lastId = +fromId || 0;
    while (done < max) {
      const r = await conn.execute('SELECT SNAP_ID, PAYLOAD FROM ' + t + ' WHERE SNAP_ID > :lastid AND ' + cond + ' ORDER BY SNAP_ID FETCH FIRST 100 ROWS ONLY', { lastid: N(lastId) },
        { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchInfo: { PAYLOAD: { type: oracledb.STRING } } });
      if (!r.rows.length) return { done, more: false, last: lastId };
      for (const x of r.rows) {
        lastId = Number(x.SNAP_ID);
        let obj = null, sm; try { obj = JSON.parse(x.PAYLOAD); sm = summarize(obj); } catch (_) { sm = { text: '(payload could not be summarised)', rows: null }; }
        if (PRETTY && obj !== null && !String(x.PAYLOAD).includes('\n')) {      // old one-line snapshot -> indented, same content
          const p = JSON.stringify(obj, null, 2);
          await conn.execute('UPDATE ' + t + ' SET SUMMARY = :s, ROW_COUNT = :n, PAYLOAD = :p, PAYLOAD_BYTES = :b WHERE SNAP_ID = :id',
            { s: S(sm.text), n: N(sm.rows), p: { val: p, type: oracledb.CLOB }, b: N(Buffer.byteLength(p)), id: N(x.SNAP_ID) }, {});
        } else await conn.execute('UPDATE ' + t + ' SET SUMMARY = :s, ROW_COUNT = :n WHERE SNAP_ID = :id', { s: S(sm.text), n: N(sm.rows), id: N(x.SNAP_ID) }, {});
        done++;
      }
      await conn.commit();
    }
    return { done, more: true, last: lastId };
  }

  // Old snapshots are rewritten (SUMMARY + indented PAYLOAD) by a BACKGROUND job, throttled, never inside a web request (33,000 snapshots take minutes).
  const jobs = new Map();      // scope -> { running, done, started, finished, error, stop }
  function jobView(j) { return j ? { running: j.running, done: j.done, started: j.started, finished: j.finished, error: j.error, stopping: !!j.stop } : { running: false, never: true }; }
  function startBackfill(sc, eff, pool) {
    const cur = jobs.get(sc); if (cur && cur.running) return cur;
    const j = { running: true, done: 0, started: Date.now(), finished: null, error: null, stop: false }; jobs.set(sc, j);
    (async () => {
      let conn, last = 0;
      try {
        conn = await pool.getConnection();
        for (;;) {
          if (j.stop) break;
          const b = await backfillSummaries(conn, eff, 50, last);
          j.done += b.done; last = b.last;
          if (!b.more || b.done === 0) break;
          await sleep(250);
        }
        console.log('[history] readable backfill of ' + sc + ' finished: ' + j.done + ' snapshot(s)' + (j.stop ? ' (stopped)' : ''));
      } catch (e) { j.error = errLine(e); console.warn('[history] readable backfill failed: ' + j.error); }
      finally { j.running = false; j.finished = Date.now(); if (conn) { try { await conn.close(); } catch (_) {} } }
    })();
    return j;
  }

  // everything: columns + main view + per-panel views (from the newest snapshot of every panel) + summaries of old snapshots
  async function makeReadable(conn, sc, eff, steps, backfillMax) {
    const st = await ensureReadable(conn, sc, eff, steps, true);
    if (!st.ok) return st;
    if (st.metaCol) {       // old snapshots get the registered database name too (the role of the past is unknown, so DB_ROLE stays empty for them)
      try {
        const nm = await dbLabelOf(sc);
        if (nm) { const r = await conn.execute('UPDATE ' + qual(eff) + ' SET DB_LABEL = :n WHERE DB_LABEL IS NULL', { n: S(nm) }, {}); await conn.commit(); steps.push({ sql: 'DB_LABEL = ' + nm + ' for older snapshots', status: 'done', rows: r.rowsAffected }); }
      } catch (e) { steps.push({ sql: 'DB_LABEL for older snapshots', status: 'error', error: errLine(e) }); }
    }
    let nViews = 0, nPanels = 0;
    if (VIEWS_ON) {
      const t = qual(eff);
      const latest = await conn.execute('SELECT PANEL_KEY, MAX(SNAP_TS) AS TS FROM ' + t + ' GROUP BY PANEL_KEY', {}, OBJ);
      for (const p of latest.rows) {
        if (/^__verify__/.test(p.PANEL_KEY)) continue;
        try {
          const r = await conn.execute('SELECT PAYLOAD FROM ' + t + ' WHERE PANEL_KEY = :pk AND SNAP_TS = :ts FETCH FIRST 1 ROWS ONLY', { pk: S(p.PANEL_KEY), ts: N(p.TS) },
            { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchInfo: { PAYLOAD: { type: oracledb.STRING } } });
          if (r.rows.length) {
            const dj = JSON.parse(r.rows[0].PAYLOAD);
            nViews += await ensurePanelViews(conn, sc, eff, p.PANEL_KEY, dj, true); nPanels++;
            if (st.viewCol) {       // old rows of this panel get their view names too
              vnCache.delete(sc + '|' + p.PANEL_KEY);
              const vn = viewNamesFor(sc, p.PANEL_KEY, dj, eff);
              await conn.execute('UPDATE ' + t + ' SET VIEW_NAMES = :v WHERE PANEL_KEY = :pk AND (VIEW_NAMES IS NULL OR VIEW_NAMES <> :v)', { v: S(vn), pk: S(p.PANEL_KEY) }, {});
              await conn.commit();
            }
          }
        } catch (e) { steps.push({ sql: 'panel view for ' + p.PANEL_KEY, status: 'error', error: errLine(e) }); }
      }
      const badList = [...viewSig].filter(([k, v]) => k.startsWith(sc + '|') && !v.ok), bad = badList.length;
      for (const [k, v] of badList.slice(0, 8)) steps.push({ sql: 'CREATE OR REPLACE VIEW ' + vq(eff, k.slice(sc.length + 1)), status: 'error', error: v.err });
      if (nPanels && !nViews && !bad) steps.push({ sql: 'views were already up to date', status: 'done' });
      steps.push({ sql: 'per-panel views: ' + nPanels + ' panel(s) checked, ' + nViews + ' view(s) created/updated' + (bad ? ', ' + bad + ' FAILED (see the lines above; ORA-01031 = ' + eff + ' needs GRANT CREATE VIEW)' : ''), status: bad ? 'error' : 'done' });
    }
    if (DETAIL_ON) {
      clearDetailCache(sc);
      const d = await backfillDetails(conn, sc, eff, backfillMax || 5000, 0);
      steps.push({ sql: 'readable detail tables (rows + columns) written for ' + d.done + ' existing snapshot(s)' + (d.more ? ' - more remain, run again' : ''), status: 'done' });
    }
    if (process.env.HISTORY_BACKFILL !== '0') {
      startBackfill(sc, eff, await opts.getPool());
      steps.push({ sql: 'readable SUMMARY + indented PAYLOAD of the EXISTING snapshots: started in the background (progress: GET /api/history/backfill)', status: 'done' });
    }
    return st;
  }

  // ── detail tables (one per panel list) ──
  // The running server NEVER creates or alters these tables (unless HISTORY_AUTO_DDL=1). It only INSERTS into tables that already exist.
  // They are created, like ORADECK_HISTORY, by YOU: History Manager -> Table & SQL -> Create table (or POST /api/history/make-readable),
  // or by running the script from GET /api/history/detail-sql yourself.
  const detailCols = new Map();    // scope|table -> Map(column -> 'N'|'V'|'C')
  const detailInfo = new Map();    // scope|endpoint -> [{ table, rows, ok, err, noTable, missing }]
  const ownerBy = new Map();       // scope -> owner schema
  async function ownerFor(conn, sc) { let e = ownerBy.get(sc); if (!e) { e = await effOwner(conn); ownerBy.set(sc, e); } return e; }
  function clearDetailCache(sc) { for (const k of [...detailCols.keys()]) if (k.startsWith(sc + '|')) detailCols.delete(k); }
  async function detailTables(conn, eff, endpoint) {
    const r = await conn.execute(SQL.detailTables, { own: S(eff), p: S(D_PREFIX.replace(/_/g, '\\_') + '%') }, OBJ);
    return r.rows.map(x => ({ table: x.TABLE_NAME, panel: (/panel=([^;]*)/.exec(x.COMMENTS || '') || [])[1] || '' })).filter(d => endpoint === null || d.panel === endpoint);
  }
  // the DDL of one detail table: [create, index, comment]
  function detailDdl(eff, ds, endpoint, plan) {
    const t = vq(eff, ds.table);
    return [
      'CREATE TABLE ' + t + ' (\n  SNAP_ID NUMBER NOT NULL,\n  SNAP_TS NUMBER(14) NOT NULL,\n  SNAP_TIME TIMESTAMP(3) WITH TIME ZONE NOT NULL,\n  ROW_NO NUMBER' + plan.map(c => ',\n  ' + c.name + ' ' + D_SQLT[c.type]).join('') + '\n)',
      'CREATE INDEX ' + vq(eff, ('I_' + ds.table).slice(0, 30)) + ' ON ' + t + ' (SNAP_TS, SNAP_ID)',
      'COMMENT ON TABLE ' + t + " IS '" + ('ORADECK-DETAIL panel=' + endpoint + '; ' + (CATALOG[endpoint] || endpoint) + (ds.key ? ' - ' + ds.key : '') + ' (one row per item, one column per field)').replace(/'/g, "''") + "'"
    ];
  }
  // allowDdl=false (normal running): never DDL - returns only the columns that already exist; allowDdl=true: creates the table / adds new columns
  async function ensureDetailTable(conn, sc, eff, ds, endpoint, allowDdl) {
    const plan = colPlan(ds.rows), ck = sc + '|' + ds.table, t = vq(eff, ds.table);
    let have = detailCols.get(ck);
    if (!have) {
      have = new Map();
      for (const r of (await conn.execute(SQL.columnTypes, { own: S(eff), tn: S(ds.table) }, OBJ)).rows) have.set(r.COLUMN_NAME, r.DATA_TYPE === 'NUMBER' ? 'N' : r.DATA_TYPE === 'CLOB' ? 'C' : 'V');
      if (!have.size) {
        if (!allowDdl) return { noTable: true, plan: [], have, t, missing: [] };
        const [create, index, comment] = detailDdl(eff, ds, endpoint, plan);
        await conn.execute(create, {}, {});
        for (const c of D_FIXED) have.set(c, 'V'); plan.forEach(c => have.set(c.name, c.type));
        try { await conn.execute(index, {}, {}); } catch (e) { console.warn('[history] index on ' + ds.table + ': ' + errLine(e)); }
        try { await conn.execute(comment, {}, {}); } catch (_) {}
      }
      detailCols.set(ck, have);
    }
    const add = plan.filter(c => !have.has(c.name));
    if (add.length && allowDdl) { await conn.execute('ALTER TABLE ' + t + ' ADD (' + add.map(c => c.name + ' ' + D_SQLT[c.type]).join(', ') + ')', {}, {}); add.forEach(c => have.set(c.name, c.type)); }
    return { plan: plan.filter(c => have.has(c.name)), have, t, missing: allowDdl ? [] : add.map(c => c.name) };
  }
  async function insertDetail(conn, sc, eff, ds, endpoint, snapId, ts, allowDdl) {
    for (let attempt = 0; ; attempt++) {
      try {
        const { plan, have, t, noTable, missing } = await ensureDetailTable(conn, sc, eff, ds, endpoint, allowDdl);
        if (noTable) return { rows: 0, noTable: true };
        if (!plan.length || !ds.rows.length) return { rows: 0, missing };
        const sql = 'INSERT INTO ' + t + ' (SNAP_ID, SNAP_TS, SNAP_TIME, ROW_NO' + plan.map(c => ', ' + c.name).join('') +
          ") VALUES (:b1, :b2, (TIMESTAMP '1970-01-01 00:00:00 UTC' + NUMTODSINTERVAL(:b3 / 1000, 'SECOND')) AT LOCAL, :b4" + plan.map((c, i) => ', :v' + i).join('') + ')';
        const defs = { b1: { type: oracledb.NUMBER }, b2: { type: oracledb.NUMBER }, b3: { type: oracledb.NUMBER }, b4: { type: oracledb.NUMBER } };
        const kinds = plan.map(c => have.get(c.name) || c.type);
        const rows = ds.rows.map((r, n) => {
          const o = { b1: snapId, b2: ts, b3: ts, b4: n + 1 };
          plan.forEach((c, i) => {
            const v = r[c.key], k = kinds[i];
            if (v === null || v === undefined) o['v' + i] = null;
            else if (k === 'N') o['v' + i] = typeof v === 'number' && isFinite(v) ? v : (v !== '' && isFinite(Number(v)) ? Number(v) : null);
            else o['v' + i] = k === 'V' ? truncBytes(String(v), 4000) : String(v);
          });
          return o;
        });
        plan.forEach((c, i) => {
          const k = kinds[i];
          if (k === 'N') defs['v' + i] = { type: oracledb.NUMBER };
          else if (k === 'V') defs['v' + i] = { type: oracledb.STRING, maxSize: 4000 };
          else defs['v' + i] = { type: oracledb.STRING, maxSize: Math.max(1, ...rows.map(o => o['v' + i] == null ? 0 : Buffer.byteLength(o['v' + i]))) };
        });
        for (let i = 0; i < rows.length; i += 1000) await conn.executeMany(sql, rows.slice(i, i + 1000), { bindDefs: defs, autoCommit: true });
        return { rows: rows.length, missing };
      } catch (e) {
        if (attempt < 1 && /ORA-00942|ORA-00904/.test(errLine(e))) { detailCols.delete(sc + '|' + ds.table); continue; }     // table was dropped / changed by hand: re-read it
        throw e;
      }
    }
  }
  async function saveDetails(conn, sc, eff, endpoint, data, snapId, ts, allowDdl) {
    const info = [];
    for (const ds of datasetsOf(endpoint, data)) {
      try { const r = await insertDetail(conn, sc, eff, ds, endpoint, snapId, ts, allowDdl); info.push({ table: ds.table, rows: r.rows, ok: true, noTable: !!r.noTable, missing: r.missing || [] }); }
      catch (e) { info.push({ table: ds.table, rows: 0, ok: false, err: errLine(e) }); console.warn('[history] detail table ' + ds.table + ' not saved: ' + errLine(e)); }
    }
    detailInfo.set(sc + '|' + endpoint, info);
    return info;
  }
  // the CREATE script for every detail table that does not exist yet, built from the newest snapshot of each panel
  async function detailScript(conn, eff) {
    const exist = new Set((await detailTables(conn, eff, null)).map(d => d.table)), out = [];
    const latest = await conn.execute('SELECT PANEL_KEY, MAX(SNAP_TS) AS TS FROM ' + qual(eff) + ' GROUP BY PANEL_KEY ORDER BY PANEL_KEY', {}, OBJ);
    for (const p of latest.rows) {
      if (/^__verify__/.test(p.PANEL_KEY)) continue;
      const r = await conn.execute('SELECT PAYLOAD FROM ' + qual(eff) + ' WHERE PANEL_KEY = :pk AND SNAP_TS = :ts FETCH FIRST 1 ROWS ONLY', { pk: S(p.PANEL_KEY), ts: N(p.TS) },
        { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchInfo: { PAYLOAD: { type: oracledb.STRING } } });
      if (!r.rows.length) continue;
      let data; try { data = JSON.parse(r.rows[0].PAYLOAD); } catch (_) { continue; }
      for (const ds of datasetsOf(p.PANEL_KEY, data)) {
        if (exist.has(ds.table)) { out.push('-- exists already: ' + ds.table); continue; }
        const plan = colPlan(ds.rows); if (!plan.length) continue;
        out.push(...detailDdl(eff, ds, p.PANEL_KEY, plan).map(x => x + ';'));
      }
    }
    return out;
  }
  // old snapshots -> detail rows (explicit action only; skips snapshots that already have rows, so it can be run again)
  async function backfillDetails(conn, sc, eff, max, fromId) {
    const t = qual(eff); let done = 0, last = +fromId || 0;
    while (done < max) {
      const r = await conn.execute('SELECT SNAP_ID, SNAP_TS, PANEL_KEY, PAYLOAD FROM ' + t + " WHERE SNAP_ID > :lastid AND PANEL_KEY NOT LIKE '\\_\\_verify\\_\\_%' ESCAPE '\\' ORDER BY SNAP_ID FETCH FIRST 50 ROWS ONLY", { lastid: N(last) },
        { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchInfo: { PAYLOAD: { type: oracledb.STRING } } });
      if (!r.rows.length) return { done, more: false, last };
      for (const x of r.rows) {
        last = Number(x.SNAP_ID); done++;
        let data; try { data = JSON.parse(x.PAYLOAD); } catch (_) { continue; }
        for (const ds of datasetsOf(x.PANEL_KEY, data)) {
          try {
            const { t: dt } = await ensureDetailTable(conn, sc, eff, ds, x.PANEL_KEY, true);
            const ex = await conn.execute('SELECT 1 AS X FROM ' + dt + ' WHERE SNAP_TS = :ts AND SNAP_ID = :id FETCH FIRST 1 ROWS ONLY', { ts: N(x.SNAP_TS), id: N(last) }, OBJ);
            if (!ex.rows.length) await insertDetail(conn, sc, eff, ds, x.PANEL_KEY, last, Number(x.SNAP_TS), true);
          } catch (e) { console.warn('[history] backfill ' + ds.table + ' snapshot ' + last + ': ' + errLine(e)); }
        }
      }
    }
    return { done, more: true, last };
  }

  // ── write queue: snapshots are inserted by a few background workers, never inside the panel's own request ──
  const queue = []; let active = 0; const MAX_PAR = 4;
  function finish(it, ok, why) {
    pending.delete(it.key); it.data = null;
    if (ok) { last.set(it.key, it.ts); failedAt.delete(it.key); } else failedAt.set(it.key, Date.now());
    setOutcome(it.db, it.endpoint, ok, why); it.done();
  }
  function enqueue(it) {
    if (queue.length >= 500) { const d = queue.shift(); finish(d, false, 'save queue overflow (database slow or unreachable) - snapshot dropped'); }
    queue.push(it); pump();
  }
  function pump() {
    while (active < MAX_PAR && queue.length) {
      const it = queue.shift(); active++;
      processItem(it).catch(e => finish(it, false, 'unexpected: ' + errLine(e))).finally(() => { active--; pump(); });
    }
  }
  async function processItem(it) {
    if (mode() === 'postgres') {      // PostgreSQL selected: the snapshot goes to history_store_postgres.js (same queue, throttling and reporting)
      try { const r = await pgstore.save(it); return finish(it, !!r.ok, r.why); }
      catch (e) { return finish(it, false, 'PostgreSQL: ' + errLine(e)); }
    }
    for (let attempt = 0; ; attempt++) {
      let conn;
      try {
        const pool = await it.poolP;
        if (!pool) throw new Error('no database connection pool');
        conn = await pool.getConnection();
        if (!(await tableExists(conn, it.db))) return finish(it, false, 'history table ' + tbl() + ' does not exist in this container (or this login cannot see it) - History Manager -> Create table');
        const u = await usageFor(conn, it.db);
        if (u.paused) return finish(it, false, 'history table is full (' + mbTxt(u.bytes) + ' of ' + mbTxt(MAX_BYTES_TOTAL) + ') - recording is PAUSED, nothing is saved');
        const rd = READABLE ? await readyFor(conn, it.db) : { ok: false };      // adds SUMMARY / ROW_COUNT to an older table on first use
        const binds = {
          ts: N(it.ts), pk: S(it.endpoint), pn: S(CATALOG[it.endpoint] || it.endpoint), qp: S(it.q ? it.q.slice(0, 1000) : null),
          src: S(it.src), bytes: N(it.bytes), payload: { val: it.json, type: oracledb.CLOB }
        };
        if (rd.ok) { binds.summary = S(it.summary); binds.rowcnt = N(it.rows); }
        const vn = rd.ok && rd.viewCol ? viewNamesFor(it.db, it.endpoint, it.data, rd.eff) : null;
        if (vn !== null) binds.vnames = S(vn);
        const useMeta = rd.ok && rd.metaCol;
        if (useMeta) { binds.dblabel = S(await dbLabelOf(it.db)); binds.dbrole = S((it.dbMeta && it.dbMeta.role) || null); }
        if (DETAIL_ON) binds.sid = { dir: oracledb.BIND_OUT, type: oracledb.NUMBER };
        const ins = await conn.execute((rd.ok ? (useMeta ? SQL.insertMeta(vn !== null) : vn !== null ? SQL.insertViews() : SQL.insertRich()) : SQL.insert()) + (DETAIL_ON ? ' RETURNING SNAP_ID INTO :sid' : ''), binds, { autoCommit: true });
        u.bytes += it.bytes; u.n++; if (u.bytes >= MAX_BYTES_TOTAL) u.paused = true;
        let note = '';
        if (DETAIL_ON && it.data && ins.outBinds && ins.outBinds.sid && ins.outBinds.sid[0] != null) {      // the raw snapshot is saved; now the readable rows / columns
          const dinfo = await saveDetails(conn, it.db, rd.eff || await ownerFor(conn, it.db), it.endpoint, it.data, ins.outBinds.sid[0], it.ts, AUTO_DDL);
          const bad = dinfo.filter(x => !x.ok); if (bad.length) note = ' (readable detail rows NOT saved: ' + bad[0].err + ')';
        }
        if (rd.ok && AUTO_DDL && it.data) { try { await ensurePanelViews(conn, it.db, rd.eff, it.endpoint, it.data); } catch (_) {} }   // a view problem never fails a saved snapshot
        return finish(it, true, 'saved' + note);
      } catch (e) {
        const msg = errLine(e);
        if (/ORA-00942/.test(msg)) { tableOk.set(it.db, { exists: false, ts: Date.now() }); return finish(it, false, 'history table ' + tbl() + ' does not exist in this container - History Manager -> Create table'); }
        if (/ORA-01950|ORA-01536|ORA-01653|ORA-01654/.test(msg)) return finish(it, false, 'no space / quota for the history table: ' + msg);
        if (/ORA-00904/.test(msg) && attempt < 2) { readyBy.delete(it.db); continue; }      // table was re-created without the summary columns: re-check
        if (/ORA-02290/.test(msg)) return finish(it, false, 'payload rejected by the IS JSON check: ' + msg);
        if (/ORA-01031|ORA-01045/.test(msg)) return finish(it, false, 'not allowed to insert into ' + tbl() + ': ' + msg);
        if (attempt < 2 && /NJS-040|NJS-064|NJS-065|NJS-500|NJS-503|ORA-03113|ORA-03114|ORA-03135|ORA-12541|ORA-12514|ORA-12170|ORA-12537|DPY-|timeout/i.test(msg)) { await sleep(3000 * (attempt + 1)); continue; }
        return finish(it, false, 'insert failed: ' + msg);
      } finally { if (conn) { try { await conn.close(); } catch (_) {} } }
    }
  }

  // the Data Guard role (PRIMARY / PHYSICAL STANDBY ...) of a database/container, learnt from the Data Guard panel; every later snapshot carries it (PostgreSQL column db_role)
  const dbMeta = new Map();       // scope -> { role }
  const metaOf = db => ({ role: (dbMeta.get(db) || {}).role || null });
  // database id -> the name it was registered with in the dashboard (e.g. "Primary", "Standby-1"); refreshed at most once a minute
  let dbNames = null, dbNamesTs = 0;
  async function dbLabelOf(db) {
    try {
      if (!dbNames || Date.now() - dbNamesTs > 60000) {
        dbNamesTs = Date.now();
        const j = await getJson('/api/oracle/databases');
        if (j && Array.isArray(j.databases)) dbNames = new Map(j.databases.filter(d => d && d.id).map(d => [String(d.id), String(d.name || '').slice(0, 200)]));
      }
      return (dbNames && dbNames.get(String(db).split('@')[0])) || null;
    } catch (_) { return null; }
  }
  // which registered databases may have their history stored (History Manager -> "Databases to store"): ONLY the ones ticked and saved there. Nothing is ticked by default (null = nothing is stored yet)
  const allowedDb = db => Array.isArray(cfg.dbAllow) && cfg.dbAllow.includes(String(db).split('@')[0]);
  function record(db, endpoint, q, data, fromCollector) {
    if (!isOn(endpoint)) return;
    if (!allowedDb(db)) { setOutcome(db, endpoint, true, 'not stored: this database is not ticked in History Manager -> Databases to store (tick it and press Save)'); return; }
    try {      // remember the role from the Data Guard panel
      if (endpoint === 'dataguard' && data && typeof data.role === 'string' && data.role) dbMeta.set(db, { role: data.role.slice(0, 30) });
    } catch (_) {}
    const u = mode() === 'oracle' ? usageBy.get(db) : null;            // the Oracle 'table full' flag only matters while the Oracle table is the store
    if (u && u.paused) { setOutcome(db, endpoint, false, 'history table is full (' + mbTxt(u.bytes) + ' of ' + mbTxt(MAX_BYTES_TOTAL) + ') - recording is PAUSED, nothing is saved'); return; }
    const key = db + '|' + endpoint + '|' + q;
    const now = Date.now();
    if (pending.has(key)) return;                                                         // already being saved
    if (now - (last.get(key) || 0) < (fromCollector ? 60000 : INTERVAL_MS)) { if (!outcome.has(db + '|' + endpoint)) setOutcome(db, endpoint, true, 'a recent snapshot already exists'); return; }   // collector only de-dupes within 1 min, so a slightly early pass is never skipped
    if (!fromCollector && now - (failedAt.get(key) || 0) < 30000) return;                 // last try failed: do not hammer the database from every page refresh
    if (last.size > 5000) for (const [k, t] of last) if (now - t > INTERVAL_MS) last.delete(k);
    let json; try { json = JSON.stringify(data, null, PRETTY ? 2 : 0); } catch (_) { failedAt.set(key, now); setOutcome(db, endpoint, false, 'response cannot be serialised'); return; }
    const bytes = Buffer.byteLength(json);
    if (bytes > MAX_BYTES) { failedAt.set(key, now); setOutcome(db, endpoint, false, 'response is ' + (bytes / 1024).toFixed(0) + ' KB, bigger than the per-snapshot limit of ' + (MAX_BYTES / 1024).toFixed(0) + ' KB - NOT saved (raise HISTORY_MAX_KB)'); return; }
    const poolP = Promise.resolve().then(() => opts.getPool()).catch(() => null);   // evaluated NOW, inside the request: pinned to its container
    let sm = { text: null, rows: null }; try { sm = summarize(data); } catch (_) {}
    const it = { key, db, dbMeta: metaOf(db), endpoint, q, ts: now, json, bytes, src: fromCollector ? 'COLLECTOR' : 'BROWSER', poolP, summary: sm.text, rows: sm.rows, data, con: (() => { try { return (opts.conInfo && opts.conInfo()) || null; } catch (_) { return null; } })() };
    pending.add(key);
    const o = setOutcome(db, endpoint, true, 'saving');
    o.p = new Promise(r => { it.done = r; });
    enqueue(it);
  }

  app.use('/api/oracle', (req, res, next) => {
    if (req.method !== 'GET') return next();
    const endpoint = req.path.replace(/^\/+|\/+$/g, '');
    if (!endpoint || SKIP.test(endpoint) || EXTRA_SKIP.includes(endpoint)) return next();
    const q = Object.keys(req.query).filter(k => !IGNORE_Q.has(k)).sort().map(k => k + '=' + req.query[k]).join('&');
    const db = scope();
    const orig = res.json.bind(res);
    res.json = body => {
      try {
        if (res.statusCode < 400 && body && typeof body === 'object' && !body.error && !(typeof body.errors === 'string' && body.errors))   // NOTE: `errors` can be a DATA array (datapump) - an empty array is truthy in JS, so never test it with plain !body.errors
          record(db, endpoint, q, body, req.query._collector === '1');
      } catch (_) {}
      return orig(body);
    };
    next();
  });

  // history answers describe ONE database + container: never let a browser/proxy reuse them for another one
  // storage endpoints that are answered by history_store_postgres.js while PostgreSQL is selected (config / collect-now / collector / backend stay here)
  const ALT_ROUTES = new Set(['/endpoints', '/table-info', '/setup', '/prune', '/delete', '/at', '/data', '/verify', '/views-sql', '/detail-sql', '/backfill', '/make-readable']);
  app.use('/api/history', (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' }); res.removeHeader('ETag');
    if (mode() === 'postgres' && ALT_ROUTES.has(String(req.path).toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, ''))) return pgstore.router(req, res, next);
    next();
  });

  // the request is already pinned (database + container) by server.js, so the scope is simply the request's own
  const dbOf = () => scope();
  const dbErr = (res, e) => res.status(500).json({ error: errLine(e) });

  // ── table information (also used by the Create-table dialog) ──
  async function tableInfo(conn, sc, ov) {      // ov (optional) = owner typed in the Create-table dialog: describe THAT schema, not the saved one
    const who = (await conn.execute(SQL.who, {}, OBJ)).rows[0];
    const own = ov === undefined ? ownerName() : ov;
    const exists = ov === undefined ? await tableExists(conn, sc, true)
      : Number((await conn.execute(SQL.tableExists, { own: S(own || null), tn: S(TABLE) }, OBJ)).rows[0].CNT) > 0;
    const eff = own || String(who.CUR_SCHEMA || '');
    const info = { name: qual(eff), table: TABLE, owner: eff, configuredOwner: ownerName(), loginSchema: String(who.CUR_SCHEMA || ''), loginUser: String(who.SESS_USER || ''),
      container: String(who.CON_NAME || ''), conId: Number(who.CON_ID), exists, rows: 0, bytes: 0, maxBytes: MAX_BYTES_TOTAL, paused: false,
      loginIsSys: /^SYS(TEM)?$/i.test(String(who.CUR_SCHEMA || '')) };
    if (exists && ov === undefined) { usageBy.delete(sc); const u = await usageFor(conn, sc); info.rows = u.n; info.bytes = u.bytes; info.paused = u.paused; }
    else if (exists) { try { const r = (await conn.execute('SELECT NVL(SUM(PAYLOAD_BYTES), 0) AS BYTES, COUNT(*) AS N FROM ' + qual(eff), {}, OBJ)).rows[0]; info.rows = Number(r.N) || 0; info.bytes = Number(r.BYTES) || 0; } catch (_) {} }
    return info;
  }

  // catalog: every panel endpoint + whether it is recorded + what is stored for the current database/container
  app.get('/api/history/endpoints', async (req, res) => {
    const db = dbOf(req); let table = null, stats = {}, dberr = null;
    try {
      await withConn(async conn => {
        table = await tableInfo(conn, db);
        if (table.exists) for (const r of (await conn.execute(SQL.stats(), {}, OBJ)).rows) stats[r.PANEL_KEY] = r;
      });
    } catch (e) { dberr = errLine(e); }
    try {
      const names = [...new Set([...Object.keys(CATALOG), ...Object.keys(stats)])].sort((x, y) => (CATALOG[x] || x).localeCompare(CATALOG[y] || y));
      let totalBytes = 0;
      const out = names.map(ep => {
        const s = stats[ep], cnt = s ? Number(s.CNT) : 0, bytes = s ? Number(s.BYTES) : 0; totalBytes += bytes;
        return { endpoint: ep, label: CATALOG[ep] || ep, enabled: isOn(ep), keepDays: (cfg.keepDays && cfg.keepDays[ep]) || null, collectable: COLLECTABLE.has(ep), collect: COLLECTABLE.has(ep) && cfg.collect[ep] !== false,
          status: collectStatus[db + '|' + ep] || null, problem: (() => { const o = outcome.get(db + '|' + ep); return o && !o.ok ? { ts: o.ts, msg: o.why } : null; })(),
          readableViews: (viewInfo.get(db + '|' + ep) || []).map(v => ({ name: v.name, ok: v.ok, error: v.err || null })), detailTables: (detailInfo.get(db + '|' + ep) || []).map(v => ({ table: v.table, rows: v.rows, ok: v.ok, error: v.err || null })), snapshots: cnt, bytes, firstDay: s && s.MINTS ? dayStr(new Date(Number(s.MINTS))) : null, lastDay: s && s.MAXTS ? dayStr(new Date(Number(s.MAXTS))) : null };
      });
      res.json({ now: Date.now(), container: String(db).split('@')[1] || '', con: table ? { name: table.container, id: table.conId } : ((opts.conInfo && opts.conInfo()) || null),
        allContainers: !!cfg.collectAllContainers, collector: { enabled: cfg.collectEnabled, intervalMin: cfg.collectIntervalMin, running, lastPass, nextPass: Math.max(Date.now(), lastPass + cfg.collectIntervalMin * 60000) },
        collecting: running, keepDaysAll: cfg.keepDays || {}, retentionDays: RETENTION_DAYS, intervalMin: INTERVAL_MS / 60000, collectEnabled: cfg.collectEnabled, collectIntervalMin: cfg.collectIntervalMin,
        table, dbError: dberr, storage: { bytes: table ? table.bytes : totalBytes, maxBytes: MAX_BYTES_TOTAL, paused: !!(table && table.paused) }, store: storeInfo(), backend: 'oracle', endpoints: out });
    } catch (e) { dbErr(res, e); }
  });

  // ── Create-table: preview (GET) and execute (POST). Nothing is ever dropped; every statement is skipped if the object already exists ──
  app.get('/api/history/table-info', async (req, res) => {
    try {
      const o = String(req.query.owner === undefined ? ownerName() : req.query.owner).toUpperCase().trim();
      if (o && (!IDENT.test(o) || o.length > 128)) return res.status(400).json({ error: 'owner is not a valid Oracle identifier' });
      const info = await withConn(conn => tableInfo(conn, dbOf(req), req.query.owner === undefined ? undefined : o));
      const eff = o || info.loginSchema;
      let det = READABLE && !info.exists ? [mainViewSql(eff) + ';'] : []; if (info.exists) { try { det = await withConn(conn => DETAIL_ON ? detailScript(conn, eff) : (VIEWS_ON ? viewsScript(conn, eff) : [])); } catch (_) {} }
      res.json({ ...info, previewOwner: eff, sql: ddlStatements(eff).map(s => s + ';').concat(DETAIL_ON ? (READABLE ? [mainViewSql(eff) + ';'] : []) : [], det) });
    } catch (e) { dbErr(res, e); }
  });
  async function setupHere(sc, owner) {
    return withConn(async conn => {
      const who = (await conn.execute(SQL.who, {}, OBJ)).rows[0], steps = [];
      const eff = owner || String(who.CUR_SCHEMA || '');
      if (owner && owner !== String(who.CUR_SCHEMA)) {
        const u = await conn.execute(SQL.userExists, { u: S(owner) }, OBJ);
        if (!Number(u.rows[0].CNT)) throw new Error('schema ' + owner + ' does not exist in container ' + who.CON_NAME + ' - create it first or leave the owner empty');
      }
      const objs = [['table', TABLE], ['index', TABLE + '_IX1'], ['index', TABLE + '_IX2'], ['comment', null]];
      const stmts = ddlStatements(eff);
      for (let i = 0; i < stmts.length; i++) {
        const [kind, name] = objs[i];
        try {
          if (kind !== 'comment') {
            const ex = await conn.execute(kind === 'table' ? SQL.tableExists : SQL.indexExists, kind === 'table' ? { own: S(eff), tn: S(name) } : { own: S(eff), ix: S(name) }, OBJ);
            if (Number(ex.rows[0].CNT) > 0) { steps.push({ sql: stmts[i].split('\n')[0], status: 'exists' }); continue; }
          }
          await conn.execute(stmts[i], {}, { autoCommit: true });
          steps.push({ sql: stmts[i].split('\n')[0], status: kind === 'comment' ? 'done' : 'created' });
        } catch (e) { steps.push({ sql: stmts[i].split('\n')[0], status: 'error', error: errLine(e) }); if (kind === 'table') break; }
      }
      readyBy.delete(sc); ownerBy.delete(sc); clearDetailCache(sc);
      if (READABLE && !steps.some(s => s.status === 'error' && /CREATE TABLE/i.test(s.sql))) {      // a failed COMMENT / INDEX must not stop the views
        try { await makeReadable(conn, sc, eff, steps, 0); } catch (e) { steps.push({ sql: 'readable layer', status: 'error', error: errLine(e) }); }
      }
      tableOk.delete(sc); usageBy.delete(sc);
      for (const k of [...failedAt.keys()]) if (k.startsWith(sc + '|')) failedAt.delete(k);
      return { container: String(who.CON_NAME), owner: eff, steps, ok: !steps.some(s => s.status === 'error' && !/COMMENT ON/i.test(s.sql)) };
    });
  }
  function postSelf(p, body) {
    return new Promise(resolve => {
      const data = JSON.stringify(body || {});
      const rq = http.request({ host: '127.0.0.1', port: port(), path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 120000 }, resp => {
        let b = ''; resp.on('data', d => { if (b.length < 1e6) b += d; });
        resp.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve({ error: 'invalid response' }); } });
      });
      rq.on('timeout', () => { rq.destroy(); resolve({ error: 'timeout' }); });
      rq.on('error', e => resolve({ error: e.message }));
      rq.write(data); rq.end();
    });
  }
  // {owner?:'ORADECK', allContainers?:true}
  app.post('/api/history/setup', async (req, res) => {
    try {
      const b = req.body || {};
      if (b.owner !== undefined) {
        const o = String(b.owner || '').toUpperCase().trim();
        if (o && (!IDENT.test(o) || o.length > 128)) return res.status(400).json({ error: 'owner is not a valid Oracle identifier' });
        cfg.historySchema = o; saveCfg();
      }
      if (b.allContainers) {
        const ctxs = await collectContexts(true), results = [];
        for (const c of ctxs) {
          const r = await postSelf('/api/history/setup?_collector=1&dbId=' + encodeURIComponent(c.dbId) + '&container=' + encodeURIComponent(c.container), {});
          results.push(r.error ? { container: c.container, ok: false, error: r.error } : r);
        }
        return res.json({ ok: results.every(r => r.ok), results });
      }
      res.json(await setupHere(dbOf(req), ownerName()));
    } catch (e) { dbErr(res, e); }
  });


  // the CREATE VIEW script of the main view + one view per panel list, built from the newest snapshot of each panel (nothing is stored twice)
  async function viewsScript(conn, eff) {
    let wm = false, wv = false; try { const hv = new Set((await conn.execute(SQL.columns, { own: S(eff), tn: S(TABLE) }, OBJ)).rows.map(r => r.COLUMN_NAME)); wm = hv.has('DB_LABEL') && hv.has('DB_ROLE'); wv = hv.has('VIEW_NAMES'); } catch (_) {}
    const out = [mainViewSql(eff, undefined, wm) + ';', panelsViewSql(eff, wv).sql + ';'];
    const latest = await conn.execute('SELECT PANEL_KEY, MAX(SNAP_TS) AS TS FROM ' + qual(eff) + ' GROUP BY PANEL_KEY ORDER BY PANEL_KEY', {}, OBJ);
    for (const p of latest.rows) {
      if (/^__verify__/.test(p.PANEL_KEY)) continue;
      const r = await conn.execute('SELECT PAYLOAD FROM ' + qual(eff) + ' WHERE PANEL_KEY = :pk AND SNAP_TS = :ts FETCH FIRST 1 ROWS ONLY', { pk: S(p.PANEL_KEY), ts: N(p.TS) },
        { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchInfo: { PAYLOAD: { type: oracledb.STRING } } });
      if (!r.rows.length) continue;
      let data; try { data = JSON.parse(r.rows[0].PAYLOAD); } catch (_) { continue; }
      try { for (const sp of buildViews(p.PANEL_KEY, data, eff, wm)) out.push(sp.sql + ';'); } catch (_) {}
    }
    return out;
  }
  app.get('/api/history/views-sql', async (req, res) => {
    try {
      const text = await withConn(async conn => {
        const eff = ownerName() || await effOwner(conn), st = await viewsScript(conn, eff);
        return '-- OraDeck readable views: ONE real table (' + qual(eff) + '), one view per panel list with real columns. Generated from the newest snapshot of each panel.\n-- Run as the owner of the table. CREATE OR REPLACE = safe to run again. Needs the SUMMARY / ROW_COUNT columns for the main view (run oradeck_history_readable.sql first).\n-- Example: SELECT * FROM ' + VIEW_PREFIX + 'METRICS_WAITS WHERE SNAP_TIME > SYSTIMESTAMP - INTERVAL \'1\' DAY ORDER BY SNAP_ID, ROW_NO;\n\n' + st.join('\n\n') + '\n';
      });
      res.type('text/plain').send(text);
    } catch (e) { dbErr(res, e); }
  });
  // the CREATE script of all detail tables as plain text (run it yourself in SQL*Plus, like oradeck_history.sql)
  app.get('/api/history/detail-sql', async (req, res) => {
    try {
      const text = await withConn(async conn => {
        const eff = ownerName() || await effOwner(conn), st = await detailScript(conn, eff);
        return '-- OraDeck readable detail tables (one per panel list), generated from the newest snapshot of each panel.\n-- Run as the owner of ' + qual(eff) + '. Tables that exist already are listed as comments.\n\n' + st.join('\n\n') + '\n';
      });
      res.type('text/plain').send(text);
    } catch (e) { dbErr(res, e); }
  });

  app.get('/api/history/backfill', (req, res) => res.json(jobView(jobs.get(dbOf(req)))));
  app.post('/api/history/backfill', async (req, res) => {      // {stop:true} stops it; otherwise (re)starts it for this database/container
    try {
      const db = dbOf(req);
      if (req.body && req.body.stop) { const j = jobs.get(db); if (j) j.stop = true; return res.json({ ok: true, ...jobView(j) }); }
      const eff = await withConn(c => effOwner(c));
      res.json({ ok: true, ...jobView(startBackfill(db, eff, await opts.getPool())) });
    } catch (e) { dbErr(res, e); }
  });

  // make the stored history readable (idempotent): summary columns, main view, per-panel views, summaries of old snapshots. Nothing is deleted.
  app.post('/api/history/make-readable', async (req, res) => {
    try {
      const out = await withConn(async conn => {
        const db = dbOf(req), who = (await conn.execute(SQL.who, {}, OBJ)).rows[0], eff = ownerName() || String(who.CUR_SCHEMA || '');
        if (!(await tableExists(conn, db, true))) throw new Error('history table ' + qual(eff) + ' does not exist in container ' + who.CON_NAME + ' - Create table first');
        const steps = []; await makeReadable(conn, db, eff, steps, 0);
        return { container: String(who.CON_NAME), owner: eff, steps, ok: !steps.some(x => x.status === 'error') };
      });
      res.json(out);
    } catch (e) { dbErr(res, e); }
  });

  // retention: delete snapshots older than HISTORY_RETENTION_DAYS (small batches, so undo/redo stay small)
  app.post('/api/history/prune', async (req, res) => {
    try {
      const cut = Date.now() - RETENTION_DAYS * 86400000; let total = 0;
      await withConn(async conn => {
        if (!(await tableExists(conn, dbOf(req)))) return;
        for (let i = 0; i < 400; i++) {
          const r = await conn.execute(SQL.prune(), { cut: N(cut) }, { autoCommit: true });
          total += r.rowsAffected || 0; if ((r.rowsAffected || 0) < 5000) break;
        }
        for (const [pk, days] of Object.entries(cfg.keepDays || {})) {          // panels that are kept for fewer days than the normal retention
          if (!(days >= 1) || !CATALOG[pk]) continue;
          const pcut = Date.now() - days * 86400000;
          for (let i = 0; i < 400; i++) {
            const r = await conn.execute('DELETE FROM ' + tbl() + ' WHERE PANEL_KEY = :pk AND SNAP_TS < :cut AND ROWNUM <= 5000', { pk: S(pk), cut: N(pcut) }, { autoCommit: true });
            total += r.rowsAffected || 0; if ((r.rowsAffected || 0) < 5000) break;
          }
        }
        if (DETAIL_ON) {
          const eff = await effOwner(conn);
          for (const d of await detailTables(conn, eff, null)) {
            try { for (let i = 0; i < 400; i++) { const r = await conn.execute('DELETE FROM ' + vq(eff, d.table) + ' WHERE SNAP_TS < :cut AND ROWNUM <= 20000', { cut: N(cut) }, { autoCommit: true }); if ((r.rowsAffected || 0) < 20000) break; } }
            catch (e) { console.warn('[history] retention on ' + d.table + ': ' + errLine(e)); }
          }
        }
      });
      usageBy.delete(dbOf(req));
      res.json({ ok: true, deleted: total });
    } catch (e) { dbErr(res, e); }
  });

  // choose what is recorded: {endpoint:'sessions', enabled:false} or {endpoints:[...], enabled:true} or {all:true, enabled:false}
  app.post('/api/history/config', (req, res) => {
    const b = req.body || {}, en = !!b.enabled;
    if (b.master) {                                   // {master:true, collectEnabled:bool, collectIntervalMin:5|15|30|60}
      if (b.collectEnabled !== undefined) cfg.collectEnabled = !!b.collectEnabled;
      if (b.collectAllContainers !== undefined) cfg.collectAllContainers = !!b.collectAllContainers;
      if ([5, 15, 30, 60].includes(+b.collectIntervalMin)) cfg.collectIntervalMin = +b.collectIntervalMin;
      saveCfg(); return res.json({ ok: true });
    }
    if (b.keepDays !== undefined) {                   // {keepDays:true, endpoint:'sessions', days:7} (days 0/null = back to the normal retention)
      const ep = String(b.endpoint || ''), d = b.days == null ? 0 : +b.days;
      if (!CATALOG[ep]) return res.status(400).json({ error: 'unknown panel' });
      if (!(d === 0 || (Number.isInteger(d) && d >= 1 && d <= RETENTION_DAYS))) return res.status(400).json({ error: 'days must be a whole number from 1 to ' + RETENTION_DAYS + ' (0 = use the normal ' + RETENTION_DAYS + '-day retention)' });
      if (!cfg.keepDays || typeof cfg.keepDays !== 'object') cfg.keepDays = {};
      if (d) cfg.keepDays[ep] = d; else delete cfg.keepDays[ep];
      saveCfg(); return res.json({ ok: true, endpoint: ep, keepDays: d || null });
    }
    const list = b.all ? Object.keys(CATALOG) : (Array.isArray(b.endpoints) ? b.endpoints : (b.endpoint ? [b.endpoint] : []));
    if (!list.length) return res.status(400).json({ error: 'endpoint(s) required' });
    for (const ep of list) {
      if (b.collect !== undefined) { if (b.collect) delete cfg.collect[ep]; else cfg.collect[ep] = false; }
      else if (en) delete cfg.enabled[ep]; else cfg.enabled[ep] = false;
    }
    saveCfg(); res.json({ ok: true, changed: list.length });
  });

  // manual delete (current database/container only), EXACT to the millisecond range the browser sends (so time zones never matter)
  // {endpoint|everything:true, all:true} | {olderThanDays:N} | {fromTs:ms, toTs:ms}
  app.post('/api/history/delete', async (req, res) => {
    try {
      const b = req.body || {}, db = dbOf(req);
      if (!b.everything && !b.endpoint) return res.status(400).json({ error: 'endpoint required' });
      let lo = null, hi = null;
      if (b.all) { lo = -Infinity; hi = Infinity; }
      else if (b.olderThanDays != null) { if (!(+b.olderThanDays >= 0)) return res.status(400).json({ error: 'bad olderThanDays' }); lo = -Infinity; hi = Date.now() - (+b.olderThanDays) * 86400000; }
      else if (b.fromTs != null && b.toTs != null) { lo = +b.fromTs; hi = +b.toTs; if (!isFinite(lo) || !isFinite(hi)) return res.status(400).json({ error: 'bad time range' }); if (lo > hi) return res.status(400).json({ error: 'start is after end' }); }
      else return res.status(400).json({ error: 'scope required (all, olderThanDays, or fromTs+toTs)' });
      const where = [], binds = {};
      if (!b.everything) { where.push('PANEL_KEY = :pk'); binds.pk = S(String(b.endpoint)); }
      if (isFinite(lo)) { where.push('SNAP_TS >= :lo'); binds.lo = N(lo); }
      if (isFinite(hi)) { where.push('SNAP_TS <= :hi'); binds.hi = N(hi); }
      const r = await withConn(async conn => {
        if (!(await tableExists(conn, db))) return { rowsAffected: 0 };
        const res = await conn.execute('DELETE FROM ' + tbl() + (where.length ? ' WHERE ' + where.join(' AND ') : ''), binds, { autoCommit: true });
        if (DETAIL_ON) {      // the readable detail rows of the same panel / time range go too
          const eff = await effOwner(conn), tw = where.filter(w => !/^PANEL_KEY/.test(w)), tb = { ...binds }; delete tb.pk;
          for (const d of await detailTables(conn, eff, b.everything ? null : String(b.endpoint))) {
            try { await conn.execute('DELETE FROM ' + vq(eff, d.table) + (tw.length ? ' WHERE ' + tw.join(' AND ') : ''), tb, { autoCommit: true }); } catch (e) { console.warn('[history] delete on ' + d.table + ': ' + errLine(e)); }
          }
        }
        return res;
      });
      for (const [k] of last) if (k.startsWith(db + '|')) last.delete(k);
      usageBy.delete(db);
      res.json({ ok: true, removedSnapshots: r.rowsAffected || 0 });
    } catch (e) { dbErr(res, e); }
  });

  // ── DEEP panels: much more detail than the dashboard panels show (they only list the top 10-15 rows) ──
  // Read-only SELECTs on V$/DBA_ views, served as /api/oracle/deep/<name>. They go through the same snapshot hook and the same ONE table,
  // so they get their own per-panel views (ORADECK_V_DEEP_*) automatically. Switch off: HISTORY_DEEP=0 (or untick a panel in History Manager).
  // NOTE: deep/ash reads V$ACTIVE_SESSION_HISTORY (Diagnostics Pack licence, same as the existing ASH panel): HISTORY_DEEP_ASH=0 disables only that one.
  const DEEP_ROWS = +process.env.HISTORY_DEEP_ROWS || 300;
  const DEEP = {
    'deep/sessions': { label: 'Deep - Sessions (all active/recent)', sections: {
      sessions: `SELECT s.inst_id, s.sid, s.serial# AS serial_no, s.username, s.status, s.osuser, s.machine, SUBSTR(s.program,1,64) AS program, SUBSTR(s.module,1,64) AS module,
        s.sql_id, s.event, s.wait_class, s.seconds_in_wait, s.blocking_instance, s.blocking_session, TO_CHAR(s.logon_time,'YYYY-MM-DD HH24:MI:SS') AS logon_time, s.last_call_et
        FROM gv$session s WHERE s.type = 'USER' AND (s.status = 'ACTIVE' OR s.blocking_session IS NOT NULL OR s.last_call_et < 600)
        ORDER BY CASE s.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, s.last_call_et FETCH FIRST ${DEEP_ROWS} ROWS ONLY`,
      sessionCounts: `SELECT inst_id, NVL(username,'(none)') AS username, status, COUNT(*) AS sessions FROM gv$session WHERE type = 'USER' GROUP BY inst_id, username, status ORDER BY sessions DESC` ,
      sessionsByProgram: `SELECT inst_id, NVL(username,'(none)') AS username, machine, SUBSTR(program,1,48) AS program, COUNT(*) AS sessions FROM gv$session WHERE type = 'USER' GROUP BY inst_id, username, machine, SUBSTR(program,1,48) ORDER BY sessions DESC FETCH FIRST 60 ROWS ONLY` } },
    'deep/top-sql': { label: 'Deep - Top SQL (elapsed, gets, reads)', sections: {
      byElapsed: topSqlQ('elapsed_time', 50), byBufferGets: topSqlQ('buffer_gets', 30), byDiskReads: topSqlQ('disk_reads', 30) } },
    'deep/waits': { label: 'Deep - Wait events', sections: {
      events: `SELECT inst_id, event, wait_class, total_waits, total_timeouts, ROUND(time_waited_micro/1e6,2) AS time_waited_s, ROUND(time_waited_micro/NULLIF(total_waits,0)/1000,3) AS avg_wait_ms
        FROM gv$system_event WHERE wait_class <> 'Idle' ORDER BY time_waited_micro DESC FETCH FIRST 80 ROWS ONLY`,
      waitClasses: `SELECT inst_id, wait_class, total_waits, ROUND(time_waited_micro/1e6,2) AS time_waited_s FROM gv$system_wait_class WHERE wait_class <> 'Idle' ORDER BY time_waited_micro DESC` } },
    'deep/system-stats': { label: 'Deep - System statistics (load, commits, parses, IO)', sections: {
      sysstat: `SELECT inst_id, name AS stat_name, value AS stat_value FROM gv$sysstat WHERE name IN ('user commits','user rollbacks','execute count','parse count (total)','parse count (hard)',
        'session logical reads','physical reads','physical writes','physical read bytes','physical write bytes','redo size','redo writes','user calls','db block changes','sorts (memory)','sorts (disk)',
        'bytes sent via SQL*Net to client','bytes received via SQL*Net from client','logons cumulative','logons current','opened cursors current','table scans (long tables)','table fetch continued row',
        'CPU used by this session','DB time','background cpu time','enqueue waits','enqueue timeouts','transaction rollbacks','cell physical IO bytes eligible for predicate offload') ORDER BY inst_id, name`,
      osStat: `SELECT inst_id, stat_name, value AS stat_value FROM gv$osstat WHERE stat_name IN ('NUM_CPUS','LOAD','BUSY_TIME','IDLE_TIME','PHYSICAL_MEMORY_BYTES','FREE_MEMORY_BYTES','NUM_CPU_CORES') ORDER BY inst_id, stat_name`,
      loadProfile: `SELECT inst_id, metric_name, ROUND(value,3) AS metric_value, metric_unit FROM gv$sysmetric WHERE group_id = 2 ORDER BY inst_id, metric_name` } },
    'deep/storage': { label: 'Deep - Tablespaces, temp, datafile IO, undo', sections: {
      tablespaces: `SELECT m.tablespace_name, ROUND(m.used_space*t.block_size/1073741824,3) AS used_gb, ROUND(m.tablespace_size*t.block_size/1073741824,3) AS max_gb, ROUND(m.used_percent,2) AS pct_used
        FROM dba_tablespace_usage_metrics m JOIN dba_tablespaces t ON t.tablespace_name = m.tablespace_name ORDER BY m.used_percent DESC`,
      temp: `SELECT tablespace_name, ROUND(tablespace_size/1073741824,3) AS total_gb, ROUND(allocated_space/1073741824,3) AS allocated_gb, ROUND(free_space/1073741824,3) AS free_gb FROM dba_temp_free_space`,
      tempUsers: `SELECT inst_id, username, tablespace, segtype, COUNT(*) AS sessions, ROUND(SUM(blocks)*(SELECT TO_NUMBER(value) FROM v$parameter WHERE name='db_block_size')/1048576,1) AS used_mb
        FROM gv$tempseg_usage GROUP BY inst_id, username, tablespace, segtype ORDER BY used_mb DESC FETCH FIRST 50 ROWS ONLY`,
      datafileIo: `SELECT SUBSTR(df.name,1,120) AS file_name, fs.phyrds AS phys_reads, fs.phywrts AS phys_writes, ROUND(fs.readtim*10/NULLIF(fs.phyrds,0),2) AS avg_read_ms, ROUND(fs.writetim*10/NULLIF(fs.phywrts,0),2) AS avg_write_ms
        FROM v$filestat fs JOIN v$datafile df ON df.file# = fs.file# ORDER BY fs.phyrds + fs.phywrts DESC FETCH FIRST 60 ROWS ONLY`,
      undo: `SELECT inst_id, COUNT(*) AS transactions, SUM(used_ublk) AS used_undo_blocks, SUM(used_urec) AS used_undo_records FROM gv$transaction GROUP BY inst_id` } },
    'deep/locks': { label: 'Deep - Blocking & locks', sections: {
      blocking: `SELECT w.inst_id AS waiter_inst, w.sid AS waiter_sid, w.username AS waiter_user, w.sql_id AS waiter_sql, w.event, w.seconds_in_wait, w.blocking_instance AS blocker_inst, w.blocking_session AS blocker_sid,
        b.username AS blocker_user, SUBSTR(b.program,1,64) AS blocker_program, b.status AS blocker_status, b.sql_id AS blocker_sql, b.last_call_et AS blocker_idle_s
        FROM gv$session w LEFT JOIN gv$session b ON b.inst_id = w.blocking_instance AND b.sid = w.blocking_session WHERE w.blocking_session IS NOT NULL ORDER BY w.seconds_in_wait DESC FETCH FIRST 200 ROWS ONLY`,
      lockedObjects: `SELECT lo.inst_id, lo.session_id AS sid, lo.oracle_username, lo.os_user_name, o.owner, o.object_name, o.object_type, lo.locked_mode
        FROM gv$locked_object lo JOIN dba_objects o ON o.object_id = lo.object_id FETCH FIRST 200 ROWS ONLY` } },
    'deep/ash': { label: 'Deep - ASH last 5 min (SQL x wait)', off: process.env.HISTORY_DEEP_ASH === '0', sections: {
      ashTop: `SELECT sql_id, event, session_state, wait_class, COUNT(*) AS samples, COUNT(DISTINCT session_id) AS sessions, MAX(module) AS module
        FROM gv$active_session_history WHERE sample_time > SYSTIMESTAMP - INTERVAL '5' MINUTE GROUP BY sql_id, event, session_state, wait_class ORDER BY samples DESC FETCH FIRST 60 ROWS ONLY`,
      ashBlocking: `SELECT blocking_inst_id, blocking_session, sql_id, event, COUNT(*) AS samples, COUNT(DISTINCT session_id) AS waiting_sessions
        FROM gv$active_session_history WHERE sample_time > SYSTIMESTAMP - INTERVAL '5' MINUTE AND blocking_session IS NOT NULL GROUP BY blocking_inst_id, blocking_session, sql_id, event ORDER BY samples DESC FETCH FIRST 40 ROWS ONLY`,
      ashUsers: `SELECT u.username, a.session_state, COUNT(*) AS samples FROM gv$active_session_history a LEFT JOIN dba_users u ON u.user_id = a.user_id
        WHERE a.sample_time > SYSTIMESTAMP - INTERVAL '5' MINUTE GROUP BY u.username, a.session_state ORDER BY samples DESC FETCH FIRST 30 ROWS ONLY` } },
    'deep/memory': { label: 'Deep - Memory, connections limits', sections: {
      sga: `SELECT inst_id, name, ROUND(bytes/1048576,1) AS size_mb FROM gv$sgainfo WHERE name IN ('Buffer Cache Size','Shared Pool Size','Large Pool Size','Java Pool Size','Streams Pool Size','Maximum SGA Size','Free SGA Memory Available') ORDER BY inst_id, name`,
      pga: `SELECT inst_id, name, value, unit FROM gv$pgastat WHERE name IN ('total PGA allocated','total PGA inuse','maximum PGA allocated','aggregate PGA target parameter','cache hit percentage','over allocation count') ORDER BY inst_id, name`,
      topPga: `SELECT s.inst_id, s.sid, s.username, SUBSTR(s.program,1,64) AS program, s.sql_id, ROUND(p.pga_used_mem/1048576,1) AS pga_used_mb, ROUND(p.pga_alloc_mem/1048576,1) AS pga_alloc_mb
        FROM gv$process p JOIN gv$session s ON s.inst_id = p.inst_id AND s.paddr = p.addr WHERE s.type = 'USER' ORDER BY p.pga_alloc_mem DESC FETCH FIRST 30 ROWS ONLY`,
      resourceLimits: `SELECT inst_id, resource_name, current_utilization, max_utilization, limit_value FROM gv$resource_limit WHERE resource_name IN ('processes','sessions','transactions','enqueue_locks','enqueue_resources') ORDER BY inst_id, resource_name` } },
    'deep/redo-archive': { label: 'Deep - Redo switches, log groups, FRA', sections: {
      logSwitchesPerHour: `SELECT TO_CHAR(first_time,'YYYY-MM-DD HH24') AS hour, thread# AS thread_no, COUNT(*) AS switches FROM v$log_history WHERE first_time > SYSDATE - 1 GROUP BY TO_CHAR(first_time,'YYYY-MM-DD HH24'), thread# ORDER BY 1`,
      logGroups: `SELECT thread# AS thread_no, group# AS group_no, sequence# AS seq_no, ROUND(bytes/1048576) AS size_mb, members, status, archived FROM v$log ORDER BY thread#, group#`,
      fra: `SELECT name, ROUND(space_limit/1073741824,2) AS limit_gb, ROUND(space_used/1073741824,2) AS used_gb, ROUND(space_reclaimable/1073741824,2) AS reclaimable_gb, number_of_files FROM v$recovery_file_dest` } },
    'deep/long-ops': { label: 'Deep - Long running operations', sections: {
      longOps: `SELECT inst_id, sid, username, opname, target, sofar, totalwork, ROUND(sofar*100/NULLIF(totalwork,0),1) AS pct_done, elapsed_seconds, time_remaining, sql_id
        FROM gv$session_longops WHERE totalwork > 0 AND sofar < totalwork AND last_update_time > SYSDATE - 1/24 ORDER BY elapsed_seconds DESC FETCH FIRST 100 ROWS ONLY` } }
  };
  function topSqlQ(orderCol, n) {
    return `SELECT inst_id, sql_id, plan_hash_value, executions, ROUND(elapsed_time/1e6,2) AS elapsed_s, ROUND(cpu_time/1e6,2) AS cpu_s, buffer_gets, disk_reads, rows_processed, parse_calls,
      ROUND(elapsed_time/NULLIF(executions,0)/1000,2) AS avg_ms, TO_CHAR(last_active_time,'YYYY-MM-DD HH24:MI:SS') AS last_active, SUBSTR(sql_text,1,300) AS sql_text
      FROM gv$sqlstats ORDER BY ${orderCol} DESC FETCH FIRST ${n} ROWS ONLY`;
  }
  // ── UI-SQL panels: panels whose data the BROWSER fetches with POST /api/oracle/query (SQL typed in the dashboard code) are invisible to the snapshot hook (it only sees GET). ──
  // The same SELECTs are run here by the server, so Capacity Planning, Monitoring, Advisory, live tablespaces, DB info and DB time zone are saved too (also by the background collector).
  // Same statements as oracle_ai_dashboard.html; every section is read-only and isolated (one failing section does not stop the others). Switch off: HISTORY_UI=0 (or untick a panel in History Manager).
  if (process.env.HISTORY_UI !== '0') Object.assign(DEEP, {
    'ui/capacity': { label: 'Capacity Planning (all queries)', sections: {
      ts: `SELECT
  d.tablespace_name "TABLESPACE_NAME",
  d.status "STATUS",
  d.contents "CONTENTS",
  ROUND(NVL(a.bytes,0)/1024/1024/1024,3) "ALLOC_GB",
  ROUND((NVL(a.bytes,0)-NVL(f.bytes,0))/1024/1024/1024,3) "USED_GB",
  ROUND(NVL(f.bytes,0)/1024/1024/1024,3) "FREE_GB",
  ROUND(DECODE(NVL(a.bytes,0),0,0,(NVL(a.bytes,0)-NVL(f.bytes,0))/a.bytes*100),2) "USED_PCT",
  ROUND(NVL(m.maxbytes,NVL(a.bytes,0))/1024/1024/1024,3) "MAX_GB",
  ROUND(DECODE(NVL(m.maxbytes,a.bytes),0,0,(NVL(a.bytes,0)-NVL(f.bytes,0))/NVL(m.maxbytes,a.bytes)*100),2) "USED_PCT_OF_MAX"
FROM sys.dba_tablespaces d,
 (SELECT tablespace_name, SUM(bytes) bytes FROM dba_data_files GROUP BY tablespace_name) a,
 (SELECT tablespace_name, SUM(bytes) bytes FROM dba_free_space GROUP BY tablespace_name) f,
 (SELECT tablespace_name, SUM(GREATEST(NVL(maxbytes,0),bytes)) maxbytes FROM dba_data_files GROUP BY tablespace_name) m
WHERE d.tablespace_name = a.tablespace_name(+)
  AND d.tablespace_name = f.tablespace_name(+)
  AND d.tablespace_name = m.tablespace_name(+)
  AND d.contents != 'TEMPORARY'
ORDER BY "USED_PCT_OF_MAX" DESC NULLS LAST`,
      actual_used: `SELECT ROUND(SUM(bytes)/1024/1024/1024,2) "ACTUAL_USED_GB" FROM dba_segments`,
      awr_growth: `SELECT ts.name "TABLESPACE_NAME",
  TRUNC(sn.begin_interval_time) "SNAP_DATE",
  ROUND(MAX(u.tablespace_usedsize) * MAX(dt.block_size) /1024/1024/1024, 4) "USED_GB"
FROM dba_hist_tbsp_space_usage u
JOIN dba_hist_snapshot sn ON u.snap_id = sn.snap_id
JOIN v$tablespace ts ON u.tablespace_id = ts.ts#
JOIN dba_tablespaces dt ON dt.tablespace_name = ts.name
WHERE sn.begin_interval_time > SYSDATE - 30
GROUP BY ts.name, TRUNC(sn.begin_interval_time)
ORDER BY 1, 2`,
      db_growth: `SELECT TO_CHAR(creation_time,'RRRR-MM') "MONTH",
  TRUNC(SUM(bytes)/1024/1024/1024,2) "GROWTH_GB"
FROM v$datafile
GROUP BY TO_CHAR(creation_time,'RRRR-MM')
ORDER BY 1`,
      db_growth_custom: `select to_char(creation_time, 'RRRR Month') "Month", trunc(sum(bytes)/1024/1024/1024, 2) "Growth in GB" from v$datafile where creation_time > SYSDATE-360*2 group by to_char(creation_time, 'RRRR Month')`,
      fra: `SELECT name "FRA_LOCATION",
  ROUND(space_limit/1024/1024/1024,2) "LIMIT_GB",
  ROUND(space_used/1024/1024/1024,2) "USED_GB",
  ROUND(space_reclaimable/1024/1024/1024,2) "RECLAIMABLE_GB",
  ROUND(DECODE(space_limit,0,0,space_used/space_limit*100),2) "USED_PCT"
FROM v$recovery_file_dest`,
      resource_limit: `SELECT resource_name "RESOURCE",
  current_utilization "CURRENT_UTIL",
  max_utilization "PEAK_UTIL",
  limit_value "LIMIT_VAL"
FROM v$resource_limit
WHERE resource_name IN ('processes','sessions','transactions','enqueue_locks','enqueue_resources','dml_locks','ges_procs')
ORDER BY resource_name`,
      datafile_ceiling: `SELECT
  (SELECT COUNT(*) FROM dba_data_files) "DATAFILE_COUNT",
  (SELECT COUNT(*) FROM dba_temp_files) "TEMPFILE_COUNT",
  (SELECT TO_NUMBER(value) FROM v$parameter WHERE name='db_files') "MAX_DB_FILES"
FROM dual`,
      object_growth: `SELECT owner "OWNER",
  segment_name "OBJECT_NAME",
  MIN(REGEXP_REPLACE(segment_type, ' (SUB)?PARTITION$', '')) "OBJECT_TYPE",
  ROUND(SUM(bytes)/1024/1024/1024,3) "SIZE_GB"
FROM dba_segments
WHERE owner NOT IN ('SYS','SYSTEM','SYSAUX','OUTLN','DBSNMP','APPQOSSYS','GSMADMIN_INTERNAL',
  'GSMCATUSER','GSMUSER','MDSYS','ORDSYS','ORDDATA','ORDPLUGINS','SI_INFORMTN_SCHEMA','XDB','WMSYS',
  'CTXSYS','ANONYMOUS','DVSYS','DVF','LBACSYS','OLAPSYS','AUDSYS','OJVMSYS','REMOTE_SCHEDULER_AGENT',
  'GGSYS','DIP','ORACLE_OCM','XS$NULL','SYSBACKUP','SYSKM','SYSDG','SYSRAC')
GROUP BY owner, segment_name
ORDER BY SUM(bytes) DESC
FETCH FIRST 15 ROWS ONLY`,
      asm: `SELECT dg.name "DISKGROUP",
  dg.state "STATE",
  dg.type "REDUNDANCY",
  ROUND(dg.total_mb/1024,2) "TOTAL_GB",
  ROUND(dg.free_mb/1024,2) "FREE_GB",
  ROUND((dg.total_mb-dg.free_mb)/1024,2) "USED_GB",
  ROUND(DECODE(dg.total_mb,0,0,(dg.total_mb-dg.free_mb)/dg.total_mb*100),2) "USED_PCT",
  ROUND(dg.usable_file_mb/1024,2) "USABLE_FREE_GB",
  ROUND(DECODE(dg.total_mb,0,0,dg.usable_file_mb/dg.total_mb*100),2) "USABLE_FREE_PCT",
  ROUND(dg.required_mirror_free_mb/1024,2) "REQ_MIRROR_FREE_GB",
  (SELECT COUNT(*) FROM v$asm_disk d WHERE d.group_number = dg.group_number AND d.mode_status != 'ONLINE') "OFFLINE_DISKS"
FROM v$asm_diskgroup dg
ORDER BY 7 DESC`,
      partition_count: `SELECT table_owner "OWNER",
  table_name "TABLE_NAME",
  COUNT(*) "PARTITIONS"
FROM dba_tab_partitions
WHERE table_owner NOT IN ('SYS','SYSTEM','SYSAUX','OUTLN','DBSNMP','APPQOSSYS','GSMADMIN_INTERNAL',
  'GSMCATUSER','GSMUSER','MDSYS','ORDSYS','ORDDATA','ORDPLUGINS','SI_INFORMTN_SCHEMA','XDB','WMSYS',
  'CTXSYS','ANONYMOUS','DVSYS','DVF','LBACSYS','OLAPSYS','AUDSYS','OJVMSYS','REMOTE_SCHEDULER_AGENT',
  'GGSYS','DIP','ORACLE_OCM','XS$NULL','SYSBACKUP','SYSKM','SYSDG','SYSRAC')
GROUP BY table_owner, table_name
ORDER BY 3 DESC
FETCH FIRST 12 ROWS ONLY`,
      partition_new: `SELECT TO_CHAR(created,'RRRR-MM') "MONTH",
  COUNT(*) "NEW_PARTITIONS"
FROM dba_objects
WHERE object_type = 'TABLE PARTITION'
  AND created > ADD_MONTHS(SYSDATE,-6)
  AND owner NOT IN ('SYS','SYSTEM','SYSAUX','OUTLN','DBSNMP','APPQOSSYS','GSMADMIN_INTERNAL',
  'GSMCATUSER','GSMUSER','MDSYS','ORDSYS','ORDDATA','ORDPLUGINS','SI_INFORMTN_SCHEMA','XDB','WMSYS',
  'CTXSYS','ANONYMOUS','DVSYS','DVF','LBACSYS','OLAPSYS','AUDSYS','OJVMSYS','REMOTE_SCHEDULER_AGENT',
  'GGSYS','DIP','ORACLE_OCM','XS$NULL','SYSBACKUP','SYSKM','SYSDG','SYSRAC')
GROUP BY TO_CHAR(created,'RRRR-MM')
ORDER BY 1`,
      resource_snapshot: `SELECT 'CPU' "CATEGORY", 'CPU Cores' "METRIC", TO_NUMBER(value) "VAL", 'cores' "UNIT" FROM v$osstat WHERE stat_name='NUM_CPUS'
UNION ALL SELECT 'CPU','CPU Sockets', TO_NUMBER(value),'sockets' FROM v$osstat WHERE stat_name='NUM_CPU_SOCKETS'
UNION ALL SELECT 'CPU','Host CPU Utilization', val,'%' FROM (SELECT ROUND(value,2) val FROM v$sysmetric WHERE metric_name='Host CPU Utilization (%)' AND group_id=2 ORDER BY end_time DESC FETCH FIRST 1 ROW ONLY)
UNION ALL SELECT 'CPU','Database CPU Time Ratio', val,'%' FROM (SELECT ROUND(value,2) val FROM v$sysmetric WHERE metric_name='Database CPU Time Ratio' AND group_id=2 ORDER BY end_time DESC FETCH FIRST 1 ROW ONLY)
UNION ALL SELECT 'CPU','Load Average (1 min)', ROUND(value,2),'' FROM v$osstat WHERE stat_name='LOAD'
UNION ALL SELECT 'MEMORY','SGA Total (current)', ROUND(SUM(value)/1024/1024/1024,2),'GB' FROM v$sga
UNION ALL SELECT 'MEMORY','SGA Max Size', ROUND(TO_NUMBER(value)/1024/1024/1024,2),'GB' FROM v$parameter WHERE name='sga_max_size'
UNION ALL SELECT 'MEMORY','SGA Target', ROUND(TO_NUMBER(value)/1024/1024/1024,2),'GB' FROM v$parameter WHERE name='sga_target'
UNION ALL SELECT 'MEMORY','PGA Allocated (current)', ROUND(value/1024/1024/1024,2),'GB' FROM v$pgastat WHERE name='total PGA allocated'
UNION ALL SELECT 'MEMORY','PGA Aggregate Target', ROUND(TO_NUMBER(value)/1024/1024/1024,2),'GB' FROM v$parameter WHERE name='pga_aggregate_target'
UNION ALL SELECT 'MEMORY','PGA Aggregate Limit', ROUND(TO_NUMBER(value)/1024/1024/1024,2),'GB' FROM v$parameter WHERE name='pga_aggregate_limit'
UNION ALL SELECT 'MEMORY','Host Physical Memory', ROUND(value/1024/1024/1024,2),'GB' FROM v$osstat WHERE stat_name='PHYSICAL_MEMORY_BYTES'
UNION ALL SELECT 'MEMORY','Host Free Memory', ROUND(value/1024/1024/1024,2),'GB' FROM v$osstat WHERE stat_name='FREE_MEMORY_BYTES'
UNION ALL SELECT 'IO','Physical Reads (cum., blocks)', value,'blocks' FROM v$sysstat WHERE name='physical reads'
UNION ALL SELECT 'IO','Physical Writes (cum., blocks)', value,'blocks' FROM v$sysstat WHERE name='physical writes'
UNION ALL SELECT 'IO','Avg Single-Block Read Wait', ROUND(average_wait,3),'centisec' FROM v$system_event WHERE event='db file sequential read'
UNION ALL SELECT 'IO','Avg Multi-Block Read Wait', ROUND(average_wait,3),'centisec' FROM v$system_event WHERE event='db file scattered read'
UNION ALL SELECT 'IO','Redo Write Time (cum.)', value,'centisec' FROM v$sysstat WHERE name='redo write time'
UNION ALL SELECT 'WORKLOAD','User Commits (cum.)', value,'txns' FROM v$sysstat WHERE name='user commits'
UNION ALL SELECT 'WORKLOAD','User Rollbacks (cum.)', value,'txns' FROM v$sysstat WHERE name='user rollbacks'
UNION ALL SELECT 'WORKLOAD','Execute Count (cum.)', value,'execs' FROM v$sysstat WHERE name='execute count'
UNION ALL SELECT 'WORKLOAD','Session Logical Reads (cum.)', value,'blocks' FROM v$sysstat WHERE name='session logical reads'
UNION ALL SELECT 'WORKLOAD','Executions Per Sec', val,'/sec' FROM (SELECT ROUND(value,2) val FROM v$sysmetric WHERE metric_name='Executions Per Sec' AND group_id=2 ORDER BY end_time DESC FETCH FIRST 1 ROW ONLY)
UNION ALL SELECT 'WORKLOAD','User Transaction Per Sec', val,'/sec' FROM (SELECT ROUND(value,2) val FROM v$sysmetric WHERE metric_name='User Transaction Per Sec' AND group_id=2 ORDER BY end_time DESC FETCH FIRST 1 ROW ONLY)
UNION ALL SELECT 'WORKLOAD','Average Active Sessions', val,'AAS' FROM (SELECT ROUND(value,2) val FROM v$sysmetric WHERE metric_name='Average Active Sessions' AND group_id=2 ORDER BY end_time DESC FETCH FIRST 1 ROW ONLY)
UNION ALL SELECT 'WORKLOAD','DB Time', val,'sec/sec' FROM (SELECT ROUND(value,2) val FROM v$sysmetric WHERE metric_name='Database Time Per Sec' AND group_id=2 ORDER BY end_time DESC FETCH FIRST 1 ROW ONLY)`,
      top_cpu: `SELECT sql_id "SQL_ID",
  ROUND(cpu_time/1000000,2) "CPU_SEC",
  executions "EXECS",
  ROUND(cpu_time/GREATEST(executions,1)/1000,2) "AVG_CPU_MS",
  SUBSTR(sql_text,1,80) "SQL_TEXT"
FROM v$sqlarea
WHERE cpu_time > 0
ORDER BY cpu_time DESC
FETCH FIRST 8 ROWS ONLY`,
      backup: `SELECT TO_CHAR(start_time,'YYYY-MM-DD') "BACKUP_DATE",
  input_type "TYPE",
  ROUND(SUM(output_bytes)/1024/1024/1024,2) "SIZE_GB",
  ROUND(SUM(elapsed_seconds)/60,1) "DURATION_MIN",
  ROUND(SUM(output_bytes)/1024/1024/NULLIF(SUM(elapsed_seconds),0),2) "THROUGHPUT_MBPS"
FROM v$rman_backup_job_details
WHERE start_time > SYSDATE - 30
GROUP BY TO_CHAR(start_time,'YYYY-MM-DD'), input_type
ORDER BY 1 DESC
FETCH FIRST 15 ROWS ONLY`,
      dg_stats: `SELECT name "METRIC", value "VAL", unit "UNIT" FROM v$dataguard_stats`,
      db_host: `SELECT UTL_INADDR.get_host_address "HOST_IP", UTL_INADDR.get_host_name "HOST_NAME" FROM dual`,
      temp: `SELECT A.tablespace_name "TABLESPACE_NAME",
  ROUND(D.mb_total/1024,3) "ALLOC_GB",
  ROUND(SUM(A.used_blocks * D.block_size)/1024/1024/1024,3) "USED_GB",
  ROUND(DECODE(D.mb_total,0,0,(SUM(A.used_blocks*D.block_size)/1024/1024)/D.mb_total*100),2) "USED_PCT"
FROM v$sort_segment A,
 (SELECT B.name, C.block_size, SUM(C.bytes)/1024/1024 mb_total
  FROM v$tablespace B, v$tempfile C
  WHERE B.ts#= C.ts#
  GROUP BY B.name, C.block_size) D
WHERE A.tablespace_name = D.name
GROUP BY A.tablespace_name, D.mb_total
ORDER BY "USED_PCT" DESC NULLS LAST`,
      physical_db_size: `SELECT ROUND(
  (SELECT SUM(bytes)/1024/1024/1024 FROM v$datafile) +
  (SELECT SUM(bytes)/1024/1024/1024 FROM v$tempfile) +
  (SELECT SUM(bytes)/1024/1024/1024 FROM v$log) +
  (SELECT SUM(block_size*file_size_blks)/1024/1024/1024 FROM v$controlfile), 2
) AS PHYSICAL_SIZE_IN_GB FROM DUAL`,
    } },
    'ui/storage-live': { label: 'Storage - live tablespaces + temp', sections: {
      tablespaces: `SELECT d.status "STATUS", d.tablespace_name "TABLESPACE_NAME",
 TO_CHAR(NVL(a.bytes / 1024 / 1024 /1024, 0),'99,999,990.90') "SIZE_GB",
 TO_CHAR(NVL(a.bytes - NVL(f.bytes, 0), 0)/1024/1024 /1024,'99999999.99') "USED_GB",
 TO_CHAR(NVL(f.bytes / 1024 / 1024 /1024, 0),'99,999,990.90') "FREE_GB",
 TO_CHAR(NVL((a.bytes - NVL(f.bytes, 0)) / a.bytes * 100, 0), '990.00') "USED_PCT"
 FROM sys.dba_tablespaces d,
 (select tablespace_name, sum(bytes) bytes from dba_data_files group by tablespace_name) a,
 (select tablespace_name, sum(bytes) bytes from dba_free_space group by tablespace_name) f
 WHERE d.tablespace_name = a.tablespace_name(+)
   AND d.tablespace_name = f.tablespace_name(+)
   AND NOT (d.extent_management like 'LOCAL' AND d.contents like 'TEMPORARY')`,
      temp_tablespaces: `SELECT 'TEMPORARY' "STATUS", A.tablespace_name "TABLESPACE_NAME",
  D.mb_total/1024 "SIZE_GB",
  SUM(A.used_blocks * D.block_size)/1024/1024/1024 "USED_GB",
  (D.mb_total - SUM(A.used_blocks * D.block_size)/1024/1024)/1024 "FREE_GB",
  DECODE(D.mb_total,0,0,(SUM(A.used_blocks*D.block_size)/1024/1024)/D.mb_total*100) "USED_PCT"
FROM v$sort_segment A,
 (SELECT B.name, C.block_size, SUM(C.bytes)/1024/1024 mb_total
  FROM v$tablespace B, v$tempfile C
  WHERE B.ts#= C.ts#
  GROUP BY B.name, C.block_size) D
WHERE A.tablespace_name = D.name
GROUP BY A.tablespace_name, D.mb_total`,
    } },
    'ui/advisory': { label: 'Memory Advisory (SGA / PGA)', sections: {
      sga: `SELECT sga_size, sga_size_factor, estd_db_time FROM v$sga_target_advice`,
      pga: `SELECT pga_target_for_estimate, pga_target_factor, estd_extra_bytes_rw FROM v$pga_target_advice`,
      sga_components: `SELECT component, ROUND(current_size/1024/1024/1024,2) current_gb, ROUND(min_size/1024/1024/1024,2) min_gb, ROUND(max_size/1024/1024/1024,2) max_gb, last_oper_type FROM v$sga_dynamic_components ORDER BY current_size DESC`,
    } },
    'ui/db-timezone': { label: 'Database time zone', sections: {
      timezone: `SELECT
  DBTIMEZONE "DB_TIMEZONE",
  SESSIONTIMEZONE "SESSION_TIMEZONE",
  TO_CHAR(SYSTIMESTAMP,'YYYY-MM-DD HH24:MI:SS') "SERVER_LOCAL_TIME",
  TO_CHAR(SYSTIMESTAMP,'TZH:TZM') "SERVER_UTC_OFFSET",
  TO_CHAR(SYS_EXTRACT_UTC(SYSTIMESTAMP),'YYYY-MM-DD HH24:MI:SS') "UTC_TIME"
FROM DUAL`,
    } },
    'ui/monitoring': { label: 'Monitoring - session counts', sections: {
      active_sessions: `SELECT COUNT(*) AS CNT FROM gv$session WHERE status='ACTIVE'   AND username IS NOT NULL`,
      inactive_sessions: `SELECT COUNT(*) AS CNT FROM gv$session WHERE status='INACTIVE' AND username IS NOT NULL`,
      blocked_sessions: `SELECT COUNT(*) AS CNT FROM gv$session WHERE blocking_session IS NOT NULL`,
      active_distinct_sql: `SELECT COUNT(DISTINCT sql_id) AS CNT FROM gv$session WHERE status='ACTIVE' AND username IS NOT NULL`,
    } },
    'ui/dbinfo': { label: 'Database info (name, version, OS, CPU ...)', sections: {
      database_name: `SELECT name AS VALUE FROM v$database`,
      startup_time: `SELECT TO_CHAR(startup_time,'DD-MON-YYYY HH24:MI:SS') AS VALUE FROM v$instance`,
      database_version: `SELECT banner_full AS VALUE FROM v$version WHERE ROWNUM=1`,
      operating_system: `SELECT platform_name AS VALUE FROM v$database`,
      cpu_numbers: `SELECT value AS VALUE FROM v$osstat WHERE stat_name='NUM_CPUS'`,
      cluster_database: `SELECT value AS VALUE FROM v$parameter WHERE name='cluster_database'`,
      database_type_cdb: `SELECT cdb AS VALUE FROM v$database`,
      data_guard_configured: `SELECT CASE WHEN COUNT(*)>1 THEN 'YES' ELSE 'NO' END AS VALUE FROM v$dataguard_config`,
    } },
  });
  // ── The dashboard's ready-made query CARDS (Sessions, Monitoring, Health Check, Core Health Check): the user clicks a card and the browser sends its SQL with POST /api/oracle/query.
  // Parameter-free ones only (no SQL ID / object name typed by the user) - the same SELECTs are run by the server so their result is saved too. Switch off: HISTORY_UI_CARDS=0 (or untick the panel in History Manager).
  if (process.env.HISTORY_UI !== '0' && process.env.HISTORY_UI_CARDS !== '0') Object.assign(DEEP, {
    'ui/sessions-cards': { label: 'Sessions panel - query cards', titles: {
      blocking_chains: "Blocking Chains",
      locked_objects: "Locked Objects",
      check_locked_object: "Check Locked Object",
    }, sections: {
      blocking_chains: `SELECT s1.sid AS waiter, s1.username AS waiter_user,
  s2.sid AS holder, s2.username AS holder_user,
  s2.status AS holder_status, s2.seconds_in_wait AS hold_seconds,
  s2.sql_id AS holder_sql, s2.machine AS holder_machine,
  s2.program AS holder_program,
  COUNT(s1.sid) OVER (PARTITION BY s2.sid) AS waiters_behind
FROM gv$session s1, gv$session s2
WHERE s1.blocking_session = s2.sid
ORDER BY hold_seconds DESC`,
      locked_objects: `SELECT s.sid,
       o.object_name,
       o.object_type,
       l.locked_mode,
       s.machine,
       s.program,
       t.start_time transaction_start
FROM gv$session s,
     gv$locked_object l,
     dba_objects o,
     gv$transaction t
WHERE s.sid = l.session_id
AND l.object_id = o.object_id
AND s.taddr = t.addr
ORDER BY s.sid`,
      check_locked_object: `SELECT s.sid,
       o.object_name,
       o.object_type,
       l.locked_mode,
       s.machine,
       s.program,
       t.start_time transaction_start
FROM gv$session s,
     gv$locked_object l,
     dba_objects o,
     gv$transaction t
WHERE s.sid = l.session_id
AND l.object_id = o.object_id
AND s.taddr = t.addr
ORDER BY s.sid`,
    } },
    'ui/monitoring-cards': { label: 'Monitoring panel - query cards', titles: {
      hang_check: "Session Hang Check (v$sess_io)",
      session_monitor: "Session Monitoring",
      monitoring_summary: "Activity Summary",
      active_sessions: "Active Sessions Count",
      inactive_sessions: "Inactive Sessions Count",
    }, sections: {
      hang_check: `SELECT * FROM v$sess_io WHERE sid=0`,
      session_monitor: `SELECT DISTINCT s.username, s.inst_id, s.SID, s.serial#, s.osuser, s.machine, s.last_call_et,
  s.blocking_session, s.action, s.event, s.module, s.sql_id,
  q.hash_value, q.plan_hash_value, s.logon_time, s.row_wait_obj#, s.status,
  q.child_number, q.sql_text
FROM gv$sql q, gv$session s
WHERE s.sql_hash_value=q.hash_value(+)
  AND s.USERNAME IS NOT NULL
  AND s.username <> 'SYS'
  AND s.wait_class <> 'Idle'
  AND s.STATUS = 'ACTIVE'
ORDER BY s.last_call_et DESC`,
      monitoring_summary: `SELECT COUNT(1) AS CNT, sql_id, event, last_call_et, machine, sid FROM gv$session WHERE status='ACTIVE' AND username IS NOT NULL GROUP BY sql_id, event, last_call_et, machine, sid ORDER BY 1 DESC`,
      active_sessions: `SELECT COUNT(*) AS ACTIVE_SESSIONS FROM gv$session WHERE status='ACTIVE' AND username IS NOT NULL`,
      inactive_sessions: `SELECT COUNT(*) AS INACTIVE_SESSIONS FROM gv$session WHERE status='INACTIVE' AND username IS NOT NULL`,
    } },
    'ui/healthcheck': { label: 'Health Check - all cards', titles: {
      dict_stats: "Dictionary Table Stats (DBA_TABLES where owner=SYS)",
      fixed_obj_stats: "Fixed Object Statistics",
      stale_table_stats: "Stale Table Statistics (DBA_TAB_STATISTICS)",
      stale_index_stats: "Stale Index Statistics (DBA_IND_STATISTICS)",
      aud_size: "AUD$ Segment Size (MB)",
      table_degree: "Tables with Degree > 1",
      index_degree: "Indexes with Degree > 1",
      top10_segments: "Top 10 Large Segments",
      top_unused_tables: "Top 15 Unused Tables (no DML for 365+ days)",
      table_growth: "Table Growth (AWR, last 360 days)",
      invalid_objects: "Invalid Objects (by owner & type)",
      table_size: "Top 50 Table Sizes (GB)",
      index_frag: "Index Fragmentation (index > 34% of table, table > 100MB)",
      table_frag: "Table Fragmentation (wastage %, segments > 100MB)",
      top10_sql: "Top 10 Costly SQLs (last 24h, by elapsed time)",
      fts_sessions: "Active Sessions Performing Full Table Scan",
      fts_sqlplan: "Full Table Scan SQL IDs (gV$SQL_PLAN)",
      fts_ash: "Full Scan SQL IDs from Active Session History",
      db_time: "DB Time per AWR Snapshot (instance 3)",
      db_growth: "DB Growth by Month (last 2 years)",
      temp_ts: "Temp Tablespace Usage",
      redo_logs: "Redo Log Files",
      redo_log_file: "Redo Log File Detail",
      archive_gen: "Archive Log Generation (Hourly \u2014 Today)",
      datafiles: "Datafiles (v$dbfile)",
      controlfile_size: "Control File Size",
      actual_db_size: "Actual Database Size (GB)",
      total_db_size: "Total Physical Database Size (GB)",
      rman_status: "RMAN Backup Status (last 24h)",
      resource_limits: "Resource Limits",
      init_params: "Init Parameters",
      instance_status: "Instance Status",
      sys_config: "System Configuration Information",
    }, sections: {
      dict_stats: `SELECT NVL(TO_CHAR(last_analyzed,'YYYY-Mon-DD'),'NO STATS') LAST_ANALYZED,
  COUNT(*) DICTIONARY_TABLES
FROM dba_tables
WHERE owner='SYS'
GROUP BY TO_CHAR(last_analyzed,'YYYY-Mon-DD')
ORDER BY 1 DESC`,
      fixed_obj_stats: `SELECT NVL(TO_CHAR(last_analyzed,'YYYY-Mon-DD'),'NO STATS') LAST_ANALYZED,
  COUNT(*) FIXED_OBJECTS
FROM dba_tab_statistics
WHERE object_type='FIXED TABLE'
GROUP BY TO_CHAR(last_analyzed,'YYYY-Mon-DD')
ORDER BY 1 DESC`,
      stale_table_stats: `SELECT owner, table_name, stale_stats, last_analyzed
FROM dba_tab_statistics
WHERE stale_stats='YES'
ORDER BY owner, table_name`,
      stale_index_stats: `SELECT owner, table_name, index_name, stale_stats, last_analyzed
FROM dba_ind_statistics
WHERE stale_stats='YES'
ORDER BY owner, table_name, index_name`,
      aud_size: `SELECT ROUND(bytes/1024/1024,2) SIZE_MB, segment_name, owner
FROM dba_segments WHERE segment_name='AUD$'`,
      table_degree: `SELECT table_name, degree FROM dba_tables WHERE degree>'1' ORDER BY table_name`,
      index_degree: `SELECT owner, index_name, degree FROM dba_indexes WHERE degree>'1' ORDER BY owner, index_name`,
      top10_segments: `SELECT owner, segment_name, segment_type, gb FROM
  (SELECT owner, segment_name, 'TABLE' segment_type,
          ROUND(SUM(bytes)/1024/1024/1024) GB
   FROM dba_segments
   WHERE segment_type IN ('TABLE','TABLE PARTITION','TABLE SUBPARTITION','INDEX')
   AND owner NOT IN ('SYS','SYSTEM','SYSAUX','DBSNMP','XDB')
   GROUP BY owner, segment_name, segment_type
   ORDER BY 4 DESC)
WHERE ROWNUM<=10`,
      top_unused_tables: `SELECT unusedtab.*
FROM (SELECT TABLE_OWNER, TABLE_NAME, TIMESTAMP
      FROM all_tab_modifications a2
      WHERE a2.TABLE_OWNER NOT IN ('SYS','SYSTEM')
      AND a2.timestamp < SYSDATE-365
      ORDER BY timestamp ASC) unusedtab
WHERE ROWNUM<=15`,
      table_growth: `SELECT ds.tablespace_name, ds.segment_name, dobj.object_type,
  ROUND(SUM(dhss.space_used_delta)/1024/1024,2) "Growth_MB"
FROM dba_hist_snapshot snpshot,
     dba_hist_seg_stat dhss,
     dba_objects dobj,
     dba_segments ds
WHERE snpshot.begin_interval_time > TRUNC(SYSDATE)-360
AND snpshot.snap_id    = dhss.snap_id
AND dobj.object_id     = dhss.obj#
AND dobj.owner         = ds.owner
AND dobj.object_name   = ds.segment_name
AND ds.owner           = 'undefined'
AND ds.SEGMENT_NAME    IN ('undefined')
AND dobj.object_type   = 'TABLE'
GROUP BY ds.tablespace_name, ds.segment_name, dobj.object_type
ORDER BY 3 ASC`,
      invalid_objects: `SELECT COUNT(*) "INVALID_OBJECTS", OWNER, OBJECT_TYPE
FROM all_objects
WHERE status='INVALID'
GROUP BY owner, object_type
ORDER BY 2`,
      table_size: `SELECT * FROM (
  SELECT OWNER, SEGMENT_NAME AS TABLE_NAME,
         ROUND(SUM(BYTES)/1024/1024/1024,2) AS SIZE_GB
  FROM DBA_SEGMENTS
  WHERE SEGMENT_TYPE='TABLE'
  AND OWNER NOT IN ('SYS','SYSTEM')
  GROUP BY OWNER, SEGMENT_NAME
  ORDER BY 3 DESC)
WHERE ROWNUM<=50`,
      index_frag: `SELECT a.owner, c.segment_name TABLE_NAME, a.segment_name INDEX_NAME,
  ROUND(a.bytes/1024/1024,2) INDEX_SIZE_MB,
  ROUND(c.bytes/1024/1024,2) TABLE_SIZE_MB,
  ROUND((a.bytes/c.bytes)*100,2) PERCENTAGE
FROM dba_segments a, dba_indexes b, dba_segments c
WHERE a.segment_type='INDEX'
AND b.table_name  =c.segment_name
AND a.bytes        >c.bytes*0.34
AND c.segment_type ='TABLE'
AND a.owner        =c.owner
AND a.segment_name =b.index_name
AND a.owner        =b.owner
AND c.bytes/1024/1024>100
AND a.owner NOT IN ('SYS')
ORDER BY 6 DESC`,
      table_frag: `SELECT s.owner, s.segment_name TABLE_NAME,
  ROUND(BYTES/1024/1024,2) ACTUAL_SIZE_MB,
  ROUND(avg_row_len*num_rows/1024/1024,2) RIGHT_SIZE_MB,
  ROUND(((BYTES/1024/1024)-(avg_row_len*num_rows/1024/1024))*100/(BYTES/1024/1024),2) WASTAGE_PCT
FROM dba_segments s, dba_tables t
WHERE s.owner=t.owner
AND s.segment_name=t.table_name
AND s.segment_type='TABLE'
AND avg_row_len*num_rows/1024/1024<>0
AND BYTES/1024/1024>100
ORDER BY WASTAGE_PCT DESC`,
      top10_sql: `SELECT topsq.USERNAME, topsq.SQL_ID, topsq.MODULE
FROM (SELECT u.username, v.SQL_ID, v.module,
             SUM(ROUND(v.ELAPSED_TIME/3600000000*60,2)) ELAPSED_TIME_MINUTES
      FROM v$sql v
      LEFT JOIN dba_users u ON v.parsing_user_id=u.user_id
      WHERE TO_DATE(v.FIRST_LOAD_TIME,'yyyy-mm-dd hh24:mi:ss')>(TRUNC(SYSDATE,'DD')-INTERVAL '1' DAY)
      AND u.username NOT IN ('SYS','SYSTEM')
      GROUP BY u.username, SQL_ID, v.module
      ORDER BY 4 DESC) topsq
WHERE ROWNUM<=10`,
      fts_sessions: `SELECT DISTINCT s.username, s.inst_id, s.SID, s.serial#, s.osuser, s.machine,
  s.last_call_et, s.blocking_session, s.action, s.event, s.module, s.sql_id,
  q.hash_value, q.plan_hash_value, s.logon_time, s.row_wait_obj#, s.status,
  q.child_number, q.sql_text
FROM gv$sql q, gv$session s
WHERE s.sql_hash_value=q.hash_value(+)
AND s.status='ACTIVE'
AND s.username IS NOT NULL
AND s.USERNAME<>'SYS'
AND s.EVENT IN ('db file scattered read','direct path read')
ORDER BY s.last_call_et DESC`,
      fts_sqlplan: `SELECT sql_id, object_owner, object_name
FROM gV$SQL_PLAN
WHERE operation='TABLE ACCESS'
AND options='FULL'
AND object_owner NOT IN ('SYS','SYSTEM','DBSNMP')`,
      fts_ash: `SELECT DISTINCT sql_id
FROM gv$active_session_history
WHERE sql_plan_operation='TABLE ACCESS'
AND sql_plan_options='FULL'
AND ROWNUM<100`,
      db_time: `SELECT * FROM (
  SELECT A.INSTANCE_NUMBER,
         LAG(A.SNAP_ID) OVER(ORDER BY A.SNAP_ID) BEGIN_SNAP_ID,
         A.SNAP_ID END_SNAP_ID,
         TO_CHAR(B.BEGIN_INTERVAL_TIME,'DD-MON-YY HH24:MI') SNAP_BEGIN_TIME,
         TO_CHAR(B.END_INTERVAL_TIME,'DD-MON-YY HH24:MI') SNAP_END_TIME,
         ROUND((A.VALUE-LAG(A.VALUE) OVER(ORDER BY A.SNAP_ID))/1000000/60,2) DB_TIME_MIN
  FROM DBA_HIST_SYS_TIME_MODEL A, DBA_HIST_SNAPSHOT B
  WHERE A.SNAP_ID=B.SNAP_ID
  AND A.INSTANCE_NUMBER=B.INSTANCE_NUMBER
  AND A.STAT_NAME='DB time'
  AND A.instance_number=3)
WHERE DB_TIME_MIN IS NOT NULL
AND DB_TIME_MIN>0
ORDER BY 2 DESC`,
      db_growth: `SELECT TO_CHAR(creation_time,'RRRR Month') "Month",
  TRUNC(SUM(bytes)/1024/1024/1024,2) "Growth_GB"
FROM v$datafile
WHERE creation_time>SYSDATE-360*2
GROUP BY TO_CHAR(creation_time,'RRRR Month')
ORDER BY 1`,
      temp_ts: `SELECT A.tablespace_name TABLESPACE,
  D.mb_total,
  ROUND(SUM(A.used_blocks*D.block_size)/1024/1024,2) MB_USED,
  ROUND(D.mb_total-SUM(A.used_blocks*D.block_size)/1024/1024,2) MB_FREE
FROM v$sort_segment A,
  (SELECT B.name, C.block_size, ROUND(SUM(C.bytes)/1024/1024,2) mb_total
   FROM v$tablespace B, v$tempfile C
   WHERE B.ts#=C.ts#
   GROUP BY B.name, C.block_size) D
WHERE A.tablespace_name=D.name
GROUP BY A.tablespace_name, D.mb_total`,
      redo_logs: `SELECT vlf.member "MEMBER_NAME", vl.group# "Group",
  vl.status "Status", vl.archived "Archived",
  ROUND(vl.bytes/1024/1024,2) "Size_MB", vl.sequence# "Sequence"
FROM v$logfile vlf, v$log vl
WHERE vlf.group#=vl.group#
ORDER BY 1, vl.group#, vlf.member`,
      redo_log_file: `SELECT l.group# AS LOG_GROUP, l.thread# AS THREAD,
  l.sequence# AS LOG_SEQUENCE,
  ROUND(l.bytes/1024/1024,2) AS LOG_SIZE_MB,
  l.status AS LOG_STATUS, f.member AS LOG_FILE
FROM v$log l
JOIN v$logfile f ON l.group#=f.group#
ORDER BY l.group#`,
      archive_gen: `SELECT COUNT(1) COUNT,
  ROUND(SUM(blocks*block_size)/1024/1024/1024,3) "Size_GB",
  TO_CHAR(first_time,'dd-mm-yy HH24') "Date_Hour"
FROM v$archived_log
WHERE standby_dest='NO'
AND TRUNC(first_time)=TRUNC(SYSDATE)
GROUP BY TO_CHAR(first_time,'dd-mm-yy HH24')
ORDER BY TO_CHAR(first_time,'dd-mm-yy HH24')`,
      datafiles: `SELECT * FROM v$dbfile ORDER BY name`,
      controlfile_size: `SELECT name, ROUND(block_size*file_size_blks/1024/1024,2) "SIZE_MB"
FROM v$controlfile`,
      actual_db_size: `SELECT ROUND(SUM(bytes)/1024/1024/1024,2) "Actual_DB_Size_GB"
FROM dba_segments`,
      total_db_size: `SELECT ROUND(SUM(bytes)/1024/1024/1024,2) "Physical_DB_Size_GB"
FROM dba_data_files`,
      rman_status: `SELECT SESSION_KEY, INPUT_TYPE, STATUS,
  TO_CHAR(START_TIME,'mm/dd/yy hh24:mi') START_TIME,
  TO_CHAR(END_TIME,'mm/dd/yy hh24:mi') END_TIME,
  ROUND(ELAPSED_SECONDS/3600,2) HRS
FROM V$RMAN_BACKUP_JOB_DETAILS
WHERE start_time>SYSDATE-1
ORDER BY session_key`,
      resource_limits: `SELECT RESOURCE_NAME, CURRENT_UTILIZATION, MAX_UTILIZATION,
  INITIAL_ALLOCATION, LIMIT_VALUE
FROM V$RESOURCE_LIMIT
ORDER BY RESOURCE_NAME`,
      init_params: `SELECT name, value, ISSYS_MODIFIABLE
FROM v$parameter
ORDER BY name`,
      instance_status: `SELECT status FROM v$instance`,
      sys_config: `SELECT 'Database Name'       AS ITEM, name             AS VALUE FROM v$database
UNION ALL SELECT 'Platform',               platform_name               FROM v$database
UNION ALL SELECT 'DB Version',             BANNER_FULL                 FROM v$version WHERE ROWNUM=1
UNION ALL SELECT 'CPU Count',              value                       FROM v$osstat WHERE stat_name='NUM_CPUS'
UNION ALL SELECT 'Physical Memory',        ROUND(value/1024/1024/1024)||' GB' FROM v$osstat WHERE stat_name='PHYSICAL_MEMORY_BYTES'
UNION ALL SELECT 'SGA Max Size',           ROUND(value/1024/1024)||' MB'      FROM v$parameter WHERE name='sga_max_size'
UNION ALL SELECT 'Cluster Database',       value                       FROM v$parameter WHERE name='cluster_database'
UNION ALL SELECT 'Dataguard Unique Name',  DB_UNIQUE_NAME              FROM v$dataguard_config WHERE ROWNUM=1
UNION ALL SELECT 'Total DB Size',          ROUND(SUM(bytes)/1024/1024/1024)||' GB' FROM (SELECT bytes FROM v$datafile UNION ALL SELECT bytes FROM v$tempfile UNION ALL SELECT bytes FROM v$log)
UNION ALL SELECT 'Redo Log Size',          ROUND(bytes/1024/1024)||' MB'      FROM v$log WHERE ROWNUM=1
UNION ALL SELECT 'fast_start_mttr_target', value                       FROM v$parameter WHERE name='fast_start_mttr_target'`,
    } },
    'ui/corehealthcheck': { label: 'Core Health Check - all cards', titles: {
      chc_password_file_info: "Password File Info (GV$PASSWORDFILE_INFO)",
      chc_asm_parameters: "ASM Parameters",
      chc_asm_attributes: "ASM Attributes (compatible.advm/asm/rdbms, au_size)",
      chc_asm_diskgroup_usage: "ASM Diskgroup Usage",
      chc_asm_disk_usage: "ASM Disk Usage",
      chc_database_info: "Database Info (V$DATABASE + GV$INSTANCE)",
      chc_physical_size: "Physical Database Size (GB)",
      chc_logical_size: "Logical Size per Container (CDB_SEGMENTS)",
      chc_components: "DB Components (CDB_REGISTRY)",
      chc_timezone: "Time Zone / DST Info (CDB_PROPERTIES)",
      chc_controlfile: "Controlfile (Size & Retention)",
      chc_redolog_info: "Redolog Info (v$logfile + v$log)",
      chc_fra_usage: "FRA Usage (V$RECOVERY_FILE_DEST)",
      chc_archive_logs: "Archive Logs (last 7 days)",
      chc_invalid_objects_cdb: "Invalid Objects - SYS/SYSTEM (CDB_OBJECTS)",
      chc_users: "Non-Oracle Users (CDB_USERS)",
      chc_undo_usage: "Undo Usage per PDB",
      chc_temp_tablespace: "Temp Tablespace Usage",
      chc_permanent_tablespace: "Permanent Tablespace Usage per PDB",
      chc_autoextend_info: "Autoextend Info (CDB_DATA_FILES)",
      chc_top_tablespaces_by_files: "Top 20 Tablespaces by File Count (excl. CDB$ROOT)",
      chc_db_password_file: "DB Password File (GV$PASSWORDFILE_INFO)",
      chc_spfile: "SPFILE Path (GV$PARAMETER)",
      chc_all_parameters: "All Parameters (V$PARAMETER)",
      chc_listener_params: "Listener Parameters (local/remote listener, networks)",
      chc_patch_info: "Patch Info (CDB_REGISTRY_SQLPATCH)",
      chc_scheduler_jobs: "Scheduler Jobs (Scheduled & Enabled)",
      chc_feature_usage: "Feature Usage Statistics (CDB_FEATURE_USAGE_STATISTICS)",
      chc_alert_log_location: "Alert Log Location (V$DIAG_INFO)",
      chc_controlfile_retention: "Control File Retention Parameter",
      chc_fra_usage_detail: "FRA Usage Detail (V$FLASH_RECOVERY_AREA_USAGE)",
      chc_recovery_dest_info: "Recovery Destination Info (V$RECOVERY_FILE_DEST)",
      chc_autotask_client: "Autotask Client Status (DBA_AUTOTASK_CLIENT)",
    }, sections: {
      chc_password_file_info: `SELECT * FROM GV$PASSWORDFILE_INFO ORDER BY INST_ID`,
      chc_asm_parameters: `SELECT INST_ID, UPPER(NAME) AS PARAMETER_NAME, VALUE
FROM GV$PARAMETER
WHERE NAME IN ('asm_diskstring','asm_diskgroups','asm_power_limit','spfile')
ORDER BY NAME, INST_ID`,
      chc_asm_attributes: `SELECT UPPER(A.NAME) AS ATTRIBUTE_NAME, A.VALUE, A.GROUP_NUMBER, G.NAME
FROM V$ASM_ATTRIBUTE A, V$ASM_DISKGROUP G
WHERE A.GROUP_NUMBER = G.GROUP_NUMBER
AND A.NAME IN ('compatible.advm','compatible.asm','compatible.rdbms','au_size')
ORDER BY A.NAME, G.NAME`,
      chc_asm_diskgroup_usage: `SELECT DISTINCT NAME AS GROUP_NAME, VOTING_FILES, STATE,
  TYPE AS REDUNDANCY_TYPE,
  ROUND(TOTAL_MB/1024) TOTAL_GB,
  ROUND(FREE_MB/1024) AS FREE_GB,
  ROUND((TOTAL_MB - FREE_MB) / 1024) AS USED_GB,
  (ROUND((1 - (FREE_MB / TOTAL_MB))*100, 2) || ' %') AS UTILIZATION
FROM V$ASM_DISKGROUP
ORDER BY 7 DESC`,
      chc_asm_disk_usage: `SELECT G.NAME AS DISKGROUP_NAME, D.DISK_NUMBER, D.NAME,
  INST_ID AS MOUNTED_ON_INSTANCE_NO,
  D.MOUNT_STATUS, D.MODE_STATUS, D.STATE,
  ROUND(D.TOTAL_MB/1024) AS TOTAL_GB,
  ROUND(D.FREE_MB/1024) AS FREE_GB,
  ROUND((D.TOTAL_MB - D.FREE_MB) / 1024) AS USED_GB,
  (ROUND((1 - (D.FREE_MB/1024)/(D.TOTAL_MB/1024))*100, 2) || ' %') AS UTILIZATION
FROM GV$ASM_DISK D, V$ASM_DISKGROUP G
WHERE G.GROUP_NUMBER = D.GROUP_NUMBER
ORDER BY G.NAME, DISK_NUMBER, INST_ID`,
      chc_database_info: `SELECT A.NAME AS DATABASE_NAME, B.INSTANCE_NAME AS INSTANCE_NAME,
  B.HOST_NAME AS HOSTNAME,
  TO_CHAR(B.STARTUP_TIME,'DD-MON-YYYY HH24:MI') AS UPTIME,
  A.OPEN_MODE AS DATABASE_OPEN_MODE,
  A.DATABASE_ROLE AS DATABASE_ROLE,
  A.FLASHBACK_ON AS FLASHBACK,
  A.LOG_MODE AS LOGMODE,
  A.CDB AS CDB
FROM V$DATABASE A, GV$INSTANCE B
ORDER BY B.INSTANCE_NAME`,
      chc_physical_size: `SELECT ROUND(
  (SELECT SUM(bytes)/1024/1024/1024 FROM v$datafile) +
  (SELECT SUM(bytes)/1024/1024/1024 FROM v$tempfile) +
  (SELECT SUM(bytes)/1024/1024/1024 FROM v$log) +
  (SELECT SUM(block_size*file_size_blks)/1024/1024/1024 FROM v$controlfile), 2
) AS PHYSICAL_SIZE_IN_GB FROM DUAL`,
      chc_logical_size: `SELECT C.NAME, ROUND(SUM(BYTES)/1024/1024/1024, 2) LOGICAL_SIZE_IN_GB
FROM CDB_SEGMENTS S, V$CONTAINERS C
WHERE S.CON_ID = C.CON_ID
GROUP BY C.NAME
ORDER BY C.NAME`,
      chc_components: `SELECT C.NAME, COMP_ID, STATUS, VERSION, VERSION_FULL, COMP_NAME
FROM CDB_REGISTRY R, V$CONTAINERS C
WHERE R.CON_ID = C.CON_ID
ORDER BY C.NAME, COMP_ID`,
      chc_timezone: `SELECT C.NAME, PROPERTY_NAME, PROPERTY_VALUE
FROM CDB_PROPERTIES P, V$CONTAINERS C
WHERE PROPERTY_NAME IN ('DST_PRIMARY_TT_VERSION','DST_SECONDARY_TT_VERSION','DST_UPGRADE_STATE')
AND P.CON_ID = C.CON_ID
ORDER BY C.NAME, PROPERTY_NAME`,
      chc_controlfile: `SELECT C.NAME,
  (C.BLOCK_SIZE * C.FILE_SIZE_BLKS)/1024/1024 AS CONTROLFILE_SIZE_MB,
  R.VALUE AS RETENTION
FROM V$CONTROLFILE C,
  (SELECT VALUE FROM V$PARAMETER WHERE NAME='control_file_record_keep_time') R`,
      chc_redolog_info: `SELECT L.THREAD#, LF.GROUP#, LF.MEMBER,
  TRUNC(L.BYTES/1024/1024) AS SIZE_MB,
  LF.STATUS, LF.TYPE
FROM V$LOGFILE LF
JOIN V$LOG L ON L.GROUP# = LF.GROUP#
ORDER BY L.THREAD#, LF.GROUP#, LF.MEMBER`,
      chc_fra_usage: `SELECT A.NAME AS FRA_LOCATION,
  ROUND((A.SPACE_LIMIT/1024/1024/1024), 2) AS FRA_IN_GB,
  ROUND((A.SPACE_USED/1024/1024/1024), 2) AS FRA_USED_IN_GB,
  ROUND((A.SPACE_RECLAIMABLE/1024/1024/1024), 2) AS FRA_RECLAIMABLE_GB,
  SUM(B.PERCENT_SPACE_USED) AS PERCENT_OF_SPACE_USED
FROM V$RECOVERY_FILE_DEST A, V$FLASH_RECOVERY_AREA_USAGE B
GROUP BY SPACE_LIMIT, SPACE_USED, SPACE_RECLAIMABLE, NAME`,
      chc_archive_logs: `SELECT TO_CHAR(COMPLETION_TIME,'DD-MON-YYYY') AS DATE_OF_ARCHIVE_GENERATION,
  THREAD#,
  ROUND(SUM(BLOCKS*BLOCK_SIZE)/1024/1024) AS SIZE_IN_MB,
  COUNT(*) AS ARCHIVES_GENERATED
FROM V$ARCHIVED_LOG
WHERE STATUS='A'
AND COMPLETION_TIME > SYSDATE - 7
GROUP BY TO_CHAR(COMPLETION_TIME,'DD-MON-YYYY'), THREAD#
ORDER BY TO_CHAR(COMPLETION_TIME,'DD-MON-YYYY'), THREAD#`,
      chc_invalid_objects_cdb: `SELECT C.NAME, OWNER, OBJECT_TYPE, COUNT(OBJECT_NAME) AS OBJECT_COUNT
FROM CDB_OBJECTS O, V$CONTAINERS C
WHERE OWNER IN ('SYS','SYSTEM')
AND STATUS = 'INVALID'
AND O.CON_ID = C.CON_ID
GROUP BY C.NAME, OWNER, OBJECT_TYPE
ORDER BY C.NAME, OWNER, OBJECT_TYPE`,
      chc_users: `SELECT C.NAME, USERNAME, ACCOUNT_STATUS,
  TO_CHAR(CREATED,'DD-MON-YYYY HH24:MI') AS CREATED_DATE,
  TO_CHAR(LOCK_DATE,'DD-MON-YYYY HH24:MI') AS LOCK_DATE,
  TO_CHAR(EXPIRY_DATE,'DD-MON-YYYY HH24:MI') AS EXPIRY_DATE,
  TO_CHAR(LAST_LOGIN,'DD-MON-YYYY HH24:MI') AS LAST_LOGIN,
  PROFILE, PASSWORD_VERSIONS
FROM CDB_USERS U, V$CONTAINERS C
WHERE U.CON_ID = C.CON_ID
AND ORACLE_MAINTAINED = 'N'
ORDER BY C.NAME, USERNAME`,
      chc_undo_usage: `SELECT C.NAME, A.TABLESPACE_NAME,
  SIZEMB AS SIZE_MB, USAGEMB AS USAGE_MB,
  (SIZEMB - USAGEMB) FREE_MB,
  LPAD(TO_CHAR(ROUND((USAGEMB/SIZEMB)*100, 2), '990.99') || ' %', 10) AS USED_PERCENTAGE
FROM
  (SELECT B.CON_ID, SUM(BYTES)/1024/1024 SIZEMB, B.TABLESPACE_NAME
   FROM CDB_DATA_FILES A, CDB_TABLESPACES B
   WHERE A.TABLESPACE_NAME = B.TABLESPACE_NAME
   AND A.CON_ID = B.CON_ID
   AND B.CONTENTS LIKE 'UNDO'
   GROUP BY B.CON_ID, B.TABLESPACE_NAME) A,
  (SELECT C2.CON_ID, C2.TABLESPACE_NAME, SUM(BYTES)/1024/1024 USAGEMB
   FROM CDB_UNDO_EXTENTS C2
   WHERE STATUS <> 'EXPIRED'
   GROUP BY C2.CON_ID, C2.TABLESPACE_NAME) B,
  V$CONTAINERS C
WHERE A.TABLESPACE_NAME = B.TABLESPACE_NAME
AND A.CON_ID = B.CON_ID
AND A.CON_ID = C.CON_ID
ORDER BY A.CON_ID, TABLESPACE_NAME`,
      chc_temp_tablespace: `SELECT A.TABLESPACE_NAME, D.MB_TOTAL,
  SUM(A.USED_BLOCKS * D.BLOCK_SIZE) / 1024 / 1024 MB_USED,
  D.MB_TOTAL - SUM(A.USED_BLOCKS * D.BLOCK_SIZE) / 1024 / 1024 MB_FREE
FROM V$SORT_SEGMENT A,
  (SELECT B.NAME, C.BLOCK_SIZE, SUM(C.BYTES)/1024/1024 MB_TOTAL
   FROM V$TABLESPACE B, V$TEMPFILE C
   WHERE B.TS# = C.TS#
   GROUP BY B.NAME, C.BLOCK_SIZE) D
WHERE A.TABLESPACE_NAME = D.NAME
GROUP BY A.TABLESPACE_NAME, D.MB_TOTAL
ORDER BY TABLESPACE_NAME`,
      chc_permanent_tablespace: `SELECT C.NAME, D.STATUS, D.TABLESPACE_NAME,
  TO_CHAR(NVL(A.BYTES/1024/1024/1024, 0),'99,999,999.90') AS SIZE_GB,
  TO_CHAR(NVL(A.BYTES - NVL(F.BYTES,0),0)/1024/1024/1024,'99,999,999.90') AS USED_GB,
  TO_CHAR(NVL(F.BYTES/1024/1024/1024, 0),'99,999,999.90') AS FREE_GB,
  TO_CHAR(NVL((A.BYTES - NVL(F.BYTES, 0)) / A.BYTES * 100, 0), '999.00') AS USED_IN_PERCENT
FROM SYS.CDB_TABLESPACES D,
  (SELECT CON_ID, TABLESPACE_NAME, SUM(BYTES) BYTES FROM CDB_DATA_FILES GROUP BY CON_ID, TABLESPACE_NAME) A,
  (SELECT CON_ID, TABLESPACE_NAME, SUM(BYTES) BYTES FROM CDB_FREE_SPACE GROUP BY CON_ID, TABLESPACE_NAME) F,
  V$CONTAINERS C
WHERE D.TABLESPACE_NAME = A.TABLESPACE_NAME
AND D.TABLESPACE_NAME = F.TABLESPACE_NAME
AND D.CON_ID = A.CON_ID
AND D.CON_ID = F.CON_ID
AND D.CON_ID = C.CON_ID
AND D.CONTENTS = 'PERMANENT'
ORDER BY C.NAME, D.TABLESPACE_NAME`,
      chc_autoextend_info: `SELECT C.NAME, TABLESPACE_NAME, AUTOEXTENSIBLE,
  SUM(BYTES/1024/1024) AS SIZE_MB,
  COUNT(FILE_NAME) AS FILE_COUNT
FROM CDB_DATA_FILES D, V$CONTAINERS C
WHERE D.CON_ID = C.CON_ID
GROUP BY C.NAME, TABLESPACE_NAME, AUTOEXTENSIBLE
ORDER BY C.NAME, AUTOEXTENSIBLE, TABLESPACE_NAME`,
      chc_top_tablespaces_by_files: `SELECT C.NAME, TABLESPACE_NAME, COUNT(FILE_NAME) AS NUMBER_OF_FILES
FROM CDB_DATA_FILES D, V$CONTAINERS C
WHERE D.CON_ID = C.CON_ID
AND C.CON_ID != 1
GROUP BY C.NAME, TABLESPACE_NAME
ORDER BY COUNT(FILE_NAME) DESC, TABLESPACE_NAME, C.NAME
FETCH FIRST 20 ROWS ONLY`,
      chc_db_password_file: `SELECT INST_ID, FILE_NAME, FORMAT, IS_ASM
FROM GV$PASSWORDFILE_INFO
ORDER BY INST_ID`,
      chc_spfile: `SELECT INST_ID, NAME, VALUE
FROM GV$PARAMETER
WHERE NAME = 'spfile'
ORDER BY INST_ID`,
      chc_all_parameters: `SELECT NAME, VALUE, ISSES_MODIFIABLE, ISSYS_MODIFIABLE, ISINSTANCE_MODIFIABLE
FROM V$PARAMETER
ORDER BY NAME`,
      chc_listener_params: `SELECT INST_ID, UPPER(NAME) AS PARAMETER_NAME, VALUE
FROM GV$PARAMETER
WHERE NAME IN ('local_listener','remote_listener','listener_networks')
ORDER BY NAME, INST_ID`,
      chc_patch_info: `SELECT C.NAME, INSTALL_ID, PATCH_ID, PATCH_TYPE, ACTION, STATUS,
  TO_CHAR(ACTION_TIME, 'DD-MON-YYYY HH24:MI:SS') AS APPLIED_TIME,
  DESCRIPTION
FROM CDB_REGISTRY_SQLPATCH P, V$CONTAINERS C
WHERE P.CON_ID = C.CON_ID
ORDER BY P.CON_ID, INSTALL_ID`,
      chc_scheduler_jobs: `SELECT C.NAME, OWNER, JOB_NAME, STATE, ENABLED, FAILURE_COUNT, RUN_COUNT,
  TO_CHAR(LAST_START_DATE, 'DD-MON-YYYY HH24:MI') AS LAST_START_DATE,
  TO_CHAR(NEXT_RUN_DATE, 'DD-MON-YYYY HH24:MI') AS NEXT_RUN_DATE
FROM CDB_SCHEDULER_JOBS S, V$CONTAINERS C
WHERE STATE = 'SCHEDULED'
AND S.CON_ID = C.CON_ID
AND ENABLED = 'TRUE'
ORDER BY S.CON_ID, OWNER, JOB_NAME`,
      chc_feature_usage: `SELECT C.NAME, F.NAME AS FEATURE, VERSION, DETECTED_USAGES,
  CURRENTLY_USED, FIRST_USAGE_DATE, LAST_USAGE_DATE
FROM CDB_FEATURE_USAGE_STATISTICS F, V$CONTAINERS C
WHERE DETECTED_USAGES NOT IN (0)
AND F.CON_ID = C.CON_ID
ORDER BY F.CON_ID, C.NAME`,
      chc_alert_log_location: `SELECT VALUE FROM V$DIAG_INFO WHERE NAME LIKE 'Diag Trace'`,
      chc_controlfile_retention: `SELECT VALUE FROM V$PARAMETER WHERE NAME = 'control_file_record_keep_time'`,
      chc_fra_usage_detail: `SELECT * FROM V$FLASH_RECOVERY_AREA_USAGE`,
      chc_recovery_dest_info: `SELECT * FROM V$RECOVERY_FILE_DEST`,
      chc_autotask_client: `SELECT client_name, status FROM dba_autotask_client ORDER BY client_name`,
    } },
  });
  // SQL Queries panel: the cards that need NO typed input (SQL ID / object / time range); the others cannot run by themselves.
  if (process.env.HISTORY_UI !== '0' && process.env.HISTORY_UI_CARDS !== '0') Object.assign(DEEP, {
    'ui/sqlqueries': { label: 'SQL Queries panel - cards without input', titles: {
      top_cpu: "Top CPU Consumers (Live)",
      high_version: "High Version Count SQL",
      top_temp_live: "Top Temp Consumers (Live Sessions)",
      top_pga_live: "Top PGA Consumers (Live Sessions)",
    }, sections: {
      top_cpu: `SELECT s.sid,
       s.serial#,
       s.username,
       s.sql_id,
       st.value cpu_usage,
       s.last_call_et secs_running,
       sq.sql_text
FROM v$session s,
     v$sesstat st,
     v$statname sn,
     v$sqlstats sq
WHERE s.sid = st.sid
AND st.statistic# = sn.statistic#
AND sn.name = 'CPU used by this session'
AND s.sql_id = sq.sql_id
AND s.status = 'ACTIVE'
AND s.username IS NOT NULL
ORDER BY st.value DESC
FETCH FIRST 5 ROWS ONLY`,
      high_version: `SELECT sql_id,
       version_count,
       executions,
       round(sharable_mem/1024/1024,2) mem_mb,
       sql_text
FROM v$sqlarea
WHERE version_count > 100
ORDER BY version_count DESC
FETCH FIRST 10 ROWS ONLY`,
      top_temp_live: `SELECT *
FROM (
    SELECT s.sid,
           s.serial#,
           s.username,
           u.tablespace,
           ROUND(u.blocks * (SELECT value FROM v$parameter WHERE name = 'db_block_size') / 1024 / 1024) AS temp_mb,
           s.sql_id,
           q.sql_text
    FROM   v$session s,
           v$sort_usage u,
           v$sql q
    WHERE  s.saddr = u.session_addr
    AND    s.sql_id = q.sql_id (+)
    ORDER  BY temp_mb DESC
)
WHERE ROWNUM <= 10`,
      top_pga_live: `SELECT *
FROM (
    SELECT s.sid,
           s.serial#,
           s.username,
           p.spid AS os_pid,
           ROUND(p.pga_used_mem / 1024 / 1024) AS pga_used_mb,
           ROUND(p.pga_alloc_mem / 1024 / 1024) AS pga_alloc_mb,
           ROUND(p.pga_max_mem / 1024 / 1024) AS pga_max_mb,
           s.sql_id,
           q.sql_text
    FROM   v$session s,
           v$process p,
           v$sql q
    WHERE  s.paddr = p.addr
    AND    s.sql_id = q.sql_id (+)
    AND    s.type = 'USER'
    ORDER  BY pga_used_mb DESC
)
WHERE ROWNUM <= 10`,
    } },
  });
  if (process.env.HISTORY_DEEP !== '0') for (const [ep, def] of Object.entries(DEEP)) {
    CATALOG[ep] = def.label;
    if (!def.off) COLLECTABLE.add(ep);
    app.get('/api/oracle/' + ep, async (req, res) => {
      if (def.off) return res.status(404).json({ error: 'disabled' });
      try {
        const out = {}, notes = [];
        await withConn(async conn => {
          try { conn.callTimeout = /^ui\//.test(ep) ? 40000 : 25000; } catch (_) {}
          for (const [name, sql] of Object.entries(def.sections)) {
            try { out[name] = (await conn.execute(sql, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: DEEP_MAX_ROWS })).rows; }
            catch (e) { out[name] = []; notes.push({ section: name, error: errLine(e) }); }
          }
        });
        if (notes.length === Object.keys(def.sections).length) return res.status(500).json({ error: notes[0].error + ' (' + ep + ': no section could be read - needs SELECT on V$/DBA_ views)' });
        if (def.titles) out.titles = def.titles;
        if (notes.length) out.notes = notes;
        res.json(out);
      } catch (e) { res.status(500).json({ error: errLine(e) }); }
    });
  }

  // ── background collector: the server itself calls the panel endpoints, so history is saved even when no browser is open ──
  let running = false, lastPass = lastPassPersisted;
  const lastPrune = new Map();
  function callSelf(ep, dbId, qs, container) {
    return new Promise(resolve => {
      const r = http.get({ host: '127.0.0.1', port: port(), path: '/api/oracle/' + ep + '?_collector=1&dbId=' + encodeURIComponent(dbId) + (container ? '&container=' + encodeURIComponent(container) : '') + (qs ? '&' + qs : ''), timeout: 120000 }, resp => {
        let body = ''; resp.on('data', d => { if (body.length < 4e6) body += d; });
        resp.on('end', () => {
          let msg = ''; try { const j = JSON.parse(body); if (j && j.error) msg = String(j.error).slice(0, 200); } catch (_) { msg = 'invalid response'; }
          resolve({ ok: resp.statusCode < 400 && !msg, msg: msg || ('HTTP ' + resp.statusCode), body });
        });
      });
      r.on('timeout', () => { r.destroy(); resolve({ ok: false, msg: 'timeout' }); });
      r.on('error', e => resolve({ ok: false, msg: e.message }));
    });
  }
  function getJson(p) {
    return new Promise(resolve => {
      const rq = http.get({ host: '127.0.0.1', port: port(), path: p, timeout: 30000 }, resp => {
        let body = ''; resp.on('data', d => { if (body.length < 2e6) body += d; });
        resp.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { resolve(null); } });
      });
      rq.on('timeout', () => { rq.destroy(); resolve(null); });
      rq.on('error', () => resolve(null));
    });
  }
  // which database/container(s) one pass collects: the globally selected one, or - if switched on (or forced) - CDB$ROOT + every open PDB
  async function baseContexts(forceAll) {
    const base = opts.collectorCtx ? opts.collectorCtx() : { dbId: currentDbId(), container: '' };
    if ((!cfg.collectAllContainers && !forceAll) || !opts.scopeOf) return [base];
    const j = await getJson('/api/oracle/pdbs-live?_collector=1&container=__cdb__&dbId=' + encodeURIComponent(base.dbId));
    if (!j || !j.isCDB || !Array.isArray(j.pdbs)) return [base];
    const list = [{ dbId: base.dbId, container: '__cdb__' }];
    for (const p of j.pdbs) if (/^READ (WRITE|ONLY)$/i.test(p.open_mode || '')) list.push({ dbId: base.dbId, container: p.service || String(p.name).toLowerCase() });
    if (!list.some(c => opts.scopeOf(c.dbId, c.container) === opts.scopeOf(base.dbId, base.container))) list.push(base);
    return list;
  }
  // + every OTHER database that is ticked in "Databases to store" (the server answers a request for any registered database through its own pool: ?dbId=...),
  //   so the background collector no longer follows only the database that is selected in the dashboard. Unticked databases are never collected.
  async function collectContexts(forceAll) {
    const list = await baseContexts(forceAll);
    if (!Array.isArray(cfg.dbAllow) || !cfg.dbAllow.length || process.env.HISTORY_COLLECT_ACTIVE_ONLY === '1') return list;
    const j = await getJson('/api/oracle/databases?_collector=1');
    const known = new Set(((j && Array.isArray(j.databases)) ? j.databases : []).map(d => String(d && d.id)));
    for (const id of cfg.dbAllow.map(String)) if (known.has(id) && !list.some(c => String(c.dbId) === id)) list.push({ dbId: id, container: '' });
    return list;
  }
  async function runPass(force) {
    if (running) return false;
    running = true; lastPass = Date.now();
    let okN = 0, failN = 0, nCtx = 0; const t0 = Date.now();
    try {
      const ctxs = (await collectContexts(false)).filter(c => allowedDb(c.dbId));      // frozen for the WHOLE pass (a container switch half-way must not split one pass); only databases ticked in History Manager
      nCtx = ctxs.length;
      // every container is collected on its own connection pool, in parallel; inside one container panels run one after the other
      await Promise.all(ctxs.map(async ctx => {
        const sc = opts.scopeOf ? opts.scopeOf(ctx.dbId, ctx.container) : ctx.dbId, dbId = ctx.dbId;
        for (const ep of [...(COLLECTABLE.has('dataguard') ? ['dataguard'] : []), ...[...COLLECTABLE].filter(e => e !== 'dataguard')]) {      // Data Guard first: it tells the role (PRIMARY / STANDBY) that every other snapshot of this pass carries
          if (!isOn(ep)) continue;
          if (!force && cfg.collect[ep] === false) continue;
          let r = { ok: true, msg: '' };
          for (const qsDef of (COLLECT_QS[ep] || [''])) {
            const qs = typeof qsDef === 'function' ? qsDef() : qsDef;
            r = await callSelf(ep, dbId, qs, ctx.container);
            // transient errors (pool being closed, dropped socket): wait and try once more before reporting a failure
            if (!r.ok && /NJS-06[45]|pool is closing|ECONNRESET|socket hang up/i.test(r.msg)) { await sleep(3000); r = await callSelf(ep, dbId, qs, ctx.container); }
            if (!r.ok) break;
          }
          // "the panel answered" is NOT "the snapshot was saved": wait for the INSERT and report the truth
          if (r.ok) {
            const o = outcome.get(sc + '|' + ep);
            if (o && o.p) await o.p;
            const o2 = outcome.get(sc + '|' + ep);
            if (o2 && !o2.ok) r = { ok: false, msg: 'not saved: ' + o2.why };
          }
          collectStatus[sc + '|' + ep] = { ts: Date.now(), ok: r.ok, msg: r.msg };
          if (r.ok) okN++; else { failN++; console.warn('[history] collect failed for', sc, ep, '-', r.msg); }
          await sleep(GAP_MS);       // be gentle with the database
        }
        // retention: every 6 hours per container (in small batches, inside that container)
        if (Date.now() - (lastPrune.get(sc) || 0) > 6 * 3600000) {
          lastPrune.set(sc, Date.now());
          const pr = await postSelf('/api/history/prune?_collector=1&dbId=' + encodeURIComponent(dbId) + (ctx.container ? '&container=' + encodeURIComponent(ctx.container) : ''), {});
          if (pr && pr.deleted) console.log('[history] retention: deleted ' + pr.deleted + ' snapshot(s) older than ' + RETENTION_DAYS + ' days from ' + sc);
        }
      }));
    } finally { running = false; saveState(lastPass); console.log('[history] collect pass done in ' + Math.round((Date.now() - t0) / 1000) + 's (' + nCtx + ' container' + (nCtx === 1 ? '' : 's') + '): ' + okN + ' ok, ' + failN + ' failed'); }
    return true;
  }
  const tick = () => { if (cfg.collectEnabled && !running && Date.now() - lastPass >= cfg.collectIntervalMin * 60000) runPass(false); };
  setInterval(tick, 15000).unref(); setTimeout(tick, 10000).unref();

  app.post('/api/history/collect-now', (req, res) => {
    if (running) return res.json({ ok: true, alreadyRunning: true });
    runPass(true); res.json({ ok: true, started: true });
  });
  app.get('/api/history/collector', (req, res) => res.json({ running, enabled: cfg.collectEnabled, intervalMin: cfg.collectIntervalMin, lastPass, status: collectStatus }));

  // ── readers ──
  const rowOut = r => ({ ts: Number(r.SNAP_TS), q: r.QUERY_PARAMS || '', con: r.CON_NAME ? { name: r.CON_NAME, id: Number(r.CON_ID) } : null, data: (() => { try { return JSON.parse(r.PAYLOAD); } catch (_) { return null; } })() });
  const LOB_STR = { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchInfo: { PAYLOAD: { type: oracledb.STRING } } };
  // newest snapshot at or before ts (prefers the same query string `q`; falls back to any q, flagged approx)
  async function readAt(conn, sc, endpoint, ts, q, lookbackDays) {
    if (!(await tableExists(conn, sc))) return null;
    const lo = ts - lookbackDays * 86400000;
    if (q != null) {
      const r = await conn.execute(SQL.atQ(q === ''), q === '' ? { pk: S(endpoint), ts: N(ts), lo: N(lo) } : { pk: S(endpoint), ts: N(ts), lo: N(lo), qp: S(q.slice(0, 1000)) }, LOB_STR);
      if (r.rows.length) return Object.assign(rowOut(r.rows[0]), { approx: false });
    }
    const r2 = await conn.execute(SQL.atAny(), { pk: S(endpoint), ts: N(ts), lo: N(lo) }, LOB_STR);
    return r2.rows.length ? Object.assign(rowOut(r2.rows[0]), { approx: q != null }) : null;
  }

  // "time travel": the newest snapshot of an endpoint at or before ts  ->  { found, ts, q, approx, con, data }
  app.get('/api/history/at', async (req, res) => {
    try {
      const ep = String(req.query.endpoint || ''), ts = +req.query.ts;
      if (!ep || !ts) return res.status(400).json({ error: 'endpoint and ts required' });
      const r = await withConn(conn => readAt(conn, dbOf(req), ep, ts, req.query.q === undefined ? null : String(req.query.q), +req.query.lookbackDays || 7));
      res.json(r ? { found: true, ts: r.ts, q: r.q, approx: r.approx, con: r.con, data: r.data } : { found: false });
    } catch (e) { dbErr(res, e); }
  });

  // snapshot list (no data) or one snapshot (?ts=)
  app.get('/api/history/data', async (req, res) => {
    try {
      const ep = String(req.query.endpoint || ''); if (!ep) return res.status(400).json({ error: 'endpoint required' });
      const to = +req.query.to || Date.now(), from = +req.query.from || to - RETENTION_DAYS * 86400000;
      await withConn(async conn => {
        if (!(await tableExists(conn, dbOf(req)))) return res.json({ snapshots: [], unreadable: 0 });
        if (req.query.ts) {
          const r = await conn.execute(SQL.one(), { pk: S(ep), ts: N(+req.query.ts) }, LOB_STR);
          return r.rows.length ? res.json(rowOut(r.rows[0])) : res.status(404).json({ error: 'snapshot not found' });
        }
        const r = await conn.execute(SQL.list(), { pk: S(ep), f: N(from), t: N(to) }, { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 200000 });
        res.json({ snapshots: r.rows.map(x => ({ ts: Number(x.SNAP_TS), q: x.QUERY_PARAMS || '' })), unreadable: 0 });
      });
    } catch (e) { dbErr(res, e); }
  });

  // ── VERIFY: audits this database/container's history and says exactly what is wrong (if anything) ──
  app.get('/api/history/verify', async (req, res) => {
    const db = dbOf(req), now = Date.now(), checks = [], iv = cfg.collectIntervalMin * 60000;
    const add = (level, endpoint, msg) => checks.push({ level, endpoint, msg });
    let con = null, table = null;
    try {
      await withConn(async conn => {
        table = await tableInfo(conn, db); con = { name: table.container, id: table.conId };
        add('ok', 'database', 'connected as ' + table.loginUser + ' (schema ' + table.loginSchema + '), container ' + table.container + ' (CON_ID ' + table.conId + ') - confirmed by the database itself');
        if (!table.exists) { add('bad', 'table', 'history table ' + table.name + ' does not exist in container ' + table.container + ' (or this login cannot see it) - History Manager -> Create table'); return; }
        add('ok', 'table', 'history table ' + table.name + ' exists: ' + table.rows + ' snapshot(s), ' + mbTxt(table.bytes) + ' of ' + mbTxt(MAX_BYTES_TOTAL));
        if (table.loginIsSys && !ownerName()) add('warn', 'table', 'the table lives in the ' + table.loginSchema + ' schema - a dedicated schema is recommended (History Manager -> Create table -> Owner)');
        if (table.paused) add('bad', 'table', 'size limit reached - recording is PAUSED (raise HISTORY_MAX_MB or lower the retention)');
        else if (table.bytes > 0.8 * MAX_BYTES_TOTAL) add('warn', 'table', 'table size is over 80% of the limit');
        // round trip with a BIG payload that contains accents / Indian / CJK / emoji characters: it must come back IDENTICAL.
        // Proves that panel data is stored COMPLETE (no truncation, no character loss) and that privileges, quota, IS JSON and COMMIT work.
        const marker = '__verify__' + process.pid;
        const probe = JSON.stringify({ probe: 'ok', items: Array.from({ length: 2500 }, (_, i) => ({ i, t: 'Zürich é ü ñ 日本語 हिन्दी 🙂 row ' + i, n: i * 1.5 })) });
        try {
          await conn.execute(SQL.insert(), { ts: N(now), pk: S(marker), pn: S('verify probe'), qp: S(null), src: S('VERIFY'), bytes: N(Buffer.byteLength(probe)), payload: { val: probe, type: oracledb.CLOB } }, { autoCommit: true });
          const back = await conn.execute(SQL.probeRead(), { pk: S(marker) }, LOB_STR);
          const got = back.rows.length === 1 ? back.rows[0].PAYLOAD : null;
          await conn.execute(SQL.probeDelete(), { pk: S(marker) }, { autoCommit: true });
          if (got === probe) add('ok', 'table', 'write test passed: a ' + Math.round(Buffer.byteLength(probe) / 1024) + ' KB probe with accents, Hindi, Japanese and emoji was inserted, read back IDENTICAL and deleted - stored panel data is complete');
          else { let at = 0; if (got !== null) while (at < probe.length && got[at] === probe[at]) at++; add('bad', 'table', 'write test FAILED: the probe came back different' + (got === null ? ' (no row)' : ' (first difference at character ' + at + ': sent "' + probe.slice(at, at + 1) + '", got "' + (got.slice(at, at + 1) || 'nothing') + '")') + ' - the database character set probably cannot store some characters (check NLS_CHARACTERSET, AL32UTF8 is recommended)'); }
        } catch (e) { add('bad', 'table', 'write test FAILED: ' + errLine(e)); try { await conn.execute(SQL.probeDelete(), { pk: marker }, { autoCommit: true }); } catch (_) {} }
        if (READABLE) {
          const rd = await readyFor(conn, db);
          if (!rd.ok) add('warn', 'readable', 'readable layer is not active' + (rd.err ? ': ' + rd.err : '') + ' - the table needs the SUMMARY / ROW_COUNT columns (History Manager -> Create table)');
          else {
            const nul = Number((await conn.execute('SELECT COUNT(*) AS CNT FROM ' + qual(rd.eff) + ' WHERE SUMMARY IS NULL', {}, OBJ)).rows[0].CNT);
            if (nul) add('warn', 'readable', nul + ' older snapshot(s) have no readable SUMMARY yet - POST /api/history/make-readable (or Create table) fills them');
            else add('ok', 'readable', 'every snapshot has a plain-text SUMMARY; read it with SELECT * FROM ' + vq(rd.eff, MAIN_VIEW) + ' ORDER BY SNAP_ID DESC');
          }
        }
        if (DETAIL_ON) {
          let noT = 0, miss = 0;
          for (const [k, v] of detailInfo) if (k.startsWith(db + '|')) for (const x of v) {
            if (!x.ok) add('bad', k.slice(db.length + 1), 'readable detail table ' + x.table + ' is not being filled: ' + x.err);
            else if (x.noTable) noT++; else if (x.missing && x.missing.length) { miss++; add('warn', k.slice(db.length + 1), 'detail table ' + x.table + ' lacks new field(s) ' + x.missing.join(', ') + ' - History Manager -> Create table adds them'); }
          }
          if (noT) add('warn', 'detail', noT + ' readable detail table(s) are not created yet (only the raw snapshot is saved for them) - History Manager -> Table & SQL -> Create table, or run GET /api/history/detail-sql');
        }
        // per panel
        const per = {};
        for (const r of (await conn.execute(SQL.latestPerPanel(), {}, OBJ)).rows) per[r.PANEL_KEY] = r;
        for (const ep of [...COLLECTABLE].sort()) {
          if (!isOn(ep) || cfg.collect[ep] === false) continue;
          const st = collectStatus[db + '|' + ep], o = outcome.get(db + '|' + ep), p = per[ep];
          if (!p) {
            if (st && st.ok) add('bad', ep, 'collector reports OK but NOTHING is saved' + (o && !o.ok ? ' - ' + o.why : ''));
            else if (st) add('bad', ep, 'collector is failing: ' + st.msg);
            else add('warn', ep, 'no snapshot yet (the collector has not reached this panel for this container)');
            continue;
          }
          const last = Number(p.LAST_TS), ageMin = Math.round((now - last) / 60000);
          if (o && !o.ok) add('bad', ep, 'last save attempt failed: ' + o.why);
          else if (p.LAST_CON && con && String(p.LAST_CON) !== con.name) add('bad', ep, 'newest snapshot was taken in container ' + p.LAST_CON + ' but this view is ' + con.name);
          else if (cfg.collectEnabled && now - last > 2.5 * iv) add('warn', ep, 'newest snapshot is ' + ageMin + ' min old (expected every ' + cfg.collectIntervalMin + ' min)' + (st && !st.ok ? ' - collector: ' + st.msg : ''));
          else add('ok', ep, 'newest snapshot ' + ageMin + ' min old, ' + p.CNT + ' stored' + (p.LAST_CON ? ', container ' + p.LAST_CON : ''));
        }
      });
    } catch (e) { add('bad', 'database', 'cannot talk to the database: ' + errLine(e)); }
    // collector health
    if (!Array.isArray(cfg.dbAllow) || !cfg.dbAllow.length) add('bad', 'databases', 'NO database is ticked in History Manager -> Databases to store: nothing is saved (tick the databases you want and press Save)');
    else if (!allowedDb(s)) add('warn', 'databases', 'this database is not ticked in Databases to store: nothing is saved for it');
    if (!cfg.collectEnabled) add('warn', 'collector', 'background collection is OFF - only panels opened in a browser are saved');
    else if (!lastPass) add('warn', 'collector', 'no collection pass has run yet');
    else if (!running && now - lastPass > 2.5 * iv) add('bad', 'collector', 'last pass was ' + Math.round((now - lastPass) / 60000) + ' min ago, but it should run every ' + cfg.collectIntervalMin + ' min');
    else add('ok', 'collector', 'last pass ' + Math.round((now - lastPass) / 60000) + ' min ago' + (running ? ' (running now)' : '') + ', interval ' + cfg.collectIntervalMin + ' min' + (cfg.collectAllContainers ? ', ALL containers' : ', selected container only'));
    if (queue.length) add('warn', 'queue', queue.length + ' snapshot(s) are waiting to be written to the database');
    const summary = { ok: 0, warn: 0, bad: 0 }; checks.forEach(c => summary[c.level]++);
    res.json({ container: String(db).split('@')[1] || '', con, summary, checks, at: now });
  });

  // ── WHERE is history stored?  Oracle table (this file) or PostgreSQL (history_store_postgres.js) - chosen with the button in History Manager ──
  function storeInfo() {
    return { backend: mode(), requested: cfg.backend, postgres: pgstore ? pgstore.info() : { available: false, driver: false, configured: false } };
  }
  app.get('/api/history/backend', (req, res) => res.json(storeInfo()));
  // which registered databases get their history stored: GET the list (with the ticks), POST {allow:[ids]} to change it ({allow:null} = every database again)
  app.get('/api/history/databases', async (req, res) => {
    try {
      const j = await getJson('/api/oracle/databases');
      const list = j && Array.isArray(j.databases) ? j.databases : [];
      res.json({ restricted: Array.isArray(cfg.dbAllow), activeId: (j && j.activeId) || null,
        databases: list.map(d => ({ id: String(d.id), name: String(d.name || d.id), host: d.host || '', active: String(d.id) === String(j.activeId), allowed: allowedDb(String(d.id)) })),
        unknownAllowed: Array.isArray(cfg.dbAllow) ? cfg.dbAllow.filter(id => !list.some(d => String(d.id) === id)) : [] });
    } catch (e) { res.status(500).json({ error: errLine(e) }); }
  });
  app.post('/api/history/databases', async (req, res) => {
    try {
      const a = (req.body || {}).allow;
      if (a === null) cfg.dbAllow = null;
      else if (Array.isArray(a) && a.every(x => typeof x === 'string' && /^[\w.\-]{1,100}$/.test(x))) cfg.dbAllow = [...new Set(a)];
      else return res.status(400).json({ error: 'allow must be a list of database ids (or null for every database)' });
      saveCfg();
      for (const k of [...last.keys()]) last.delete(k);
      console.log('[history] databases whose history is stored: ' + (cfg.dbAllow === null ? 'ALL' : cfg.dbAllow.join(', ') || 'NONE'));
      res.json({ ok: true, restricted: Array.isArray(cfg.dbAllow), allow: cfg.dbAllow });
    } catch (e) { res.status(500).json({ error: errLine(e) }); }
  });
  app.post('/api/history/backend', async (req, res) => {       // {backend:'oracle'|'postgres'} - nothing is moved or deleted, only the place for NEW snapshots (and for reading) changes
    const b = String((req.body || {}).backend || '').toLowerCase();
    if (b !== 'oracle' && b !== 'postgres') return res.status(400).json({ error: "backend must be 'oracle' or 'postgres'" });
    if (b === 'postgres') {
      if (!pgstore) return res.status(500).json({ error: 'history_store_postgres.js is missing (or failed to load - see the server log). Put it next to history_store.js and restart.' });
      try { await pgstore.ping(); } catch (e) { return res.status(500).json({ error: 'PostgreSQL is not usable: ' + errLine(e) }); }
    }
    cfg.backend = b; saveCfg();
    usageBy.clear();
    for (const k of [...last.keys()]) last.delete(k);            // the next collection pass saves into the newly selected store
    console.log('[history] history is now stored in ' + (b === 'postgres' ? 'PostgreSQL' : 'the Oracle table'));
    res.json({ ok: true, ...storeInfo() });
  });
  // what history_store_postgres.js shares with this file (same collector, same ON/OFF boxes, same retention, same reporting)
  try {
    pgstore = require('./history_store_postgres')(app, currentDbId, opts, {
      CATALOG, COLLECTABLE, cfg, collectStatus, outcome, isOn, RETENTION_DAYS, INTERVAL_MS, scope,
      running: () => running, lastPass: () => lastPass, queueLen: () => queue.length, storeInfo,
      dbMeta: db => metaOf(db),
      clearThrottle: db => { for (const k of [...last.keys()]) if (k.startsWith(db + '|')) last.delete(k); }
    });
  } catch (e) {
    pgstore = null;
    if (e && e.code === 'MODULE_NOT_FOUND' && /history_store_postgres/.test(String(e.message))) console.log('[history] history_store_postgres.js not found - PostgreSQL storage is not available (Oracle table is used)');
    else console.warn('[history] PostgreSQL module NOT loaded (Oracle table is used):', errLine(e));
  }
  if (cfg.backend === 'postgres' && !pgstore) console.warn('[history] PostgreSQL was selected but its module is not available - snapshots go to the Oracle table until it is fixed');

  console.log(`[history] saving panel snapshots every ${INTERVAL_MS / 60000} min into the Oracle table ${ENV_SCHEMA ? ENV_SCHEMA + '.' : ''}${TABLE} of each container, keeping ${RETENTION_DAYS} days`);
};
module.exports._test = { summarize, buildViews, mainViewSql, panelsViewSql, colName, truncBytes, datasetsOf, colPlan };

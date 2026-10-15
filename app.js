/* =====================================================================
   NMR Relaxation Database — single-page app on SQLite (sql.js)
   ---------------------------------------------------------------------
   How it works
   * The whole database is one SQLite file held in memory by sql.js
     (SQLite compiled to WebAssembly). schema.sql defines the tables.
   * After every change the database is saved to this browser
     (IndexedDB), so a reload keeps your work.
   * The lab's shared copy is a master .sqlite file kept in a synced
     folder (OneDrive, Google Drive, Box). In Chrome and Edge the site
     opens that file and saves straight back to it (File System Access
     API); other browsers open it and download a replacement.
   * Optionally, a copy committed to data/database.sqlite in the repo is
     offered to visitors (public, so only for data that may be public).
   * No build step: plain HTML, CSS and JavaScript.
   ===================================================================== */
(function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  const REPO_DB_PATH = 'data/database.sqlite';
  const IDB_NAME = 'nmr-relaxation-db';
  const ROW_LIMIT = 100;
  const BUILTIN_QUANTITIES = ['T1', 'T2', 'R1', 'R2', 'D', 'tau_c'];

  /* ------------------------------------------------------------------ *
   *  Small helpers
   * ------------------------------------------------------------------ */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const isBlank = v => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const clean = x => Number(x.toPrecision(12)); // removes float noise from unit conversion

  const SUPMAP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻', '+': '' };
  const UNSUP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+' };
  const sup = n => String(n).split('').map(c => SUPMAP[c] ?? c).join('');
  const trimZeros = s => (s.includes('e') || !s.includes('.')) ? s : s.replace(/\.?0+$/, '');

  /** Display a number: 6 significant figures, scientific (× 10ⁿ) when very small or large. */
  function fmtNum(v, sig = 6) {
    if (v === null || v === undefined || v === '') return '';
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return String(v);
    if (n === 0) return '0';
    const a = Math.abs(n);
    if (a < 1e-3 || a >= 1e6) {
      const p = Math.min(sig, 4);
      let e = Math.floor(Math.log10(a));
      let m = Number((n / Math.pow(10, e)).toPrecision(p));
      if (Math.abs(m) >= 10) { m /= 10; e += 1; }
      return `${trimZeros(m.toPrecision(p))} × 10${sup(e)}`;
    }
    return trimZeros(n.toPrecision(sig));
  }
  const numCell = (v, sig) => v === null || v === undefined ? '' : `<span title="${esc(v)}">${esc(fmtNum(v, sig))}</span>`;

  /** Parse user/imported numbers: "2.27e-9", "2.27×10^-9", "2.27 x 10⁻⁹", "-5". Returns null for blank, NaN if invalid. */
  function parseNum(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (typeof v === 'boolean' || v instanceof Date) return NaN;
    let s = String(v).trim();
    if (s === '') return null;
    s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]/g, c => UNSUP[c]).replace(/−/g, '-').replace(/\s+/g, '');
    const m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+))[x×*·]10\^?([+-]?\d+)$/i);
    if (m) return Number(`${m[1]}e${m[2]}`);
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(s)) return Number(s);
    return NaN;
  }

  /* ------------------------------------------------------------------ *
   *  Units. Stored values are always in the base unit; inputs and imports
   *  can be given in any listed unit and are converted on the way in.
   * ------------------------------------------------------------------ */
  const UNITS = {
    time: { base: 's', list: [['s', 1], ['ms', 1e-3], ['µs', 1e-6], ['ns', 1e-9], ['ps', 1e-12]] },
    diffusion: { base: 'm²/s', list: [['m²/s', 1], ['10⁻⁹ m²/s', 1e-9], ['cm²/s', 1e-4], ['nm²/ns', 1e-9], ['Å²/ps', 1e-8]] },
    rate: { base: '1/s', list: [['1/s', 1], ['1/ms', 1e3]] },
    temperature: { base: 'K', list: [['K', null], ['°C', null]] },
  };
  const QTY_UNIT_KIND = { 's': 'time', 'm^2/s': 'diffusion', '1/s': 'rate', 'K': 'temperature' };
  const prettyUnit = u => String(u ?? '').replace(/\^2/g, '²').replace(/\^3/g, '³').replace(/\^-1/g, '⁻¹').replace(/\^0\.5/g, '½');

  function toBase(kind, unit, v) {
    if (v === null || v === undefined || Number.isNaN(v) || !kind || !unit) return v;
    if (kind === 'temperature') return unit === '°C' ? clean(v + 273.15) : v;
    const hit = UNITS[kind].list.find(u => u[0] === unit);
    const f = hit ? hit[1] : 1;
    return f === 1 ? v : clean(v * f);
  }

  /** Guess a unit from a column header such as "T2 (ms)", "Temp [°C]", "D (cm^2/s)", "t2_ms". */
  function detectUnit(kind, header) {
    if (!kind) return null;
    const h = String(header ?? '').toLowerCase().replace(/\s+/g, '');
    const inner = (h.match(/[([]([^)\]]*)[)\]]/) || [])[1] || '';
    const tail = (h.match(/_(ms|us|µs|μs|ns|ps|s|k|degc)$/) || [])[1] || '';
    const u = inner || tail;
    if (!u) return null;
    if (kind === 'time') {
      if (/^(ms|msec)$/.test(u)) return 'ms';
      if (/^(µs|μs|us)$/.test(u)) return 'µs';
      if (u === 'ns') return 'ns';
      if (u === 'ps') return 'ps';
      if (/^(s|sec|secs|seconds?)$/.test(u)) return 's';
    }
    if (kind === 'temperature') {
      if (/^(°c|ºc|degc|c|celsius)$/.test(u)) return '°C';
      if (/^(k|kelvin)$/.test(u)) return 'K';
    }
    if (kind === 'diffusion') {
      if (/cm/.test(u)) return 'cm²/s';
      if (/(å|a|ang|angstrom)(\^?2|²)\/ps/.test(u)) return 'Å²/ps';
      if (/nm(\^?2|²)\/ns/.test(u)) return 'nm²/ns';
      if (/(1e-9|10\^?-9|10⁻⁹|e-9)/.test(u)) return '10⁻⁹ m²/s';
      if (/^m(\^?2|²)(\/s|s-1|s\^-1)$/.test(u)) return 'm²/s';
    }
    if (kind === 'rate') {
      if (/(1\/ms|ms-1|ms\^-1)/.test(u)) return '1/ms';
      if (/(1\/s|s-1|s\^-1|hz)/.test(u)) return '1/s';
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   *  State
   * ------------------------------------------------------------------ */
  const state = {
    SQL: null, db: null, engine: '',
    mode: 'normal',          // 'normal' | 'example'
    persistOk: true,         // false when this browser blocks IndexedDB
    savedAt: null,
    dirty: false,            // changed since last download / since loading a file
    source: 'new',           // 'browser' | 'repo' | 'file' | 'new'
    repoHash: null,          // hash of the repository file this working copy started from
    repoNotice: null,        // {bytes, hash} when the repository file differs
    repoAvailable: false,    // a data/database.sqlite exists in the site
    master: null,            // {handle, name, hash, syncedAt, ready}: linked master file
    masterNotice: null,      // 'permission' | 'missing' | 'changed'
    currentBytes: null,
    undo: [],
    real: null,              // the real database while example mode is on
    route: 'overview',
    tabs: {}, sort: {}, search: {}, showAll: {},
    compare: { quantity: 'T2', method: '' },
  };

  /* ------------------------------------------------------------------ *
   *  Database layer
   * ------------------------------------------------------------------ */
  function q(sql, params) {
    const stmt = state.db.prepare(sql);
    try {
      if (params) stmt.bind(params.map(v => (v === undefined ? null : v)));
      const out = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally { stmt.free(); }
  }
  const q1 = (sql, params) => q(sql, params)[0] || null;
  const run = (sql, params) => state.db.run(sql, params ? params.map(v => (v === undefined ? null : v)) : undefined);
  const lastId = () => state.db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  const metaGet = k => (q1('SELECT value FROM meta WHERE key = ?', [k]) || {}).value ?? null;
  const metaSet = (k, v) => run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, String(v)]);

  /** sql.js export() closes and reopens the database, which resets PRAGMAs, so foreign keys are switched back on here. */
  function exportBytes() {
    const b = state.db.export();
    state.db.run('PRAGMA foreign_keys = ON');
    return b;
  }

  function openDb(bytes) {
    if (state.db) { try { state.db.close(); } catch (_) { /* already closed */ } }
    state.db = bytes ? new state.SQL.Database(bytes) : new state.SQL.Database();
    state.db.run('PRAGMA foreign_keys = ON');
  }

  /** Create the schema in an empty database, or check an existing one. */
  function ensureSchema() {
    const tables = q("SELECT name FROM sqlite_master WHERE type = 'table'").map(r => r.name);
    if (!tables.includes('meta')) {
      if (tables.some(t => !t.startsWith('sqlite_'))) return { foreign: true };
      state.db.exec(window.NMRDB_SCHEMA);
      return { created: true };
    }
    const v = Number(metaGet('schema_version') || 0);
    if (v > SCHEMA_VERSION) return { newer: true, version: v };
    return { ok: true };
  }

  const isSqlite = b => b && b.length >= 16 && String.fromCharCode.apply(null, b.slice(0, 15)) === 'SQLite format 3';

  function hashBytes(b) { // FNV-1a, enough to notice that a file changed
    let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return `${h.toString(16)}:${b.length}`;
  }

  /**
   * Run a change inside one transaction. If anything fails, nothing is kept.
   * On success the previous state goes on the undo stack and the database is saved.
   */
  function mutate(label, fn) {
    if (!state.currentBytes) state.currentBytes = exportBytes();
    const before = state.currentBytes;
    run('BEGIN');
    let result;
    try {
      result = fn();
      metaSet('modified_at', nowIso());
      run('COMMIT');
    } catch (e) {
      try { run('ROLLBACK'); } catch (_) { /* nothing open */ }
      throw e;
    }
    pushUndo(label, before);
    afterChange();
    return result;
  }
  function pushUndo(label, bytes) {
    state.undo.push({ label, bytes });
    if (state.undo.length > 30) state.undo.shift();
  }
  function afterChange() {
    state.currentBytes = exportBytes();
    state.dirty = true;
    schedulePersist();
    render();
  }
  function undo() {
    const s = state.undo.pop();
    if (!s) return;
    openDb(s.bytes);
    state.currentBytes = s.bytes;
    state.dirty = true;
    schedulePersist();
    closeDrawer();
    render();
    toast(`Undid: ${s.label}`);
  }

  /** Turn SQLite error text into something a person can act on. */
  function friendlyError(e) {
    const m = String(e && e.message || e);
    if (/UNIQUE constraint failed: compounds\.name/.test(m)) return 'A compound with this name already exists.';
    if (/UNIQUE constraint failed: compounds\.cas/.test(m)) return 'Another compound already has this CAS number.';
    if (/UNIQUE constraint failed: quantities\.quantity/.test(m)) return 'That quantity already exists.';
    if (/FOREIGN KEY constraint failed/.test(m)) return 'This change would break a link between records (for example, deleting something other records still use).';
    if (/CHECK constraint failed/.test(m)) return `A value is outside its allowed range. SQLite reported: ${m.replace(/^.*CHECK constraint failed:\s*/, '')}`;
    return m;
  }

  /* ------------------------------------------------------------------ *
   *  Saving in this browser (IndexedDB)
   * ------------------------------------------------------------------ */
  let idbHandle = null;
  function idbOpen() {
    if (idbHandle) return Promise.resolve(idbHandle);
    return new Promise((resolve, reject) => {
      try {
        const r = indexedDB.open(IDB_NAME, 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => { idbHandle = r.result; resolve(idbHandle); };
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(new Error('IndexedDB blocked'));
      } catch (e) { reject(e); }
    });
  }
  async function idbGet(key) {
    const d = await idbOpen();
    return new Promise((resolve, reject) => {
      const t = d.transaction('kv', 'readonly').objectStore('kv').get(key);
      t.onsuccess = () => resolve(t.result || null);
      t.onerror = () => reject(t.error);
    });
  }
  async function idbPut(key, value) {
    const d = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbDelete(key) {
    const d = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  /** Saved right away (not debounced) so closing the tab straight after an edit loses nothing. */
  function schedulePersist() {
    if (state.mode === 'example') return;
    persistNow();
  }
  let persistChain = Promise.resolve();
  function persistNow() {
    if (state.mode === 'example' || !state.currentBytes) return persistChain;
    const snapshot = { bytes: state.currentBytes, savedAt: nowIso(), repoHash: state.repoHash, dirty: state.dirty, schema: SCHEMA_VERSION };
    persistChain = persistChain.then(() => writeWorking(snapshot));
    return persistChain;
  }
  async function writeWorking(snapshot) {
    try {
      await idbPut('working', snapshot);
      state.persistOk = true;
      state.savedAt = new Date();
    } catch (e) {
      console.warn('Could not save to this browser', e);
      state.persistOk = false;
    }
    renderStatus();
  }

  async function fetchRepoDb() {
    if (location.protocol === 'file:') return null;
    try {
      const r = await fetch(REPO_DB_PATH, { cache: 'no-cache' });
      if (!r.ok) return null;
      const b = new Uint8Array(await r.arrayBuffer());
      return isSqlite(b) ? b : null;
    } catch (_) { return null; }
  }

  /* ------------------------------------------------------------------ *
   *  Files out. In a normal browser this is an ordinary download. Inside a
   *  claude.ai artifact, page-started downloads are blocked, so the
   *  viewer's "downloads" capability is used when it is available.
   * ------------------------------------------------------------------ */
  async function saveFile(filename, data, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    if (window.claude && typeof window.claude.use === 'function') {
      let dl = null;
      try { dl = await window.claude.use('downloads'); } catch (_) { dl = null; }
      if (dl) {
        try { await dl.save({ filename, data: blob }); return true; }
        catch (e) {
          if (e && e.code === 'declined') return false;
          if (e && e.code === 'rejected_extension') { toast(`This preview can't save .${filename.split('.').pop()} files. Use the GitHub site for that, or download JSON here.`, { err: true }); return false; }
          toast(`Couldn't save the file: ${e && e.message || e}`, { err: true });
          return false;
        }
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    return true;
  }
  function toCsv(header, rows) {
    return window.Papa.unparse({ fields: header, data: rows.map(r => r.map(v => (v === null || v === undefined ? '' : v))) });
  }

  /* ------------------------------------------------------------------ *
   *  Lookups used by forms and tables
   * ------------------------------------------------------------------ */
  const compoundsList = () => q('SELECT compound_id, name, cas FROM compounds ORDER BY name COLLATE NOCASE');
  const quantitiesList = () => q('SELECT quantity, unit, description FROM quantities ORDER BY quantity');
  const distinct = (table, col) => q(`SELECT DISTINCT ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND trim(${col}) <> '' ORDER BY 1 COLLATE NOCASE LIMIT 200`).map(r => r.v);

  function pureName(r) {
    if (r.compound_b == null || r.x_a >= 1 - 1e-9) return r.compound_a;
    return r.compound_b;
  }
  function sampleText(r) {
    if (r.sample_type === 'pure') return pureName(r);
    return `${r.compound_a} / ${r.compound_b}, x_A = ${fmtNum(r.x_a)}`;
  }
  function sampleCell(r) {
    if (r.sample_type === 'pure') {
      const note = r.compound_b != null ? `<div class="sub-note">endpoint of ${esc(r.compound_a)} / ${esc(r.compound_b)}</div>` : '';
      return `<span class="sample">${esc(pureName(r))}</span>${note}`;
    }
    return `<span class="sample">${esc(r.compound_a)}<span class="sep">/</span>${esc(r.compound_b)}</span>`;
  }
  const typeChip = t => `<span class="muted">${t === 'pure' ? 'pure' : 'mixture'}</span>`;
  const degChip = v => v === 1 ? 'yes' : v === 0 ? '<span class="flag">no</span>' : '<span class="muted">—</span>';
  const xCell = r => r.sample_type === 'pure' && r.compound_b == null ? '<span class="muted">—</span>' : numCell(r.x_a);
  const withErr = (v, e) => v == null ? '' : `${numCell(v)}${e != null ? ` <span class="muted">± ${esc(fmtNum(e))}</span>` : ''}`;

  function simOptionLabel(s) {
    return `#${s.simulation_id} · ${sampleText(s)}${s.temperature_k != null ? ` · ${fmtNum(s.temperature_k)} K` : ''}`;
  }
  function expOptionLabel(e) {
    return `#${e.experiment_id} · ${sampleText(e)}${e.temperature_k != null ? ` · ${fmtNum(e.temperature_k)} K` : ''}${e.date ? ` · ${e.date}` : ''}`;
  }

  /* ------------------------------------------------------------------ *
   *  Form definitions. type: text | textarea | number | int | date |
   *  bool3 | mixture | select-sim | select-qty | species | echo | paths | link
   *  kind: unit family for unit-aware numbers; unit: fixed unit label.
   * ------------------------------------------------------------------ */
  const SUGGEST = {
    pulse_sequence: ['CPMG', 'Hahn echo', 'PGSE (diffusion)', 'Stimulated-echo PGSE (diffusion)'],
    contribution: ['total', 'intra', 'inter'],
    method: ['ensemble single-exponential fit', 'harmonic mean of rates', 'inverse Laplace of simulated CPMG', 'uncorrected (periodic box)', 'Yeh–Hummer corrected'],
    script: ['intra', 'inter', 'results'],
    force_field: ['CHARMM36 / CGenFF'],
    software: ['OpenMM'],
    file_type: ['CPMG decay', 'PGSE diffusion data', 'spectrometer raw data', 'trajectory', 'topology / structure', 'autocorrelation (ACF) output', 'analysis output'],
  };

  const FORMS = {
    compounds: {
      noun: 'compound', title: r => r.name, table: 'compounds', pk: 'compound_id',
      sections: [
        { title: 'Identity', fields: [
          { key: 'name', label: 'Name', type: 'text', required: true, full: true },
          { key: 'cas', label: 'CAS number', type: 'text', placeholder: 'e.g. 108-88-3' },
          { key: 'formula', label: 'Formula', type: 'text', placeholder: 'e.g. C7H8' },
          { key: 'smiles', label: 'SMILES', type: 'text', full: true, mono: true },
        ] },
        { title: 'Physical constants', fields: [
          { key: 'mw_g_mol', label: 'Molar mass', type: 'number', unit: 'g/mol' },
          { key: 'density_g_cm3', label: 'Density', type: 'number', unit: 'g/cm³', hint: 'Note the temperature in Source.' },
        ] },
        { title: 'Hansen solubility parameters', fields: [
          { key: 'hsp_d_mpa05', label: 'δD · dispersion', type: 'number', unit: 'MPa½' },
          { key: 'hsp_p_mpa05', label: 'δP · polarity', type: 'number', unit: 'MPa½' },
          { key: 'hsp_h_mpa05', label: 'δH · hydrogen bonding', type: 'number', unit: 'MPa½' },
        ] },
        { title: 'Notes', fields: [
          { key: 'source', label: 'Source of constants', type: 'text', full: true, placeholder: 'e.g. Hansen, HSP handbook (2007); density at 25 °C from …' },
          { key: 'comments', label: 'Comments', type: 'textarea', full: true },
        ] },
      ],
    },
    experiments: {
      noun: 'experiment', title: r => `Experiment #${r.experiment_id}`, table: 'experiments', pk: 'experiment_id',
      sections: [
        { title: 'Sample', fields: [
          { key: '__mixture', type: 'mixture', full: true },
          { key: 'temperature_k', label: 'Temperature', type: 'number', kind: 'temperature' },
          { key: 'degassed', label: 'Degassed', type: 'bool3' },
        ] },
        { title: 'Acquisition', fields: [
          { key: 'magnet', label: 'Magnet', type: 'text', list: 'magnet', placeholder: 'e.g. 43 MHz benchtop' },
          { key: 'pulse_sequence', label: 'Pulse sequence', type: 'text', list: 'pulse_sequence' },
          { key: 'echo_times_s', label: 'Echo time(s)', type: 'echo', kind: 'time', hint: 'One or more values, separated by commas.' },
          { key: 'n_scans', label: 'Number of scans', type: 'int' },
        ] },
        { title: 'Results', fields: [
          { key: 't2_s', label: 'T₂', type: 'number', kind: 'time' },
          { key: 't2_err_s', label: 'T₂ uncertainty', type: 'number', kind: 'time' },
          { key: 'diffusion_m2_s', label: 'Diffusion coefficient D', type: 'number', kind: 'diffusion' },
          { key: 'diffusion_err_m2_s', label: 'D uncertainty', type: 'number', kind: 'diffusion' },
        ] },
        { title: 'Record', fields: [
          { key: 'date', label: 'Date', type: 'date', default: today },
          { key: 'user_name', label: 'User', type: 'text', list: 'user_name' },
          { key: 'location', label: 'Location', type: 'text', list: 'location', hint: 'Where it was measured (lab, instrument).' },
          { key: '__paths', label: 'Raw data locations', type: 'paths', full: true, hint: 'One path or URL per line. Listed in Raw data.' },
          { key: 'comments', label: 'Comments', type: 'textarea', full: true },
        ] },
      ],
    },
    simulations: {
      noun: 'simulation', title: r => `Simulation #${r.simulation_id}`, table: 'simulations', pk: 'simulation_id',
      sections: [
        { title: 'Sample', fields: [
          { key: '__mixture', type: 'mixture', full: true },
          { key: 'temperature_k', label: 'Temperature', type: 'number', kind: 'temperature' },
        ] },
        { title: 'Setup', fields: [
          { key: 'n_molecules_a', label: 'Molecules of A', type: 'int' },
          { key: 'n_molecules_b', label: 'Molecules of B', type: 'int' },
          { key: 'force_field', label: 'Force field', type: 'text', list: 'force_field' },
          { key: 'software', label: 'Software', type: 'text', list: 'software' },
          { key: 'production_ns', label: 'Production length', type: 'number', unit: 'ns' },
          { key: 'timestep_fs', label: 'Timestep', type: 'number', unit: 'fs' },
        ] },
        { title: 'Record', fields: [
          { key: 'date', label: 'Date', type: 'date', default: today },
          { key: 'user_name', label: 'User', type: 'text', list: 'user_name' },
          { key: 'location', label: 'Location', type: 'text', list: 'location', hint: 'Where it ran or lives (cluster, directory).' },
          { key: '__paths', label: 'Raw data locations', type: 'paths', full: true, hint: 'Trajectories, inputs, outputs. One per line.' },
          { key: 'comments', label: 'Comments', type: 'textarea', full: true },
        ] },
      ],
    },
    processed_results: {
      noun: 'result', title: r => `Result #${r.result_id}`, table: 'processed_results', pk: 'result_id',
      sections: [
        { title: 'What was computed', fields: [
          { key: 'simulation_id', label: 'Simulation', type: 'select-sim', required: true, full: true },
          { key: 'quantity', label: 'Quantity', type: 'select-qty', required: true },
          { key: 'species_compound_id', label: 'Species', type: 'species' },
          { key: 'contribution', label: 'Contribution', type: 'text', list: 'contribution', required: true, default: () => 'total' },
          { key: 'method', label: 'Method', type: 'text', list: 'method' },
        ] },
        { title: 'Value', fields: [
          { key: 'value', label: 'Value', type: 'number', kindFromQty: true, required: true },
          { key: 'uncertainty', label: 'Uncertainty', type: 'number', kindFromQty: true },
        ] },
        { title: 'Provenance', fields: [
          { key: 'script', label: 'Script', type: 'text', list: 'script' },
          { key: 'date', label: 'Date computed', type: 'date', default: today },
          { key: 'source_path', label: 'Source file', type: 'text', full: true, mono: true },
          { key: 'comments', label: 'Comments', type: 'textarea', full: true },
        ] },
      ],
    },
    raw_data: {
      noun: 'raw-data location', title: r => `Raw data #${r.raw_id}`, table: 'raw_data', pk: 'raw_id',
      sections: [
        { title: 'Location', fields: [
          { key: 'path', label: 'Path or URL', type: 'text', required: true, full: true, mono: true },
          { key: 'file_type', label: 'File type', type: 'text', list: 'file_type' },
          { key: '__link', label: 'Linked to', type: 'link', full: true },
          { key: 'description', label: 'Description', type: 'text', full: true },
          { key: 'comments', label: 'Comments', type: 'textarea', full: true },
        ] },
      ],
    },
    quantities: {
      noun: 'quantity', title: r => r.quantity, table: 'quantities', pk: 'quantity',
      sections: [
        { title: 'Quantity', fields: [
          { key: 'quantity', label: 'Symbol', type: 'text', required: true, placeholder: 'e.g. T1rho' },
          { key: 'unit', label: 'Unit', type: 'text', required: true, placeholder: 'SI, e.g. s', hint: 'Values of this quantity are stored in this unit.' },
          { key: 'description', label: 'Description', type: 'text', full: true },
        ] },
      ],
    },
  };
  const allFields = cfg => cfg.sections.flatMap(s => s.fields);

  /* ------------------------------------------------------------------ *
   *  UI chrome: toasts, modal, theme
   * ------------------------------------------------------------------ */
  function toast(msg, opts = {}) {
    const t = document.createElement('div');
    t.className = `toast${opts.err ? ' err' : ''}`;
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), opts.err ? 7000 : 3800);
  }

  /** In-page confirmation (artifact viewers ignore window.confirm). */
  function modal({ title, body, actions }) {
    const ov = $('#overlay');
    ov.innerHTML = `<div class="modal-scrim" data-modal-close></div>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">${esc(title)}</h2><p>${body}</p>
        <div class="actions">${actions.map((a, i) => `<button type="button" class="btn ${a.kind || ''}" data-modal-act="${i}">${esc(a.label)}</button>`).join('')}</div>
      </div>`;
    const close = () => { ov.innerHTML = ''; };
    ov.onclick = e => {
      if (e.target.closest('[data-modal-close]')) close();
      const b = e.target.closest('[data-modal-act]');
      if (b) { close(); const a = actions[Number(b.dataset.modalAct)]; if (a.onClick) a.onClick(); }
    };
    const first = $('[data-modal-act]', ov);
    if (first) first.focus();
  }
  const closeModal = () => { if ($('.modal')) $('#overlay').innerHTML = ''; };

  /* ------------------------------------------------------------------ *
   *  Navigation, status bar, banners
   * ------------------------------------------------------------------ */
  const ROUTES = ['overview', 'constants', 'experimental', 'simulated', 'processed', 'compare', 'raw', 'sql', 'import', 'settings'];
  function counts() {
    return q1(`SELECT (SELECT count(*) FROM compounds) AS c, (SELECT count(*) FROM experiments) AS e,
      (SELECT count(*) FROM simulations) AS s, (SELECT count(*) FROM processed_results) AS p,
      (SELECT count(*) FROM raw_data) AS r, (SELECT count(*) FROM v_sim_vs_exp) AS x`);
  }

  function renderNav() {
    const item = (r, label) => `<a href="#${r}" ${state.route === r ? 'aria-current="page"' : ''}>${label}</a>`;
    $('#nav').innerHTML = item('overview', 'Overview') + item('constants', 'Physical constants') + item('experimental', 'Experimental') +
      item('simulated', 'Simulated') + item('processed', 'Processed data') + item('compare', 'Sim vs exp') + item('raw', 'Raw data') +
      '<span class="gap" aria-hidden="true"></span>' + item('sql', 'SQL') + item('import', 'Import') + item('settings', 'Export');
  }

  function renderStatus() {
    const el = $('#status');
    if (!el || !state.db) return;
    const m = state.master;
    let html;
    if (state.mode === 'example') html = 'Example data. Nothing here is saved.';
    else if (!state.persistOk) html = '<strong>Not saved.</strong> This browser is blocking storage, so save to a file before closing.';
    else if (m && state.dirty) html = `<strong>Changes not saved to ${esc(m.name)}.</strong>`;
    else if (m && !m.ready) html = `Linked to ${esc(m.name)}.`;
    else if (m) html = `Saved to ${esc(m.name)}${m.syncedAt ? ` · ${esc(fmtTime(m.syncedAt))}` : ''}.`;
    else if (state.dirty) html = 'Saved in this browser. <strong>Not saved to a file since the last change.</strong>';
    else html = state.source === 'repo' ? 'Saved in this browser. Same as the repository file.' : 'Saved in this browser.';
    el.classList.toggle('off', state.mode !== 'example' && !state.persistOk);
    el.innerHTML = html;
    const last = state.undo[state.undo.length - 1];
    const save = m
      ? `<button class="btn ${state.dirty ? 'primary' : ''}" data-action="master-save" title="Ctrl+S">Save to master</button>`
      : `<button class="btn ${state.dirty ? 'primary' : ''}" data-action="download-sqlite">Download .sqlite</button>`;
    $('#header-actions').innerHTML = state.mode === 'example'
      ? '<button class="btn primary" data-action="exit-example">Leave example data</button>'
      : `<button class="btn ghost" data-action="undo" ${last ? `title="Undo: ${esc(last.label)}"` : 'disabled'}>Undo</button>${save}`;
  }
  const fmtTime = iso => { try { const d = new Date(iso); return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) { return iso; } };

  function renderBanners() {
    const parts = [];
    if (state.mode === 'example') {
      parts.push(`<div class="banner"><span class="badge">Example data</span><div class="grow">The measurements and simulation results here are made up; the constants list their sources. Your own database comes back when you leave.</div></div>`);
    }
    const mn = state.master && state.mode !== 'example' ? state.masterNotice : null;
    if (mn === 'permission') {
      parts.push(`<div class="banner"><div class="grow">This browser is linked to <strong>${esc(state.master.name)}</strong> in your shared folder. Open the latest copy to see what others saved.</div>
        <button class="btn sm primary" data-action="master-reload">Open latest</button><button class="btn sm ghost" data-action="master-unlink">Unlink</button></div>`);
    } else if (mn === 'missing') {
      parts.push(`<div class="banner bad"><div class="grow"><strong>${esc(state.master.name)}</strong> can't be found. It may have been moved or renamed.</div>
        <button class="btn sm primary" data-action="master-open">Find the master file…</button><button class="btn sm ghost" data-action="master-unlink">Unlink</button></div>`);
    } else if (mn === 'changed') {
      parts.push(`<div class="banner"><div class="grow">Someone saved a newer <strong>${esc(state.master.name)}</strong>.${state.dirty ? ' You also have changes here that aren\'t saved to it.' : ''}</div>
        <button class="btn sm primary" data-action="master-reload">${state.dirty ? 'Review' : 'Load it'}</button></div>`);
    }
    if (state.repoNotice && state.mode !== 'example' && !state.master) {
      parts.push(`<div class="banner"><div class="grow">The repository has a different database file from the one your browser copy started from.</div>
        <button class="btn sm primary" data-action="load-repo">Load the repository version</button>
        <button class="btn sm ghost" data-action="dismiss-repo">Keep mine</button></div>`);
    }
    if (state.schemaNewer) {
      parts.push(`<div class="banner bad"><div class="grow">This database uses schema version ${esc(state.schemaNewer)}, newer than this site understands (${SCHEMA_VERSION}). Update the site files before editing.</div></div>`);
    }
    $('#banners').innerHTML = parts.join('');
  }

  /* ------------------------------------------------------------------ *
   *  Generic list section: tabs, search, sortable table, CSV export
   * ------------------------------------------------------------------ */
  function th(c, sort) {
    const unit = c.unit ? ` <span class="unit">/ ${esc(c.unit)}</span>` : '';
    const arrow = sort && sort.key === c.key ? `<span class="arrow">${sort.dir === 1 ? '▲' : '▼'}</span>` : '';
    const sortable = c.sort !== false;
    return `<th class="${c.cls && c.cls.includes('n') ? 'n ' : ''}${sortable ? 'sortable' : ''}" ${sortable ? `data-action="sort" data-key="${esc(c.key)}"` : ''} scope="col">${c.label}${unit}${arrow}</th>`;
  }
  function sortRows(rows, cols, sort) {
    if (!sort) return rows;
    const col = cols.find(c => c.key === sort.key);
    if (!col) return rows;
    const val = col.sortVal || (r => r[col.key]);
    return rows.slice().sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sort.dir;
      return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * sort.dir;
    });
  }
  function filterRows(rows, text) {
    const t = (text || '').trim().toLowerCase();
    if (!t) return rows;
    return rows.filter(r => Object.values(r).some(v => v != null && String(v).toLowerCase().includes(t)));
  }

  /** Render a table into `container`. cfg: {id, cols, rows, rowAction(r), empty} */
  function renderTable(container, cfg) {
    const sort = state.sort[cfg.id];
    let rows = filterRows(cfg.rows, state.search[cfg.id]);
    rows = sortRows(rows, cfg.cols, sort);
    if (!cfg.rows.length) { container.innerHTML = cfg.empty; return; }
    const total = rows.length;
    const shown = state.showAll[cfg.id] ? rows : rows.slice(0, ROW_LIMIT);
    const body = shown.map(r => {
      const act = cfg.rowAction ? cfg.rowAction(r) : '';
      return `<tr ${act}>${cfg.cols.map(c => `<td class="${c.cls || ''}">${c.render ? c.render(r) : esc(r[c.key] ?? '')}</td>`).join('')}</tr>`;
    }).join('');
    container.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr>${cfg.cols.map(c => th(c, sort)).join('')}</tr></thead>
      <tbody>${body || `<tr><td colspan="${cfg.cols.length}" class="muted">No rows match the search.</td></tr>`}</tbody></table></div>
      <div class="table-foot"><span>${total === cfg.rows.length ? plural(total, 'row') : `${total} of ${cfg.rows.length} rows match`}</span>
      ${total > shown.length ? `<button class="linkish" data-action="show-all" data-id="${cfg.id}">Show all ${total}</button>` : ''}
      <span>Values are rounded for display; hover one to see what is stored.</span></div>`;
  }

  /** Section scaffold: header, tabs, search, table container. */
  function listSection(o) {
    const tabs = o.tabs ? `<div class="tabs" role="tablist" aria-label="Show">${o.tabs.map(t => `<button role="tab" aria-selected="${o.tab === t.id}" data-action="set-tab" data-route="${state.route}" data-tab="${t.id}">${esc(t.label)}${t.n != null ? ` <span class="n">${t.n}</span>` : ''}</button>`).join('')}</div>` : '';
    return `<section class="sec-head"><div class="sec-title"><p class="eyebrow">${esc(o.eyebrow)}</p><h1>${esc(o.title)}</h1><p class="sec-desc">${o.desc}</p></div>
      <div class="sec-actions">${o.actions || ''}</div></section>
      <div class="toolbar">${tabs}<div class="spacer"></div><div class="tools">${o.extraTools || ''}
        <input type="search" class="search" id="search-${o.id}" data-search="${o.id}" placeholder="Search" value="${esc(state.search[o.id] || '')}" aria-label="Search this table">
        ${o.csv ? `<button class="linkish" data-action="export-view" data-id="${o.id}">Export CSV</button>` : ''}</div></div>
      ${o.before || ''}
      <div class="sheet" id="table-${o.id}"></div>${o.after || ''}`;
  }
  const tableRegistry = {};
  function mountTable(id, cfg) { tableRegistry[id] = cfg; renderTable($(`#table-${id}`), cfg); }

  function emptyState(title, text, actions) {
    return `<div class="empty"><p><strong>${esc(title)}.</strong> ${text}</p>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
  }

  /* ------------------------------------------------------------------ *
   *  Sections
   * ------------------------------------------------------------------ */
  function getTab(route, def) { return state.tabs[route] || def; }
  function typeTabs(rows) {
    return [
      { id: 'all', label: 'All', n: rows.length },
      { id: 'pure', label: 'Pure', n: rows.filter(r => r.sample_type === 'pure').length },
      { id: 'mixture', label: 'Mixtures', n: rows.filter(r => r.sample_type === 'mixture').length },
    ];
  }
  const byTab = (rows, tab) => tab === 'all' ? rows : rows.filter(r => r.sample_type === tab);
  const openRowAttr = (table, id) => `class="clickable" data-action="open-row" data-table="${table}" data-id="${esc(id)}" tabindex="0"`;

  function secOverview(main, c) {
    const empty = c.c === 0 && c.e === 0 && c.s === 0;
    const recent = empty ? [] : q(`SELECT 'exp' AS k, experiment_id AS id, sample_type, compound_a, compound_b, x_a, temperature_k, date, created_at FROM v_experiments
      UNION ALL SELECT 'sim', simulation_id, sample_type, compound_a, compound_b, x_a, temperature_k, date, created_at FROM v_simulations
      ORDER BY created_at DESC, id DESC LIMIT 8`);
    const pure = q1("SELECT (SELECT count(*) FROM v_experiments WHERE sample_type='pure') AS pe, (SELECT count(*) FROM v_experiments WHERE sample_type='mixture') AS me, (SELECT count(*) FROM v_simulations WHERE sample_type='pure') AS ps, (SELECT count(*) FROM v_simulations WHERE sample_type='mixture') AS ms");
    const fact = (label, href, n, text) => `<div><dt>${label}</dt><dd><a href="#${href}">${n}</a>${text}</dd></div>`;
    main.innerHTML = `
      <section class="hero">
        <div>
          <p class="eyebrow">T₂ relaxation · Self-diffusion · Binary mixtures</p>
          <h1 class="display">NMR Relaxation Database</h1>
          <p class="lede">Measured and simulated T₂ and diffusion data for pure liquids and binary mixtures, kept in one SQLite file.</p>
          <p class="meta">SQLite ${esc(q1('SELECT sqlite_version() AS v').v)} · schema v${esc(metaGet('schema_version') ?? '?')}${metaGet('modified_at') ? ` · last change ${esc(metaGet('modified_at').slice(0, 10))}` : ''}</p>
          <div class="hero-cta">${fsSupported && !state.master && state.mode === 'normal' ? '<button class="btn primary" data-action="master-open">Open master file</button>' : '<a class="btn primary" href="#import">Import a file</a>'}${state.mode === 'normal' ? '<button class="btn" data-action="enter-example">Try example data</button>' : ''}</div>
        </div>
        <aside class="hero-card corner" aria-label="What is in the database">
          <dl class="quick-facts">
            ${fact('Compounds', 'constants', c.c, 'with constants and Hansen parameters')}
            ${fact('Experiments', 'experimental', c.e, `${pure.pe} pure, ${pure.me} mixtures`)}
            ${fact('Simulations', 'simulated', c.s, `${pure.ps} pure, ${pure.ms} mixtures`)}
            ${fact('Processed', 'processed', c.p, 'values from the analysis scripts')}
            ${fact('Sim vs exp', 'compare', c.x, 'matched pairs')}
            ${fact('Raw data', 'raw', c.r, 'file locations')}
          </dl>
        </aside>
      </section>
      <section class="band"><div class="labelled">
        <div><p class="section-num">Sharing</p><h2>Saving and sharing</h2></div>
        <div><ol class="steps-list">
            <li><span><strong>Keep master.sqlite in the lab's shared folder</strong> (OneDrive, Google Drive or Box) that syncs to your computer.</span></li>
            <li><span><strong>Open it here once</strong> with Open master file. This browser remembers it.</span></li>
            <li><span><strong>Edit, then Save to master.</strong> The sync app uploads the file, and others get your changes the next time they open the site.</span></li></ol>
          <p class="note" style="margin-top:16px">Saving straight to the file works in Chrome and Edge. In other browsers, open the file from the Export page and download a replacement. The site warns you if someone else saved the master after you opened it. Keep the database out of the GitHub repository: the site is public, the shared folder isn't.</p></div>
      </div></section>
      <section class="labelled" style="padding-top:28px">
        <div><p class="section-num">${empty ? 'Start' : 'Latest'}</p><h2>${empty ? 'Getting started' : 'Recently added'}</h2></div>
        <div>${empty ? `<ol class="steps-list">
            <li><span>Add compounds in <a href="#constants">Physical constants</a>, or import a list of them.</span></li>
            <li><span>Add experiments and simulations by hand, or import a CSV, JSON or Excel file.</span></li>
            <li><span>Import what the analysis scripts computed into <a href="#processed">Processed data</a>. <a href="#compare">Sim vs exp</a> then pairs it with the measurements.</span></li></ol>`
          : `<ul class="recent">${recent.map(r => `<li><a href="#" data-action="open-row" data-table="${r.k === 'exp' ? 'experiments' : 'simulations'}" data-id="${r.id}">
              <span class="kind">${r.k}</span><span>${sampleCell(r)}${r.sample_type === 'mixture' ? ` <span class="muted num">x<sub>A</sub> ${esc(fmtNum(r.x_a))}</span>` : ''}</span>
              <span class="muted num">${r.temperature_k != null ? esc(fmtNum(r.temperature_k)) + ' K' : ''}${r.date ? ' · ' + esc(r.date) : ''}</span></a></li>`).join('')}</ul>`}</div>
      </section>`;
  }

  function secConstants(main) {
    const tab = getTab('constants', 'pure');
    const comps = q('SELECT * FROM v_compounds ORDER BY name COLLATE NOCASE');
    const mixes = q('SELECT * FROM v_mixture_hsp ORDER BY compound_a, compound_b, x_a');
    const tabs = [{ id: 'pure', label: 'Pure compounds', n: comps.length }, { id: 'mixture', label: 'Mixtures (computed)', n: mixes.length }];
    if (tab === 'pure') {
      main.innerHTML = listSection({ id: 'compounds', eyebrow: 'Data', title: 'Physical constants', tab, tabs, csv: true,
        desc: 'One row per pure compound, with Hansen parameters (δD dispersion, δP polarity, δH hydrogen bonding) in MPa½.',
        actions: '<button class="btn primary" data-action="add" data-table="compounds">Add compound</button>' });
      mountTable('compounds', {
        id: 'compounds', rows: comps, rowAction: r => openRowAttr('compounds', r.compound_id),
        empty: emptyState('No compounds yet', 'Experiments and simulations pick their compounds from this list, so this is the place to start.', '<button class="btn primary" data-action="add" data-table="compounds">Add compound</button><a class="btn" href="#import">Import a list</a>'),
        cols: [
          { key: 'name', label: 'Name', render: r => `<span class="sample">${esc(r.name)}</span>` },
          { key: 'cas', label: 'CAS', cls: 'mono' },
          { key: 'formula', label: 'Formula' },
          { key: 'mw_g_mol', label: 'M', unit: 'g mol⁻¹', cls: 'n', render: r => numCell(r.mw_g_mol) },
          { key: 'density_g_cm3', label: 'ρ', unit: 'g cm⁻³', cls: 'n', render: r => numCell(r.density_g_cm3) },
          { key: 'molar_volume_cm3_mol', label: 'V<sub>m</sub>', unit: 'cm³ mol⁻¹', cls: 'n', render: r => numCell(r.molar_volume_cm3_mol, 5) },
          { key: 'hsp_d_mpa05', label: 'δD', unit: 'MPa½', cls: 'n', render: r => numCell(r.hsp_d_mpa05) },
          { key: 'hsp_p_mpa05', label: 'δP', unit: 'MPa½', cls: 'n', render: r => numCell(r.hsp_p_mpa05) },
          { key: 'hsp_h_mpa05', label: 'δH', unit: 'MPa½', cls: 'n', render: r => numCell(r.hsp_h_mpa05) },
          { key: 'hsp_total_mpa05', label: 'δt', unit: 'MPa½', cls: 'n', render: r => numCell(r.hsp_total_mpa05, 4) },
          { key: 'source', label: 'Source', cls: 'wrap' },
          { key: 'comments', label: 'Comments', cls: 'wrap' },
        ],
        csvCols: ['compound_id', 'name', 'cas', 'formula', 'smiles', 'mw_g_mol', 'density_g_cm3', 'molar_volume_cm3_mol', 'hsp_d_mpa05', 'hsp_p_mpa05', 'hsp_h_mpa05', 'hsp_total_mpa05', 'source', 'comments'],
      });
    } else {
      main.innerHTML = listSection({ id: 'mixhsp', eyebrow: 'Data', title: 'Physical constants', tab, tabs, csv: true,
        desc: 'Blend Hansen parameters for every mixture used in your experiments and simulations.',
        after: `<p class="note">Blend rule: δ<sub>mix</sub> = φ<sub>A</sub>δ<sub>A</sub> + φ<sub>B</sub>δ<sub>B</sub>, where φ is the volume fraction, φ<sub>A</sub> = x<sub>A</sub>V<sub>A</sub> / (x<sub>A</sub>V<sub>A</sub> + x<sub>B</sub>V<sub>B</sub>) and V = M/ρ. This assumes ideal mixing (no excess volume). Blank cells mean a compound is missing M, ρ or a Hansen parameter.</p>` });
      mountTable('mixhsp', {
        id: 'mixhsp', rows: mixes,
        empty: emptyState('No mixtures yet', 'Mixtures appear here automatically once an experiment or simulation uses two compounds.', ''),
        cols: [
          { key: 'compound_a', label: 'Sample', render: r => `<span class="sample">${esc(r.compound_a)}<span class="sep">/</span>${esc(r.compound_b)}</span>` },
          { key: 'x_a', label: 'x<sub>A</sub>', cls: 'n', render: r => numCell(r.x_a) },
          { key: 'volume_fraction_a', label: 'φ<sub>A</sub>', cls: 'n', render: r => numCell(r.volume_fraction_a, 4) },
          { key: 'hsp_d_mpa05', label: 'δD', unit: 'MPa½', cls: 'n', render: r => numCell(r.hsp_d_mpa05, 4) },
          { key: 'hsp_p_mpa05', label: 'δP', unit: 'MPa½', cls: 'n', render: r => numCell(r.hsp_p_mpa05, 4) },
          { key: 'hsp_h_mpa05', label: 'δH', unit: 'MPa½', cls: 'n', render: r => numCell(r.hsp_h_mpa05, 4) },
          { key: 'n_experiments', label: 'Exp.', cls: 'n' },
          { key: 'n_simulations', label: 'Sim.', cls: 'n' },
        ],
        csvCols: ['compound_a', 'compound_b', 'x_a', 'x_b', 'volume_fraction_a', 'hsp_d_mpa05', 'hsp_p_mpa05', 'hsp_h_mpa05', 'n_experiments', 'n_simulations'],
      });
    }
  }

  function secExperimental(main) {
    const tab = getTab('experimental', 'all');
    const all = q('SELECT * FROM v_experiments ORDER BY experiment_id DESC');
    main.innerHTML = listSection({ id: 'experiments', eyebrow: 'Data', title: 'Experimental', tab, tabs: typeTabs(all), csv: true,
      desc: 'One row per NMR measurement, with its acquisition settings and measured T₂ and D.',
      actions: '<button class="btn primary" data-action="add" data-table="experiments">Add experiment</button>' });
    mountTable('experiments', {
      id: 'experiments', rows: byTab(all, tab), rowAction: r => openRowAttr('experiments', r.experiment_id),
      empty: emptyState(all.length ? 'Nothing in this tab' : 'No experiments yet', all.length ? 'Switch tabs to see the other records.' : 'Add a measurement by hand, or import a spreadsheet of them.', all.length ? '' : '<button class="btn primary" data-action="add" data-table="experiments">Add experiment</button><a class="btn" href="#import">Import</a>'),
      cols: [
        { key: 'experiment_id', label: '#', cls: 'n', render: r => `<span class="id">${r.experiment_id}</span>` },
        { key: 'sample_type', label: 'Type', render: r => typeChip(r.sample_type) },
        { key: 'compound_a', label: 'Sample', render: sampleCell, sortVal: r => sampleText(r) },
        { key: 'x_a', label: 'x<sub>A</sub>', cls: 'n', render: xCell },
        { key: 'temperature_k', label: 'T', unit: 'K', cls: 'n', render: r => numCell(r.temperature_k) },
        { key: 'magnet', label: 'Magnet' },
        { key: 'pulse_sequence', label: 'Sequence' },
        { key: 'echo_times_s', label: 'Echo times', unit: 's', cls: 'mono' },
        { key: 'degassed', label: 'Degassed', render: r => degChip(r.degassed) },
        { key: 'n_scans', label: 'Scans', cls: 'n' },
        { key: 't2_s', label: 'T₂', unit: 's', cls: 'n', render: r => withErr(r.t2_s, r.t2_err_s) },
        { key: 'diffusion_m2_s', label: 'D', unit: 'm² s⁻¹', cls: 'n', render: r => withErr(r.diffusion_m2_s, r.diffusion_err_m2_s) },
        { key: 'location', label: 'Location' },
        { key: 'date', label: 'Date', cls: 'num' },
        { key: 'user_name', label: 'User' },
        { key: 'n_raw_files', label: 'Raw', cls: 'n', render: r => r.n_raw_files ? r.n_raw_files : '<span class="muted">0</span>' },
        { key: 'comments', label: 'Comments', cls: 'wrap' },
      ],
      csvCols: ['experiment_id', 'sample_type', 'compound_a', 'compound_b', 'x_a', 'x_b', 'temperature_k', 'magnet', 'pulse_sequence', 'echo_times_s', 'degassed', 'n_scans', 't2_s', 't2_err_s', 'diffusion_m2_s', 'diffusion_err_m2_s', 'location', 'date', 'user_name', 'n_raw_files', 'comments'],
    });
  }

  function secSimulated(main) {
    const tab = getTab('simulated', 'all');
    const all = q('SELECT * FROM v_simulations ORDER BY simulation_id DESC');
    main.innerHTML = listSection({ id: 'simulations', eyebrow: 'Data', title: 'Simulated', tab, tabs: typeTabs(all), csv: true,
      desc: 'One row per MD run; the values computed from each run are in Processed data.',
      actions: '<button class="btn primary" data-action="add" data-table="simulations">Add simulation</button>' });
    mountTable('simulations', {
      id: 'simulations', rows: byTab(all, tab), rowAction: r => openRowAttr('simulations', r.simulation_id),
      empty: emptyState(all.length ? 'Nothing in this tab' : 'No simulations yet', all.length ? 'Switch tabs to see the other records.' : 'Register each MD run here, then attach its computed values in Processed data.', all.length ? '' : '<button class="btn primary" data-action="add" data-table="simulations">Add simulation</button><a class="btn" href="#import">Import</a>'),
      cols: [
        { key: 'simulation_id', label: '#', cls: 'n', render: r => `<span class="id">${r.simulation_id}</span>` },
        { key: 'sample_type', label: 'Type', render: r => typeChip(r.sample_type) },
        { key: 'compound_a', label: 'Sample', render: sampleCell, sortVal: r => sampleText(r) },
        { key: 'x_a', label: 'x<sub>A</sub>', cls: 'n', render: xCell },
        { key: 'temperature_k', label: 'T', unit: 'K', cls: 'n', render: r => numCell(r.temperature_k) },
        { key: 'n_molecules_a', label: 'N<sub>A</sub> / N<sub>B</sub>', cls: 'n', render: r => r.n_molecules_a == null && r.n_molecules_b == null ? '' : `${r.n_molecules_a ?? '–'} / ${r.n_molecules_b ?? '–'}` },
        { key: 'force_field', label: 'Force field' },
        { key: 'software', label: 'Software' },
        { key: 'production_ns', label: 'Length', unit: 'ns', cls: 'n', render: r => numCell(r.production_ns) },
        { key: 't2_total_s', label: 'T₂ total', unit: 's', cls: 'wrap num', render: r => r.t2_total_s ? esc(r.t2_total_s) : '<span class="muted">—</span>' },
        { key: 'd_total_m2_s', label: 'D total', unit: 'm² s⁻¹', cls: 'wrap num', render: r => r.d_total_m2_s ? esc(r.d_total_m2_s) : '<span class="muted">—</span>' },
        { key: 'n_results', label: 'Results', cls: 'n' },
        { key: 'location', label: 'Location' },
        { key: 'date', label: 'Date', cls: 'num' },
        { key: 'user_name', label: 'User' },
        { key: 'n_raw_files', label: 'Raw', cls: 'n' },
        { key: 'comments', label: 'Comments', cls: 'wrap' },
      ],
      csvCols: ['simulation_id', 'sample_type', 'compound_a', 'compound_b', 'x_a', 'x_b', 'temperature_k', 'n_molecules_a', 'n_molecules_b', 'force_field', 'software', 'production_ns', 'timestep_fs', 't2_total_s', 'd_total_m2_s', 'n_results', 'location', 'date', 'user_name', 'n_raw_files', 'comments'],
    });
  }

  function secProcessed(main) {
    const tab = getTab('processed', 'all');
    if (tab === 'quantities') {
      const all = q('SELECT q.*, (SELECT count(*) FROM processed_results pr WHERE pr.quantity = q.quantity) AS n_used FROM quantities q ORDER BY q.quantity');
      const total = q1('SELECT count(*) AS n FROM processed_results').n;
      main.innerHTML = listSection({ id: 'quantities', eyebrow: 'Data', title: 'Processed data', tab, csv: true,
        tabs: [{ id: 'all', label: 'All', n: total }, { id: 'pure', label: 'Pure' }, { id: 'mixture', label: 'Mixtures' }, { id: 'quantities', label: 'Quantities', n: all.length }],
        desc: 'Each kind of result, and the single unit its values are stored in.',
        actions: '<button class="btn primary" data-action="add" data-table="quantities">Add quantity</button>' });
      mountTable('quantities', {
        id: 'quantities', rows: all, rowAction: r => openRowAttr('quantities', r.quantity), empty: '',
        cols: [
          { key: 'quantity', label: 'Quantity', cls: 'mono' },
          { key: 'unit', label: 'Unit', render: r => esc(prettyUnit(r.unit)) },
          { key: 'description', label: 'Description', cls: 'wrap' },
          { key: 'n_used', label: 'Values', cls: 'n' },
        ],
        csvCols: ['quantity', 'unit', 'description', 'n_used'],
      });
      return;
    }
    const all = q('SELECT * FROM v_processed ORDER BY simulation_id DESC, quantity, species, contribution, result_id');
    const nq = q1('SELECT count(*) AS n FROM quantities').n;
    main.innerHTML = listSection({ id: 'processed', eyebrow: 'Data', title: 'Processed data', tab, csv: true,
      tabs: [...typeTabs(all), { id: 'quantities', label: 'Quantities', n: nq }],
      desc: 'Every value computed from a simulation, one per row, labelled by quantity, species, contribution and method.',
      actions: '<button class="btn primary" data-action="add" data-table="processed_results">Add result</button>' });
    mountTable('processed', {
      id: 'processed', rows: byTab(all, tab), rowAction: r => openRowAttr('processed_results', r.result_id),
      empty: emptyState(all.length ? 'Nothing in this tab' : 'No processed values yet', all.length ? 'Switch tabs to see the other records.' : 'Import the output of your intra, inter and results scripts. Each value is linked to its simulation.', all.length ? '' : '<a class="btn primary" href="#import">Import results</a><button class="btn" data-action="add" data-table="processed_results">Add one by hand</button>'),
      cols: [
        { key: 'result_id', label: '#', cls: 'n', render: r => `<span class="id">${r.result_id}</span>` },
        { key: 'simulation_id', label: 'Sim', cls: 'n', render: r => `<span class="id">#${r.simulation_id}</span>` },
        { key: 'compound_a', label: 'Sample', render: sampleCell, sortVal: r => sampleText(r) },
        { key: 'x_a', label: 'x<sub>A</sub>', cls: 'n', render: xCell },
        { key: 'temperature_k', label: 'T', unit: 'K', cls: 'n', render: r => numCell(r.temperature_k) },
        { key: 'quantity', label: 'Quantity', cls: 'mono' },
        { key: 'species', label: 'Species', render: r => r.species_compound_id == null ? '<span class="muted">whole sample</span>' : esc(r.species) },
        { key: 'contribution', label: 'Contribution' },
        { key: 'method', label: 'Method', cls: 'wrap' },
        { key: 'value', label: 'Value', cls: 'n', render: r => withErr(r.value, r.uncertainty) },
        { key: 'unit', label: 'Unit', render: r => esc(prettyUnit(r.unit)) },
        { key: 'script', label: 'Script' },
        { key: 'source_path', label: 'Source file', cls: 'mono path' },
        { key: 'date', label: 'Date', cls: 'num' },
      ],
      csvCols: ['result_id', 'simulation_id', 'sample_type', 'compound_a', 'compound_b', 'x_a', 'temperature_k', 'quantity', 'species', 'contribution', 'method', 'value', 'uncertainty', 'unit', 'script', 'source_path', 'date', 'comments'],
    });
  }

  /* --- Sim vs Exp: parity plot ---------------------------------------- */
  function niceStep(span, n) {
    const raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }
  function parityPlot(points, quantity) {
    const scale = quantity === 'D' ? 1e9 : 1;
    const unitLabel = quantity === 'D' ? '10⁻⁹ m² s⁻¹' : 's';
    const sym = quantity === 'D' ? 'D' : 'T₂';
    const pts = points.map(p => ({ ...p, x: p.x * scale, y: p.y * scale })).filter(p => p.x > 0 && p.y > 0);
    const W = 380, H = 360, m = { l: 54, r: 14, t: 14, b: 46 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    if (!pts.length) return `<svg class="plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="Parity plot (no data)"><rect class="frame" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}"/><text x="${m.l + pw / 2}" y="${m.t + ph / 2}" text-anchor="middle">No pairs to plot</text></svg>`;
    const vals = pts.flatMap(p => [p.x, p.y]);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const log = hi / lo > 20;
    let d0, d1, ticks;
    if (log) {
      d0 = Math.pow(10, Math.floor(Math.log10(lo))); d1 = Math.pow(10, Math.ceil(Math.log10(hi)));
      ticks = [];
      for (let e = Math.log10(d0); e <= Math.log10(d1) + 1e-9; e++) ticks.push(Math.pow(10, e));
    } else {
      const span = (hi - lo) || hi * 0.2 || 1;
      const step = niceStep(span * 1.25, 5);
      d0 = Math.max(0, Math.floor((lo - span * 0.12) / step) * step);
      d1 = Math.ceil((hi + span * 0.12) / step) * step;
      ticks = [];
      for (let v = d0; v <= d1 + step * 1e-6; v += step) ticks.push(Number(v.toPrecision(10)));
    }
    const t = v => log ? (Math.log10(v) - Math.log10(d0)) / (Math.log10(d1) - Math.log10(d0)) : (v - d0) / (d1 - d0);
    const sx = v => m.l + t(v) * pw, sy = v => m.t + ph - t(v) * ph;
    // ±10% band, sampled along x and clipped to the frame
    const N = 48, xs = [];
    for (let i = 0; i <= N; i++) xs.push(log ? Math.pow(10, Math.log10(d0) + (Math.log10(d1) - Math.log10(d0)) * i / N) : d0 + (d1 - d0) * i / N);
    const upper = xs.map(x => `${sx(x).toFixed(1)},${sy(Math.min(x * 1.1, d1 * 2)).toFixed(1)}`);
    const lower = xs.slice().reverse().map(x => `${sx(x).toFixed(1)},${sy(Math.max(x * 0.9, log ? d0 / 2 : d0 - (d1 - d0))).toFixed(1)}`);
    const tickLbl = v => fmtNum(v, 3);
    const grid = ticks.map(v => `<line class="gridline" x1="${sx(v)}" x2="${sx(v)}" y1="${m.t}" y2="${m.t + ph}"/><line class="gridline" y1="${sy(v)}" y2="${sy(v)}" x1="${m.l}" x2="${m.l + pw}"/>
      <text x="${sx(v)}" y="${m.t + ph + 15}" text-anchor="middle">${esc(tickLbl(v))}</text><text x="${m.l - 6}" y="${sy(v) + 4}" text-anchor="end">${esc(tickLbl(v))}</text>`).join('');
    const circles = pts.map(p => `<circle class="pt ${p.cls}" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4.6"><title>${esc(p.title)}</title></circle>`).join('');
    return `<svg class="plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="Parity plot of simulated versus experimental ${sym}">
      <defs><clipPath id="plot-clip"><rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}"/></clipPath></defs>
      ${grid}
      <g clip-path="url(#plot-clip)"><polygon class="band" points="${upper.concat(lower).join(' ')}"/>
      <line class="identity" x1="${sx(d0)}" y1="${sy(d0)}" x2="${sx(d1)}" y2="${sy(d1)}"/></g>
      <rect class="frame" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}"/>
      ${circles}
      <text class="axis-title" x="${m.l + pw / 2}" y="${H - 6}" text-anchor="middle">Experimental ${sym} / ${unitLabel}${log ? ' (log)' : ''}</text>
      <text class="axis-title" transform="translate(13 ${m.t + ph / 2}) rotate(-90)" text-anchor="middle">Simulated ${sym} / ${unitLabel}</text>
    </svg>`;
  }

  function secCompare(main) {
    const tab = getTab('compare', 'all');
    const qty = state.compare.quantity;
    const tol = { x: metaGet('match_tol_x') ?? '0.01', t: metaGet('match_tol_t_k') ?? '1.0' };
    const allQ = q('SELECT * FROM v_sim_vs_exp WHERE quantity = ? ORDER BY compound_1, compound_2, x_1, temperature_exp_k, sim_method', [qty]);
    const methods = [...new Set(allQ.map(r => r.sim_method ?? ''))];
    if (state.compare.method && !methods.includes(state.compare.method)) state.compare.method = '';
    const rows = byTab(allQ, tab)
      .filter(r => !state.compare.method || (r.sim_method ?? '') === state.compare.method)
      .filter(r => !state.compare.degassedOnly || r.exp_degassed === 1);
    const filtered = filterRows(rows, state.search.compare);
    const ratios = filtered.map(r => r.ratio).filter(Number.isFinite);
    const absPct = filtered.map(r => Math.abs(r.pct_diff)).filter(Number.isFinite);
    const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
    const sym = qty === 'D' ? 'D' : 'T₂';
    const ratioCls = p => Math.abs(p) > 25 ? 'bad' : '';
    const sampleOf = r => r.sample_type === 'pure' ? `<span class="sample">${esc(r.compound_1)}</span>` : `<span class="sample">${esc(r.compound_1)}<span class="sep">/</span>${esc(r.compound_2)}</span><div class="sub-note">x(${esc(r.compound_1)}) = ${esc(fmtNum(r.x_1))}</div>`;
    const methodSel = `<select id="cmp-method" aria-label="Simulation method" style="width:auto;height:30px"><option value="">All methods</option>${methods.map(m => `<option value="${esc(m)}" ${m === state.compare.method ? 'selected' : ''}>${esc(m || '(no method)')}</option>`).join('')}</select>`;
    main.innerHTML = listSection({ id: 'compare', eyebrow: 'Data', title: 'Sim vs exp', tab, tabs: typeTabs(allQ), csv: true,
      desc: `Simulated and measured ${sym} paired by compounds (in either order), x within ${esc(tol.x)} and T within ${esc(tol.t)} K.`,
      extraTools: `<label>Quantity <select id="cmp-qty" style="width:auto;height:30px"><option value="T2" ${qty === 'T2' ? 'selected' : ''}>T₂</option><option value="D" ${qty === 'D' ? 'selected' : ''}>D</option></select></label>${methodSel}
        <label><input type="checkbox" id="cmp-degassed" ${state.compare.degassedOnly ? 'checked' : ''}> Degassed only</label>`,
      before: `<div class="compare-grid"><div class="sheet sheet-pad corner" id="cmp-plot"></div><div><h2>Agreement</h2>
        ${filtered.length ? `<dl class="kv"><dt>Pairs</dt><dd class="num">${filtered.length}</dd><dt>Mean ratio sim / exp</dt><dd class="num">${esc(fmtNum(mean(ratios), 4))}</dd>
          <dt>Mean |difference|</dt><dd class="num">${esc(fmtNum(mean(absPct), 3))} %</dd><dt>Largest |difference|</dt><dd class="num">${esc(fmtNum(Math.max(...absPct), 3))} %</dd></dl>` : '<p class="muted">No pairs in this view.</p>'}
        <p class="note" style="margin-top:14px">Dissolved O₂ is paramagnetic and shortens T₂, so samples that were not degassed usually relax faster than a simulation without O₂ predicts. Those points are drawn hollow.</p>
        <p class="note" style="margin-top:8px">The dashed line is perfect agreement and the shaded band is ±10 %. Matching tolerances are on the <a href="#settings">Export</a> page.</p></div></div>` });
    $('#cmp-plot').innerHTML = parityPlot(filtered.map(r => ({
      x: r.exp_value, y: r.sim_value,
      cls: r.exp_degassed === 1 ? 'degassed' : r.exp_degassed === 0 ? 'not-degassed' : 'unknown',
      title: `${r.compound_1}${r.compound_2 ? ' / ' + r.compound_2 + ', x = ' + fmtNum(r.x_1) : ''} · ${fmtNum(r.temperature_exp_k)} K\n${r.sim_method || 'no method'}\nsim ${fmtNum(r.sim_value)} · exp ${fmtNum(r.exp_value)} · ratio ${fmtNum(r.ratio, 4)}`,
    })), qty) + `<div class="legend">${[['degassed', 'degassed'], ['not-degassed', 'not degassed'], ['unknown', 'unknown']].map(([c, l]) => `<span><svg class="plot" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><circle class="pt ${c}" cx="5" cy="5" r="4"/></svg>${l}</span>`).join('')}</div>`;
    $('#cmp-method').addEventListener('change', e => { state.compare.method = e.target.value; render(); });
    $('#cmp-qty').addEventListener('change', e => { state.compare.quantity = e.target.value; state.compare.method = ''; render(); });
    $('#cmp-degassed').addEventListener('change', e => { state.compare.degassedOnly = e.target.checked; render(); });
    mountTable('compare', {
      id: 'compare', rows,
      empty: emptyState('No pairs yet', `A pair appears when a simulation has a whole-sample, total ${sym} in Processed data and an experiment on the same sample at a similar temperature has a measured ${sym}.`, ''),
      cols: [
        { key: 'sample_type', label: 'Type', render: r => typeChip(r.sample_type) },
        { key: 'compound_1', label: 'Sample', render: sampleOf, sortVal: r => `${r.compound_1} ${r.compound_2 || ''} ${r.x_1}` },
        { key: 'temperature_exp_k', label: 'T exp / sim', unit: 'K', cls: 'n', render: r => `${numCell(r.temperature_exp_k)} / ${numCell(r.temperature_sim_k)}` },
        { key: 'sim_method', label: 'Method', cls: 'wrap' },
        { key: 'sim_value', label: `${sym} sim`, unit: prettyUnit(r0(allQ)), cls: 'n', render: r => withErr(r.sim_value, r.sim_uncertainty) },
        { key: 'exp_value', label: `${sym} exp`, unit: prettyUnit(r0(allQ)), cls: 'n', render: r => withErr(r.exp_value, r.exp_uncertainty) },
        { key: 'ratio', label: 'Ratio', cls: 'n', render: r => numCell(r.ratio, 4) },
        { key: 'pct_diff', label: 'Diff.', unit: '%', cls: 'n', render: r => `<span class="ratio ${ratioCls(r.pct_diff)}">${esc(fmtNum(r.pct_diff, 3))}</span>` },
        { key: 'z_score', label: 'z', cls: 'n', render: r => numCell(r.z_score, 3) },
        { key: 'exp_degassed', label: 'Degassed', render: r => degChip(r.exp_degassed) },
        { key: 'simulation_id', label: 'Records', render: r => `<button class="linkish" data-action="open-row" data-table="simulations" data-id="${r.simulation_id}">sim ${r.simulation_id}</button> · <button class="linkish" data-action="open-row" data-table="experiments" data-id="${r.experiment_id}">exp ${r.experiment_id}</button>`, sort: false },
      ],
      csvCols: ['sample_type', 'quantity', 'unit', 'compound_1', 'compound_2', 'x_1', 'x_1_exp', 'temperature_sim_k', 'temperature_exp_k', 'sim_method', 'sim_value', 'sim_uncertainty', 'exp_value', 'exp_uncertainty', 'ratio', 'pct_diff', 'z_score', 'exp_degassed', 'exp_magnet', 'exp_pulse_sequence', 'simulation_id', 'experiment_id', 'result_id'],
    });
  }
  const r0 = rows => (rows[0] && rows[0].unit) || (state.compare.quantity === 'D' ? 'm^2/s' : 's');

  function secRaw(main) {
    const tab = getTab('raw', 'all');
    const all = q('SELECT * FROM v_raw_data ORDER BY raw_id DESC');
    const tabs = [
      { id: 'all', label: 'All', n: all.length },
      { id: 'experimental', label: 'Experimental', n: all.filter(r => r.linked_to === 'experimental').length },
      { id: 'simulated', label: 'Simulated', n: all.filter(r => r.linked_to === 'simulated').length },
      { id: 'unlinked', label: 'Unlinked', n: all.filter(r => r.linked_to === 'unlinked').length },
    ];
    main.innerHTML = listSection({ id: 'raw', eyebrow: 'Data', title: 'Raw data', tab, tabs, csv: true,
      desc: 'Paths to the raw files behind each experiment and simulation; the files themselves stay where they are.',
      actions: '<button class="btn primary" data-action="add" data-table="raw_data">Add location</button>' });
    mountTable('raw', {
      id: 'raw', rows: tab === 'all' ? all : all.filter(r => r.linked_to === tab), rowAction: r => openRowAttr('raw_data', r.raw_id),
      empty: emptyState(all.length ? 'Nothing in this tab' : 'No raw-data locations yet', all.length ? 'Switch tabs to see the other records.' : 'Paths entered on an experiment or simulation appear here too.', all.length ? '' : '<button class="btn primary" data-action="add" data-table="raw_data">Add location</button>'),
      cols: [
        { key: 'raw_id', label: '#', cls: 'n', render: r => `<span class="id">${r.raw_id}</span>` },
        { key: 'linked_to', label: 'Linked to', render: r => r.linked_to === 'unlinked' ? '<span class="muted">—</span>' : `${r.linked_to === 'experimental' ? 'exp' : 'sim'} ${r.record_id}` },
        { key: 'compound_a', label: 'Sample', render: r => r.compound_a ? sampleCell(r) : '' },
        { key: 'path', label: 'Path', cls: 'mono path' },
        { key: 'file_type', label: 'File type' },
        { key: 'description', label: 'Description', cls: 'wrap' },
        { key: 'comments', label: 'Comments', cls: 'wrap' },
      ],
      csvCols: ['raw_id', 'linked_to', 'record_id', 'compound_a', 'compound_b', 'x_a', 'path', 'file_type', 'description', 'comments', 'experiment_id', 'simulation_id'],
    });
  }

  /* ------------------------------------------------------------------ *
   *  Drawer: add / edit / duplicate / delete one record
   * ------------------------------------------------------------------ */
  let drawer = null;

  function loadRecord(table, id) {
    const cfg = FORMS[table];
    const r = q1(`SELECT * FROM ${cfg.table} WHERE ${cfg.pk} = ?`, [id]);
    if (!r) return null;
    if (table === 'experiments' || table === 'simulations') {
      r.__paths = q(`SELECT path FROM raw_data WHERE ${cfg.pk} = ? ORDER BY raw_id`, [id]).map(x => x.path).join('\n');
    }
    return r;
  }

  function openForm(table, id, preset) {
    const cfg = FORMS[table];
    let values, mode;
    if (id != null && id !== '') {
      values = loadRecord(table, table === 'quantities' ? id : Number(id));
      if (!values) { toast('That record no longer exists.', { err: true }); return; }
      mode = 'edit';
    } else {
      mode = 'new';
      values = {};
      for (const f of allFields(cfg)) if (f.default) values[f.key] = f.default();
      if (table === 'experiments' || table === 'simulations') values.x_a = 1;
      Object.assign(values, preset || {});
    }
    drawer = { table, id: mode === 'edit' ? values[cfg.pk] : null, mode, values, copyOf: preset && preset.__copyOf };
    renderDrawer();
  }

  function closeDrawer() { drawer = null; const o = $('#overlay'); if (o && !$('.modal', o)) o.innerHTML = ''; }

  function datalistHtml(key, table) {
    let items = SUGGEST[key] ? SUGGEST[key].slice() : [];
    const src = { magnet: 'experiments', pulse_sequence: 'experiments', user_name: null, location: null, force_field: 'simulations', software: 'simulations', contribution: 'processed_results', method: 'processed_results', script: 'processed_results', file_type: 'raw_data' }[key];
    let existing = [];
    if (key === 'user_name' || key === 'location') existing = [...distinct('experiments', key), ...distinct('simulations', key)];
    else if (src) existing = distinct(src, key);
    items = [...new Set([...existing, ...items])];
    return `<datalist id="dl_${key}">${items.map(v => `<option value="${esc(v)}"></option>`).join('')}</datalist>`;
  }

  function unitSelect(key, kind, selected) {
    const u = UNITS[kind];
    return `<select data-unit-for="${key}" aria-label="Unit">${u.list.map(([lab]) => `<option ${lab === (selected || u.base) ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
  }

  function compoundOptions(selected, allowNone) {
    const list = compoundsList();
    return (allowNone ? '<option value="">— choose —</option>' : '<option value="">— choose a compound —</option>') +
      list.map(c => `<option value="${c.compound_id}" ${Number(selected) === c.compound_id ? 'selected' : ''}>${esc(c.name)}${c.cas ? ` (${esc(c.cas)})` : ''}</option>`).join('') +
      '<option value="__new">＋ New compound…</option>';
  }

  function qtyKind(qty) {
    const row = q1('SELECT unit FROM quantities WHERE quantity = ?', [qty]);
    return row ? { kind: QTY_UNIT_KIND[row.unit] || null, unit: row.unit } : { kind: null, unit: '' };
  }

  function fieldHtml(f, v) {
    const id = `f_${f.key}`;
    const req = f.required ? ' <span class="req" title="Required">*</span>' : '';
    const hint = f.hint ? `<div class="hint">${esc(f.hint)}</div>` : '';
    const wrap = (inner, labelFor = id) => `<div class="field ${f.full ? 'full' : ''}" data-field="${f.key}"><label for="${labelFor}">${esc(f.label)}${req}</label>${inner}${hint}<div class="err" hidden></div></div>`;
    switch (f.type) {
      case 'text':
        return wrap(`<input type="text" id="${id}" data-key="${f.key}" value="${esc(v ?? '')}" ${f.list ? `list="dl_${f.list}"` : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} class="${f.mono ? 'mono' : ''}" autocomplete="off">${f.list ? datalistHtml(f.list) : ''}`);
      case 'textarea':
        return wrap(`<textarea id="${id}" data-key="${f.key}" rows="3">${esc(v ?? '')}</textarea>`);
      case 'paths':
        return wrap(`<textarea id="${id}" data-key="${f.key}" class="mono" rows="3" placeholder="/path/to/data">${esc(v ?? '')}</textarea>`);
      case 'date':
        return wrap(`<input type="date" id="${id}" data-key="${f.key}" value="${esc(v ?? '')}">`);
      case 'int':
        return wrap(`<input type="text" inputmode="numeric" id="${id}" data-key="${f.key}" value="${esc(v ?? '')}">`);
      case 'number': {
        const val = v == null ? '' : String(v);
        if (f.kind) return wrap(`<div class="unit-input"><input type="text" inputmode="decimal" id="${id}" data-key="${f.key}" value="${esc(val)}" autocomplete="off">${unitSelect(f.key, f.kind)}</div>`);
        if (f.kindFromQty) {
          const qk = qtyKind(drawer.values.quantity);
          return wrap(`<div class="unit-input" data-qty-unit="${f.key}"><input type="text" inputmode="decimal" id="${id}" data-key="${f.key}" value="${esc(val)}" autocomplete="off">${qk.kind ? unitSelect(f.key, qk.kind) : `<span class="unit-static">${esc(prettyUnit(qk.unit) || '—')}</span>`}</div>`);
        }
        if (f.unit) return wrap(`<div class="unit-input"><input type="text" inputmode="decimal" id="${id}" data-key="${f.key}" value="${esc(val)}" autocomplete="off"><span class="unit-static">${esc(f.unit)}</span></div>`);
        return wrap(`<input type="text" inputmode="decimal" id="${id}" data-key="${f.key}" value="${esc(val)}">`);
      }
      case 'echo':
        return wrap(`<div class="unit-input"><input type="text" id="${id}" data-key="${f.key}" value="${esc(v ?? '')}" placeholder="e.g. 0.0005, 0.001" class="mono">${unitSelect(f.key, 'time')}</div>`);
      case 'bool3': {
        const r = (val, lab) => `<label><input type="radio" name="b_${f.key}" value="${val}" ${String(v ?? '') === val ? 'checked' : ''}> ${lab}</label>`;
        return `<fieldset class="radios field" data-field="${f.key}"><legend>${esc(f.label)}</legend><div class="radio-row">${r('1', 'Yes')}${r('0', 'No')}${r('', 'Unknown')}</div>${hint}</fieldset>`;
      }
      case 'mixture': {
        const vals = drawer.values;
        const isMix = vals.compound_b_id != null;
        return `<div class="field full" data-field="__mixture">
          <fieldset class="radios"><legend>Sample</legend><div class="radio-row"><label><input type="radio" name="mixmode" value="pure" ${isMix ? '' : 'checked'}> Pure liquid</label><label><input type="radio" name="mixmode" value="mixture" ${isMix ? 'checked' : ''}> Binary mixture</label></div></fieldset>
          <div class="mix-row">
            <div class="field" data-field="compound_a_id"><label for="f_compound_a_id"><span data-mix-label>${isMix ? 'Compound A' : 'Compound'}</span> <span class="req">*</span></label><select id="f_compound_a_id" data-key="compound_a_id" data-compound>${compoundOptions(vals.compound_a_id)}</select><div class="err" hidden></div></div>
            <div class="field" data-field="compound_b_id" ${isMix ? '' : 'hidden'}><label for="f_compound_b_id">Compound B <span class="req">*</span></label><select id="f_compound_b_id" data-key="compound_b_id" data-compound>${compoundOptions(vals.compound_b_id)}</select><div class="err" hidden></div></div>
          </div>
          <div class="inline-new" id="new-compound-row" hidden><input type="text" id="new-compound-name" placeholder="New compound name" aria-label="New compound name"><button type="button" class="btn" data-action="create-compound">Add</button><button type="button" class="linkish" data-action="cancel-compound">Cancel</button></div>
          <div class="field" data-field="x_a" ${isMix ? '' : 'hidden'}><label for="f_x_a">Mole fraction of A, x<sub>A</sub> <span class="req">*</span></label>
            <div class="xa-row"><input type="range" min="0" max="1" step="0.01" id="f_x_a_range" value="${esc(vals.x_a ?? 0.5)}" aria-label="Mole fraction slider"><input type="text" inputmode="decimal" id="f_x_a" data-key="x_a" value="${esc(vals.x_a ?? '')}"></div>
            <div class="xa-read" id="xb-read">${xbText(vals.x_a)}</div><div class="err" hidden></div></div>
        </div>`;
      }
      case 'select-sim': {
        const sims = q('SELECT * FROM v_simulations ORDER BY simulation_id DESC');
        return wrap(`<select id="${id}" data-key="${f.key}"><option value="">— choose a simulation —</option>${sims.map(s => `<option value="${s.simulation_id}" ${Number(v) === s.simulation_id ? 'selected' : ''}>${esc(simOptionLabel(s))}</option>`).join('')}</select>${sims.length ? '' : '<div class="hint">Add a simulation first.</div>'}`);
      }
      case 'select-qty': {
        const qs = quantitiesList();
        return wrap(`<select id="${id}" data-key="${f.key}"><option value="">— choose —</option>${qs.map(x => `<option value="${esc(x.quantity)}" ${v === x.quantity ? 'selected' : ''}>${esc(x.quantity)} (${esc(prettyUnit(x.unit))})</option>`).join('')}</select>`);
      }
      case 'species':
        return wrap(`<select id="${id}" data-key="${f.key}">${speciesOptions(drawer.values.simulation_id, v)}</select>`);
      case 'link': {
        const vals = drawer.values;
        const kind = vals.experiment_id != null ? 'exp' : vals.simulation_id != null ? 'sim' : 'none';
        const r = (val, lab) => `<label><input type="radio" name="linkkind" value="${val}" ${kind === val ? 'checked' : ''}> ${lab}</label>`;
        return `<div class="field full" data-field="__link"><fieldset class="radios"><legend>Linked to</legend><div class="radio-row">${r('none', 'Nothing')}${r('exp', 'An experiment')}${r('sim', 'A simulation')}</div></fieldset>
          <select id="f_link_exp" data-key="experiment_id" aria-label="Experiment" ${kind === 'exp' ? '' : 'hidden'}><option value="">— choose —</option>${q('SELECT * FROM v_experiments ORDER BY experiment_id DESC').map(e => `<option value="${e.experiment_id}" ${vals.experiment_id === e.experiment_id ? 'selected' : ''}>${esc(expOptionLabel(e))}</option>`).join('')}</select>
          <select id="f_link_sim" data-key="simulation_id" aria-label="Simulation" ${kind === 'sim' ? '' : 'hidden'}><option value="">— choose —</option>${q('SELECT * FROM v_simulations ORDER BY simulation_id DESC').map(s => `<option value="${s.simulation_id}" ${vals.simulation_id === s.simulation_id ? 'selected' : ''}>${esc(simOptionLabel(s))}</option>`).join('')}</select>
          <div class="err" hidden></div></div>`;
      }
      default: return '';
    }
  }
  const xbText = x => { const n = parseNum(x); return Number.isFinite(n) && n >= 0 && n <= 1 ? `x<sub>B</sub> = ${esc(fmtNum(clean(1 - n)))}` : 'x<sub>B</sub> = 1 − x<sub>A</sub>'; };

  function speciesOptions(simId, selected) {
    let opts = `<option value="">Whole sample</option>`;
    const s = simId ? q1('SELECT * FROM v_simulations WHERE simulation_id = ?', [Number(simId)]) : null;
    if (s) {
      opts += `<option value="${s.compound_a_id}" ${Number(selected) === s.compound_a_id ? 'selected' : ''}>${esc(s.compound_a)}</option>`;
      if (s.compound_b_id != null) opts += `<option value="${s.compound_b_id}" ${Number(selected) === s.compound_b_id ? 'selected' : ''}>${esc(s.compound_b)}</option>`;
    }
    return opts;
  }

  function renderDrawer() {
    const cfg = FORMS[drawer.table];
    const v = drawer.values;
    const title = drawer.mode === 'edit' ? cfg.title(v) : `New ${cfg.noun}${drawer.copyOf ? ` (copy of #${drawer.copyOf})` : ''}`;
    const eyebrow = { compounds: 'Physical constants', experiments: 'Experimental', simulations: 'Simulated', processed_results: 'Processed data', raw_data: 'Raw data', quantities: 'Quantities' }[drawer.table];
    let extra = '';
    if (drawer.table === 'simulations' && drawer.mode === 'edit') {
      const res = q('SELECT * FROM v_processed WHERE simulation_id = ? ORDER BY quantity, species, contribution', [drawer.id]);
      extra = `<div class="form-sec"><div class="form-sec-title">Processed results (${res.length})</div>
        ${res.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Quantity</th><th>Species</th><th>Contribution</th><th>Method</th><th class="n">Value</th></tr></thead><tbody>
        ${res.map(r => `<tr ${openRowAttr('processed_results', r.result_id)}><td class="mono">${esc(r.quantity)}</td><td>${r.species_compound_id == null ? '<span class="muted">whole</span>' : esc(r.species)}</td><td>${esc(r.contribution)}</td><td>${esc(r.method ?? '')}</td><td class="n">${withErr(r.value, r.uncertainty)} <span class="muted">${esc(prettyUnit(r.unit))}</span></td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted" style="margin:0">None yet.</p>'}
        <div><button type="button" class="btn sm" data-action="add-result-for-sim" data-id="${drawer.id}">Add result for this simulation</button></div></div>`;
    }
    if (drawer.table === 'compounds' && drawer.mode === 'edit') {
      const u = q1('SELECT (SELECT count(*) FROM experiments WHERE ? IN (compound_a_id, compound_b_id)) AS e, (SELECT count(*) FROM simulations WHERE ? IN (compound_a_id, compound_b_id)) AS s', [drawer.id, drawer.id]);
      extra = `<div class="form-sec"><div class="form-sec-title">Used by</div><p style="margin:0" class="muted">${plural(u.e, 'experiment')} · ${plural(u.s, 'simulation')}</p></div>`;
    }
    const lockedName = drawer.table === 'quantities' && drawer.mode === 'edit' && BUILTIN_QUANTITIES.includes(drawer.id);
    const usedQty = drawer.table === 'quantities' && drawer.mode === 'edit' ? q1('SELECT count(*) AS n FROM processed_results WHERE quantity = ?', [drawer.id]).n : 0;
    $('#overlay').innerHTML = `<div class="scrim" data-action="drawer-close"></div>
      <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <div class="drawer-head"><div class="grow"><p class="eyebrow">${esc(eyebrow)}</p><h2 id="drawer-title">${esc(title)}</h2></div><button class="linkish" data-action="drawer-close">Close</button></div>
        <div class="drawer-body"><form id="record-form" novalidate>
          <div id="form-error"></div>
          ${cfg.sections.map(s => `<div class="form-sec"><div class="form-sec-title">${esc(s.title)}</div><div class="form-grid">${s.fields.map(f => fieldHtml(f, v[f.key])).join('')}</div></div>`).join('')}
          ${extra}
        </form></div>
        <div class="drawer-foot" id="drawer-foot">
          <button class="btn primary" data-action="drawer-save">${drawer.mode === 'edit' ? 'Save changes' : `Add ${cfg.noun}`}</button>
          <span class="spacer"></span>
          ${drawer.mode === 'edit' && drawer.table !== 'quantities' ? '<button class="linkish" data-action="drawer-duplicate" title="Start a new record with these values">Duplicate</button>' : ''}
          ${drawer.mode === 'edit' ? '<button class="linkish danger" data-action="drawer-delete">Delete</button>' : ''}
        </div>
      </aside>`;
    if (lockedName) { const i = $('#f_quantity'); i.disabled = true; i.title = 'Built-in quantities keep their names so Sim vs Exp keeps working.'; }
    if (usedQty) { const i = $('#f_unit'); i.disabled = true; $('[data-field="unit"] .hint').textContent = `Locked: ${plural(usedQty, 'value is', 'values are')} stored in this unit.`; }
    wireDrawer();
    const first = $('#record-form input:not([type=hidden]):not([disabled]), #record-form select');
    if (first) first.focus({ preventScroll: true });
  }

  function setMixMode(mode) {
    $('[data-field="compound_b_id"]').hidden = mode !== 'mixture';
    $('[data-field="x_a"]').hidden = mode !== 'mixture';
    $('[data-mix-label]').textContent = mode === 'mixture' ? 'Compound A' : 'Compound';
    const xv = $('#f_x_a').value;
    if (mode === 'mixture' && (isBlank(xv) || (drawer.mode === 'new' && parseNum(xv) === 1))) { $('#f_x_a').value = '0.5'; $('#f_x_a_range').value = '0.5'; $('#xb-read').innerHTML = xbText('0.5'); }
  }

  let pendingCompoundSelect = null;
  function wireDrawer() {
    const form = $('#record-form');
    form.addEventListener('submit', e => { e.preventDefault(); saveDrawer(); });
    $$('input[name="mixmode"]', form).forEach(r => r.addEventListener('change', () => setMixMode(r.value)));
    $$('input[name="linkkind"]', form).forEach(r => r.addEventListener('change', () => {
      $('#f_link_exp').hidden = r.value !== 'exp';
      $('#f_link_sim').hidden = r.value !== 'sim';
    }));
    const range = $('#f_x_a_range'), xa = $('#f_x_a');
    if (range && xa) {
      range.addEventListener('input', () => { xa.value = range.value; $('#xb-read').innerHTML = xbText(range.value); });
      xa.addEventListener('input', () => { const n = parseNum(xa.value); if (Number.isFinite(n)) range.value = n; $('#xb-read').innerHTML = xbText(xa.value); });
    }
    $$('select[data-compound]', form).forEach(s => s.addEventListener('change', () => {
      if (s.value === '__new') { pendingCompoundSelect = s; $('#new-compound-row').hidden = false; $('#new-compound-name').focus(); }
    }));
    const nc = $('#new-compound-name');
    if (nc) nc.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); createCompoundInline(); } });
    const simSel = $('#f_simulation_id');
    if (simSel && $('#f_species_compound_id')) simSel.addEventListener('change', () => { $('#f_species_compound_id').innerHTML = speciesOptions(simSel.value, null); });
    const qtySel = $('#f_quantity');
    if (qtySel && drawer.table === 'processed_results') qtySel.addEventListener('change', () => {
      drawer.values.quantity = qtySel.value;
      const qk = qtyKind(qtySel.value);
      $$('[data-qty-unit]').forEach(w => {
        const key = w.dataset.qtyUnit;
        const old = $('select, .unit-static', w); if (old) old.remove();
        w.insertAdjacentHTML('beforeend', qk.kind ? unitSelect(key, qk.kind) : `<span class="unit-static">${esc(prettyUnit(qk.unit) || '—')}</span>`);
      });
    });
  }

  function createCompoundInline() {
    const name = $('#new-compound-name').value.trim();
    if (!name) return;
    try {
      const id = mutate(`Add compound ${name}`, () => { run('INSERT INTO compounds (name) VALUES (?)', [name]); return lastId(); });
      // mutate() re-rendered the page but the drawer markup lives in #overlay, so refresh the selects in place.
      $$('select[data-compound]').forEach(s => { const keep = s === pendingCompoundSelect ? id : s.value; s.innerHTML = compoundOptions(keep); });
      $('#new-compound-row').hidden = true;
      $('#new-compound-name').value = '';
      toast(`Added ${name}. Fill in its constants later in Physical constants.`);
    } catch (e) { toast(friendlyError(e), { err: true }); }
  }

  /** Read and validate the form. Returns {values, errors}. */
  function collectForm() {
    const cfg = FORMS[drawer.table];
    const form = $('#record-form');
    const out = {}, errors = {};
    const get = key => { const el = $(`[data-key="${key}"]`, form); return el ? el.value : undefined; };
    const unitOf = key => { const s = $(`[data-unit-for="${key}"]`, form); return s ? s.value : null; };
    for (const f of allFields(cfg)) {
      const raw = get(f.key);
      switch (f.type) {
        case 'text': case 'textarea': case 'date': {
          const s = (raw ?? '').trim();
          out[f.key] = s === '' ? null : s;
          if (f.type === 'date' && out[f.key] && !/^\d{4}-\d{2}-\d{2}$/.test(out[f.key])) errors[f.key] = 'Use YYYY-MM-DD.';
          break;
        }
        case 'paths':
          out[f.key] = [...new Set((raw || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
          break;
        case 'int': {
          const n = parseNum(raw);
          if (n === null) out[f.key] = null;
          else if (!Number.isInteger(n) || n < 0) errors[f.key] = 'Enter a whole number.';
          else out[f.key] = n;
          break;
        }
        case 'number': {
          const n = parseNum(raw);
          if (n === null) { out[f.key] = null; break; }
          if (Number.isNaN(n)) { errors[f.key] = 'Enter a number, e.g. 2.27e-9.'; break; }
          let kind = f.kind;
          if (f.kindFromQty) kind = qtyKind(get('quantity')).kind;
          out[f.key] = kind ? toBase(kind, unitOf(f.key), n) : n;
          break;
        }
        case 'echo': {
          const parts = (raw || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
          if (!parts.length) { out[f.key] = null; break; }
          const nums = parts.map(parseNum);
          if (nums.some(n => !Number.isFinite(n) || n <= 0)) { errors[f.key] = 'Echo times must be positive numbers separated by commas.'; break; }
          out[f.key] = nums.map(n => toBase('time', unitOf(f.key), n)).join(', ');
          break;
        }
        case 'bool3': {
          const r = $(`input[name="b_${f.key}"]:checked`, form);
          out[f.key] = r && r.value === '1' ? 1 : r && r.value === '0' ? 0 : null;
          break;
        }
        case 'mixture': {
          const mix = ($('input[name="mixmode"]:checked', form) || {}).value === 'mixture';
          const a = get('compound_a_id'), b = get('compound_b_id');
          out.compound_a_id = a && a !== '__new' ? Number(a) : null;
          if (out.compound_a_id == null) errors.compound_a_id = 'Choose a compound.';
          if (mix) {
            out.compound_b_id = b && b !== '__new' ? Number(b) : null;
            const x = parseNum(get('x_a'));
            if (out.compound_b_id == null) errors.compound_b_id = 'Choose compound B.';
            else if (out.compound_b_id === out.compound_a_id) errors.compound_b_id = 'A and B must be different compounds.';
            if (x === null || Number.isNaN(x) || x < 0 || x > 1) errors.x_a = 'x_A must be between 0 and 1.';
            else out.x_a = x;
          } else { out.compound_b_id = null; out.x_a = 1; }
          break;
        }
        case 'select-sim': case 'species': {
          out[f.key] = raw ? Number(raw) : null;
          break;
        }
        case 'select-qty':
          out[f.key] = raw || null;
          break;
        case 'link': {
          const k = ($('input[name="linkkind"]:checked', form) || {}).value || 'none';
          out.experiment_id = k === 'exp' && get('experiment_id') ? Number(get('experiment_id')) : null;
          out.simulation_id = k === 'sim' && get('simulation_id') ? Number(get('simulation_id')) : null;
          if (k === 'exp' && out.experiment_id == null) errors.__link = 'Choose an experiment, or pick Nothing.';
          if (k === 'sim' && out.simulation_id == null) errors.__link = 'Choose a simulation, or pick Nothing.';
          break;
        }
      }
      if (f.required && !errors[f.key] && (out[f.key] === null || out[f.key] === undefined)) errors[f.key] = 'Required.';
    }
    // Cross-field checks
    if (drawer.table === 'experiments' || drawer.table === 'simulations') {
      if (out.temperature_k != null && out.temperature_k <= 0) errors.temperature_k = 'Temperature must be above 0 K.';
    }
    if (drawer.table === 'experiments') {
      for (const k of ['t2_s', 'diffusion_m2_s']) if (out[k] != null && out[k] <= 0) errors[k] = 'Must be greater than zero.';
      for (const k of ['t2_err_s', 'diffusion_err_m2_s']) if (out[k] != null && out[k] < 0) errors[k] = 'Cannot be negative.';
    }
    if (drawer.table === 'processed_results' && out.uncertainty != null && out.uncertainty < 0) errors.uncertainty = 'Cannot be negative.';
    return { values: out, errors };
  }

  function showFormErrors(errors) {
    $$('#record-form .field > .err').forEach(e => { e.hidden = true; e.textContent = ''; });
    $$('#record-form .invalid').forEach(e => e.classList.remove('invalid'));
    let first = null;
    for (const [k, msg] of Object.entries(errors)) {
      const field = $(`#record-form [data-field="${k}"]`);
      if (!field) continue;
      const err = $(':scope > .err', field);
      if (err) { err.textContent = msg; err.hidden = false; }
      const input = $(`[data-key="${k}"]`, field);
      if (input) { input.classList.add('invalid'); first = first || input; }
    }
    if (first) first.focus();
  }

  function syncPaths(table, id, paths) {
    const col = table === 'experiments' ? 'experiment_id' : 'simulation_id';
    const existing = q(`SELECT raw_id, path FROM raw_data WHERE ${col} = ?`, [id]);
    for (const r of existing) if (!paths.includes(r.path)) run('DELETE FROM raw_data WHERE raw_id = ?', [r.raw_id]);
    const have = new Set(existing.map(r => r.path));
    for (const p of paths) if (!have.has(p)) run(`INSERT INTO raw_data (${col}, path) VALUES (?, ?)`, [id, p]);
  }

  function saveDrawer() {
    const cfg = FORMS[drawer.table];
    const { values, errors } = collectForm();
    $('#form-error').innerHTML = '';
    if (Object.keys(errors).length) { showFormErrors(errors); return; }
    showFormErrors({});
    const cols = Object.keys(values).filter(k => !k.startsWith('__'));
    const isNew = drawer.mode === 'new';
    try {
      const id = mutate(`${isNew ? 'Add' : 'Edit'} ${cfg.noun}`, () => {
        let rid = drawer.id;
        if (isNew) {
          run(`INSERT INTO ${cfg.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => values[c]));
          rid = cfg.pk === 'quantity' ? values.quantity : lastId();
        } else {
          const editable = cols.filter(c => !(drawer.table === 'quantities' && ((c === 'quantity' && BUILTIN_QUANTITIES.includes(drawer.id)) || (c === 'unit' && $('#f_unit').disabled))));
          run(`UPDATE ${cfg.table} SET ${editable.map(c => `${c} = ?`).join(', ')} WHERE ${cfg.pk} = ?`, [...editable.map(c => values[c]), drawer.id]);
          if (cfg.pk === 'quantity' && editable.includes('quantity')) rid = values.quantity;
        }
        if (values.__paths) syncPaths(drawer.table, rid, values.__paths);
        return rid;
      });
      const noun = cfg.noun.charAt(0).toUpperCase() + cfg.noun.slice(1);
      closeDrawer();
      render();
      toast(`${noun}${typeof id === 'number' ? ` #${id}` : ` ${id}`} ${isNew ? 'added' : 'saved'}.`);
    } catch (e) {
      $('#form-error').innerHTML = `<div class="form-error">${esc(friendlyError(e))}</div>`;
      $('.drawer-body').scrollTop = 0;
    }
  }

  function askDelete() {
    const cfg = FORMS[drawer.table];
    const id = drawer.id;
    let consequence = '', blocked = '';
    if (drawer.table === 'experiments') {
      const n = q1('SELECT count(*) AS n FROM raw_data WHERE experiment_id = ?', [id]).n;
      if (n) consequence = `This also removes ${plural(n, 'raw-data location')} linked to it (the files themselves are not touched).`;
    } else if (drawer.table === 'simulations') {
      const c = q1('SELECT (SELECT count(*) FROM processed_results WHERE simulation_id = ?) AS p, (SELECT count(*) FROM raw_data WHERE simulation_id = ?) AS r', [id, id]);
      const bits = [c.p ? plural(c.p, 'processed value') : '', c.r ? plural(c.r, 'raw-data location') : ''].filter(Boolean);
      if (bits.length) consequence = `This also removes ${bits.join(' and ')} linked to it.`;
    } else if (drawer.table === 'compounds') {
      const u = q1('SELECT (SELECT count(*) FROM experiments WHERE ? IN (compound_a_id, compound_b_id)) AS e, (SELECT count(*) FROM simulations WHERE ? IN (compound_a_id, compound_b_id)) AS s, (SELECT count(*) FROM processed_results WHERE species_compound_id = ?) AS p', [id, id, id]);
      if (u.e || u.s || u.p) blocked = `${drawer.values.name} is used by ${[u.e ? plural(u.e, 'experiment') : '', u.s ? plural(u.s, 'simulation') : '', u.p ? plural(u.p, 'processed value') : ''].filter(Boolean).join(', ')}. Change or delete those first.`;
    } else if (drawer.table === 'quantities') {
      const n = q1('SELECT count(*) AS n FROM processed_results WHERE quantity = ?', [id]).n;
      if (n) blocked = `${plural(n, 'processed value uses', 'processed values use')} this quantity. Delete or change them first.`;
      else if (BUILTIN_QUANTITIES.includes(id)) consequence = 'This is one of the built-in quantities.';
    }
    const foot = $('#drawer-foot');
    const old = $('.confirm-box', foot); if (old) old.remove();
    if (blocked) { foot.insertAdjacentHTML('afterbegin', `<div class="confirm-box"><span class="grow">${esc(blocked)}</span></div>`); return; }
    drawer.footHtml = foot.innerHTML;
    foot.innerHTML = `<div class="confirm-box"><span style="flex:1 1 220px">Delete this ${esc(cfg.noun)}? ${esc(consequence)} You can undo this.</span>
      <button class="btn danger solid" data-action="drawer-delete-confirm">Delete</button><button class="btn ghost" data-action="drawer-delete-cancel">Keep it</button></div>`;
  }
  function doDelete() {
    const cfg = FORMS[drawer.table];
    try {
      mutate(`Delete ${cfg.noun}`, () => run(`DELETE FROM ${cfg.table} WHERE ${cfg.pk} = ?`, [drawer.id]));
      closeDrawer(); render(); toast(`Deleted. Undo is in the top bar.`);
    } catch (e) { $('#form-error').innerHTML = `<div class="form-error">${esc(friendlyError(e))}</div>`; }
  }
  function duplicateDrawer() {
    const { values } = collectForm();
    const cfg = FORMS[drawer.table];
    const copyOf = drawer.id;
    delete values[cfg.pk];
    delete values.__paths;
    if (values.compound_b_id == null && (drawer.table === 'experiments' || drawer.table === 'simulations')) values.x_a = 1;
    values.__copyOf = copyOf;
    openForm(drawer.table, null, values);
  }

  /* ------------------------------------------------------------------ *
   *  SQL console
   * ------------------------------------------------------------------ */
  const SNIPPETS = [
    ['Tables and views', "SELECT type, name FROM sqlite_master\nWHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'\nORDER BY type, name;"],
    ['Simulated vs measured T₂ (degassed only)', "SELECT compound_1, compound_2, x_1, temperature_exp_k,\n       sim_method, sim_value, exp_value,\n       round(pct_diff, 1) AS pct_diff\nFROM v_sim_vs_exp\nWHERE quantity = 'T2' AND exp_degassed = 1\nORDER BY compound_1, compound_2, x_1;"],
    ['T₂ across a mole-fraction sweep', "-- Replace the compound names with yours\nSELECT x_a, temperature_k, t2_s, t2_err_s, degassed\nFROM v_experiments\nWHERE compound_a = 'Benzene' AND compound_b = 'Toluene'\nORDER BY x_a;"],
    ['Intra / inter / total T₂ side by side', "-- One row per simulation. If a simulation has several methods,\n-- add  AND method = '...'  so max() picks the one you mean.\nSELECT simulation_id,\n  max(CASE WHEN contribution = 'intra' THEN value END) AS t2_intra_s,\n  max(CASE WHEN contribution = 'inter' THEN value END) AS t2_inter_s,\n  max(CASE WHEN contribution = 'total' THEN value END) AS t2_total_s\nFROM processed_results\nWHERE quantity = 'T2' AND species_compound_id IS NULL\nGROUP BY simulation_id;"],
    ['Compounds missing Hansen parameters', 'SELECT name, hsp_d_mpa05, hsp_p_mpa05, hsp_h_mpa05\nFROM compounds\nWHERE hsp_d_mpa05 IS NULL OR hsp_p_mpa05 IS NULL OR hsp_h_mpa05 IS NULL;'],
    ['Records per user (exp vs sim)', 'SELECT kind, user_name, count(*) AS n\nFROM v_all_records\nGROUP BY kind, user_name\nORDER BY n DESC;'],
    ['Raw files for one compound', "SELECT linked_to, record_id, path, file_type\nFROM v_raw_data\nWHERE compound_a = 'Benzene' OR compound_b = 'Benzene'\nORDER BY linked_to, record_id;"],
  ];
  let sqlText = SNIPPETS[1][1];
  let sqlResult = null; // {sets:[{columns, values}], msg, err}

  const stripSql = s => s.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  function runSql() {
    const sql = $('#sql-editor').value;
    sqlText = sql;
    if (!sql.trim()) return;
    const bare = stripSql(sql);
    const writes = /\b(insert|update|delete|replace|create|drop|alter|vacuum|reindex|attach|detach|begin|commit|rollback|savepoint|release)\b/i.test(bare) || /\bpragma\s+\w+\s*=/i.test(bare);
    const ownTxn = /\b(begin|commit|rollback|savepoint|release|vacuum|attach|detach|pragma)\b/i.test(bare);
    const t0 = performance.now();
    try {
      let sets;
      if (!writes) sets = state.db.exec(sql);
      else if (!ownTxn) sets = mutate('SQL console change', () => state.db.exec(sql));
      else {
        const before = state.currentBytes || exportBytes();
        sets = state.db.exec(sql);
        pushUndo('SQL console change', before);
        afterChange();
      }
      const ms = (performance.now() - t0).toFixed(0);
      const changes = state.db.getRowsModified ? state.db.getRowsModified() : 0;
      sqlResult = { sets, msg: writes ? `Done in ${ms} ms. ${changes ? plural(changes, 'row') + ' changed by the last statement. ' : ''}Saved; Undo is in the top bar.` : `${sets.length ? plural(sets[sets.length - 1].values.length, 'row') : 'No rows'} · ${ms} ms` };
    } catch (e) {
      sqlResult = { sets: [], err: String(e.message || e) };
    }
    render();
  }

  function secSql(main) {
    const objs = q("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name");
    const tree = objs.map(o => {
      const cols = q(`PRAGMA table_info("${o.name.replace(/"/g, '""')}")`);
      return `<details><summary>${esc(o.name)}<span class="what">${o.type}</span></summary><ul>${cols.map(c => `<li data-action="sql-insert" data-text="${esc(c.name)}" title="${esc(c.type || '')}">${esc(c.name)}</li>`).join('')}</ul></details>`;
    }).join('');
    const sets = sqlResult ? sqlResult.sets : [];
    main.innerHTML = `<section class="sec-head"><div class="sec-title"><p class="eyebrow">Tools</p><h1>SQL console</h1>
      <p class="sec-desc">Query the database directly; views starting with <span class="mono">v_</span> already join in names and computed columns.</p></div></section>
      <div class="sql-grid"><div class="sheet">
        <label for="sql-editor" class="sr">SQL</label>
        <textarea id="sql-editor" class="sql-editor" spellcheck="false">${esc(sqlText)}</textarea>
        <div class="sql-bar"><button class="btn primary" data-action="sql-run">Run</button><span class="muted" style="font-size:12px">Ctrl/⌘ + Enter</span><span class="spacer" style="flex:1"></span>
          ${sets.length ? '<button class="btn sm" data-action="sql-csv">Export result as CSV</button>' : ''}</div>
        ${sqlResult ? `<div class="sql-bar"><span class="sql-msg ${sqlResult.err ? 'err' : ''}">${esc(sqlResult.err || sqlResult.msg)}</span></div>` : ''}
        <div id="sql-results">${sets.map((s, i) => `<div class="table-wrap" style="border-top:1px solid var(--rule)"><table class="data"><thead><tr>${s.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
          ${s.values.slice(0, 1000).map(r => `<tr>${r.map(v => `<td class="${typeof v === 'number' ? 'n' : ''}">${v === null ? '<span class="muted">NULL</span>' : v instanceof Uint8Array ? `<span class="muted">BLOB ${v.length} B</span>` : esc(v)}</td>`).join('')}</tr>`).join('')}
          </tbody></table></div>${s.values.length > 1000 ? `<div class="table-foot">Showing 1000 of ${s.values.length} rows in result ${i + 1}. Export CSV for all of them.</div>` : ''}`).join('')}</div>
      </div>
      <div class="sheet"><div class="side-head"><h2>Examples</h2></div><div class="snippets">${SNIPPETS.map((s, i) => `<button data-action="sql-snippet" data-i="${i}">${esc(s[0])}</button>`).join('')}</div>
        <div class="side-head" style="border-top:1px solid var(--rule)"><h2>Schema</h2><p class="note">Click a column name to insert it.</p></div><div class="schema-tree">${tree}</div></div></div>`;
    const ed = $('#sql-editor');
    ed.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSql(); } });
    ed.addEventListener('input', () => { sqlText = ed.value; });
  }

  /* ------------------------------------------------------------------ *
   *  Import: CSV / TSV / JSON / XLSX → any table, with column mapping,
   *  unit conversion, validation and a dry-run preview
   * ------------------------------------------------------------------ */
  const norm = h => String(h ?? '').toLowerCase().replace(/δ/g, 'delta_').replace(/[([][^)\]]*[)\]]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const F = (key, label, extra) => Object.assign({ key, label }, extra || {});
  const SAMPLE_FIELDS = [
    F('compound_a', 'Compound A (name, CAS or SMILES)', { aliases: ['compound_a', 'compound', 'compound_1', 'compound1', 'component_a', 'solvent_a', 'solvent', 'species_a', 'molecule', 'name', 'a', 'compounds'] }),
    F('compound_b', 'Compound B (name, CAS or SMILES)', { aliases: ['compound_b', 'compound_2', 'compound2', 'component_b', 'solvent_b', 'species_b', 'b'] }),
    F('x_a', 'Mole fraction of A, x_A', { type: 'number', aliases: ['x_a', 'xa', 'x_1', 'x1', 'mole_fraction', 'mol_fraction', 'mole_fraction_a', 'mol_fraction_a', 'mol_fractions', 'mole_fractions', 'mol_frac', 'x'] }),
    F('x_b', 'Mole fraction of B, x_B', { type: 'number', aliases: ['x_b', 'xb', 'x_2', 'x2', 'mole_fraction_b', 'mol_fraction_b'] }),
    F('temperature_k', 'Temperature', { type: 'number', kind: 'temperature', aliases: ['temperature', 'temp', 'temperature_k', 'temp_k', 't_k'] }),
  ];
  const RECORD_FIELDS = [
    F('date', 'Date', { type: 'date', aliases: ['date', 'measured', 'measured_on', 'acquired', 'run_date', 'date_run'] }),
    F('user_name', 'User', { aliases: ['user', 'user_name', 'username', 'operator', 'measured_by', 'run_by', 'by'] }),
    F('location', 'Location', { aliases: ['location', 'locations', 'lab', 'site', 'instrument_location', 'cluster', 'machine', 'host'] }),
    F('comments', 'Comments', { aliases: ['comments', 'comment', 'notes', 'note', 'remarks'] }),
    F('raw_path', 'Raw data location(s)', { aliases: ['raw_data', 'raw_path', 'raw_data_path', 'raw_data_location', 'raw_data_locations', 'locations_to_raw_data', 'location_to_raw_data', 'path', 'paths', 'file', 'data_path', 'raw_file', 'directory', 'dir'] }),
  ];
  const IMPORT = {
    compounds: { label: 'Compounds (physical constants)', fields: [
      F('name', 'Name', { required: true, aliases: ['name', 'compound', 'compound_name', 'compounds', 'solvent', 'molecule', '_key', 'key'] }),
      F('cas', 'CAS number', { aliases: ['cas', 'cas_number', 'cas_no', 'casrn', 'cas_rn', 'cas_registry_number'] }),
      F('formula', 'Formula', { aliases: ['formula', 'molecular_formula'] }),
      F('smiles', 'SMILES', { aliases: ['smiles', 'canonical_smiles', 'isomeric_smiles'] }),
      F('mw_g_mol', 'Molar mass (g/mol)', { type: 'number', aliases: ['mw', 'mw_g_mol', 'molar_mass', 'molecular_weight', 'mol_wt', 'molar_mass_g_mol'] }),
      F('density_g_cm3', 'Density (g/cm³)', { type: 'number', aliases: ['density', 'rho', 'density_g_cm3', 'density_g_ml'] }),
      F('hsp_d_mpa05', 'δD dispersion (MPa½)', { type: 'number', aliases: ['hsp_d', 'hsp_d_mpa05', 'delta_d', 'dd', 'dispersion', 'dispersive', 'hansen_d'] }),
      F('hsp_p_mpa05', 'δP polarity (MPa½)', { type: 'number', aliases: ['hsp_p', 'hsp_p_mpa05', 'delta_p', 'dp', 'polar', 'polarity', 'hansen_p'] }),
      F('hsp_h_mpa05', 'δH hydrogen bonding (MPa½)', { type: 'number', aliases: ['hsp_h', 'hsp_h_mpa05', 'delta_h', 'dh', 'hydrogen_bonding', 'h_bonding', 'hbond', 'hansen_h'] }),
      F('source', 'Source', { aliases: ['source', 'reference', 'ref', 'references'] }),
      F('comments', 'Comments', { aliases: ['comments', 'comment', 'notes', 'note'] }),
    ] },
    experiments: { label: 'Experiments', fields: [
      ...SAMPLE_FIELDS,
      F('magnet', 'Magnet', { aliases: ['magnet', 'exp_magnet', 'spectrometer', 'instrument', 'field', 'b0'] }),
      F('pulse_sequence', 'Pulse sequence', { aliases: ['pulse_sequence', 'exp_pulse_sequence', 'sequence', 'pulse_program', 'pulseprog'] }),
      F('echo_times_s', 'Echo time(s)', { type: 'echo', kind: 'time', aliases: ['echo_times', 'echo_time', 'exp_echo_times', 'echo_times_s', 'te', 'tau', 'echo_spacing'] }),
      F('degassed', 'Degassed (yes/no)', { type: 'bool', aliases: ['degassed', 'degassed_binary', 'degas', 'degassing'] }),
      F('n_scans', 'Number of scans', { type: 'int', aliases: ['n_scans', 'scans', 'ns', 'number_of_scans', 'num_scans', 'nscans', 'n_of_scans'] }),
      F('t2_s', 'T₂', { type: 'number', kind: 'time', aliases: ['t2', 't2_s', 't2_exp', 't2exp', 't2_sim_exp', 't2sim_exp', 't_2'] }),
      F('t2_err_s', 'T₂ uncertainty', { type: 'number', kind: 'time', aliases: ['t2_err', 't2_error', 't2_uncertainty', 't2_sd', 't2_std', 't2_stdev', 'dt2', 't2_err_s'] }),
      F('diffusion_m2_s', 'Diffusion coefficient D', { type: 'number', kind: 'diffusion', aliases: ['d', 'diffusion', 'diffusion_coefficient', 'd_exp', 'dexp', 'self_diffusion', 'diffusion_m2_s', 'diffusion_sim_exp', 'diffusionsim_exp'] }),
      F('diffusion_err_m2_s', 'D uncertainty', { type: 'number', kind: 'diffusion', aliases: ['d_err', 'd_error', 'd_uncertainty', 'd_sd', 'diffusion_err', 'diffusion_error', 'diffusion_uncertainty'] }),
      ...RECORD_FIELDS,
    ] },
    simulations: { label: 'Simulations', fields: [
      ...SAMPLE_FIELDS,
      F('n_molecules_a', 'Molecules of A', { type: 'int', aliases: ['n_molecules_a', 'n_a', 'na', 'n_mol_a', 'molecules_a', 'num_a'] }),
      F('n_molecules_b', 'Molecules of B', { type: 'int', aliases: ['n_molecules_b', 'n_b', 'nb', 'n_mol_b', 'molecules_b', 'num_b'] }),
      F('force_field', 'Force field', { aliases: ['force_field', 'forcefield', 'ff'] }),
      F('software', 'Software', { aliases: ['software', 'engine', 'md_engine', 'code', 'program'] }),
      F('production_ns', 'Production length (ns)', { type: 'number', aliases: ['production_ns', 'production', 'length_ns', 'sim_length', 'length', 'duration_ns', 'production_length'] }),
      F('timestep_fs', 'Timestep (fs)', { type: 'number', aliases: ['timestep_fs', 'timestep', 'dt', 'time_step'] }),
      ...RECORD_FIELDS,
    ] },
    processed_results: { label: 'Processed results', fields: [
      F('simulation_id', 'Simulation # (or use sample + temperature)', { type: 'int', aliases: ['simulation_id', 'sim_id', 'simulation', 'sim', 'sim_number'] }),
      ...SAMPLE_FIELDS,
      F('quantity', 'Quantity (long format)', { aliases: ['quantity', 'property', 'observable', 'variable', 'parameter'] }),
      F('species', 'Species (A, B, a compound, or blank = whole sample)', { aliases: ['species', 'for_species', 'component', 'molecule_species'] }),
      F('contribution', 'Contribution (total / intra / inter)', { aliases: ['contribution', 'part', 'term', 'type'] }),
      F('method', 'Method', { aliases: ['method', 'approach', 'fit', 'fit_method'] }),
      F('value', 'Value (long format)', { type: 'number', aliases: ['value', 'val', 'result'] }),
      F('uncertainty', 'Uncertainty (long format)', { type: 'number', aliases: ['uncertainty', 'error', 'err', 'sd', 'std', 'stdev', 'sigma', 'stderr'] }),
      F('unit', 'Unit of value (long format)', { aliases: ['unit', 'units'] }),
      F('script', 'Script', { aliases: ['script', 'analysis', 'analysis_script'] }),
      F('source_path', 'Source file', { aliases: ['source_path', 'source_file', 'output_file', 'file', 'path', 'source'] }),
      F('date', 'Date computed', { type: 'date', aliases: ['date', 'computed', 'computed_on', 'run_date'] }),
      F('comments', 'Comments', { aliases: ['comments', 'comment', 'notes'] }),
    ] },
    raw_data: { label: 'Raw-data locations', fields: [
      F('path', 'Path or URL', { required: true, aliases: ['path', 'paths', 'file', 'raw_path', 'raw_data', 'url', 'location', 'locations_to_raw_data', 'raw_data_location'] }),
      F('file_type', 'File type', { aliases: ['file_type', 'type', 'kind', 'format'] }),
      F('description', 'Description', { aliases: ['description', 'desc'] }),
      F('comments', 'Comments', { aliases: ['comments', 'comment', 'notes'] }),
      F('experiment_id', 'Experiment #', { type: 'int', aliases: ['experiment_id', 'exp_id', 'experiment'] }),
      F('simulation_id', 'Simulation #', { type: 'int', aliases: ['simulation_id', 'sim_id', 'simulation'] }),
    ] },
  };

  let imp = null; // current import session

  function resetImport() { imp = null; render(); }

  /** Normalise any parsed file into {sheets:[{name, header:[], rows:[[]]}]} or {backup}. */
  async function readImportFile(file) {
    const name = file.name;
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (['sqlite', 'sqlite3', 'db'].includes(ext)) return { sqliteFile: file };
    if (ext === 'xls' || ext === 'ods') throw new Error(`.${ext} files aren't supported. Save the sheet as .xlsx or .csv and try again.`);
    if (ext === 'xlsx') {
      const sheets = await window.readXlsxFile(file);
      return { sheets: sheets.map(s => tableFromGrid(s.sheet, s.data)) };
    }
    const text = (await file.text()).replace(/^﻿/, '');
    if (ext === 'json' || /^\s*[[{]/.test(text)) {
      let data;
      try { data = JSON.parse(text); } catch (e) { throw new Error(`This isn't valid JSON: ${e.message}`); }
      if (data && data.format === 'nmr-relaxation-db' && data.tables) return { backup: data };
      return { sheets: jsonToSheets(data) };
    }
    const parsed = window.Papa.parse(text, { header: false, skipEmptyLines: 'greedy' });
    if (parsed.errors && parsed.errors.length && !parsed.data.length) throw new Error(parsed.errors[0].message);
    return { sheets: [tableFromGrid(name, parsed.data)] };
  }

  function tableFromGrid(name, grid) {
    const nonEmpty = r => r && r.some(v => !isBlank(v));
    const hi = grid.findIndex(nonEmpty);
    if (hi < 0) return { name, header: [], rows: [], headerRow: 1 };
    const seen = {};
    const header = grid[hi].map((h, i) => {
      let s = isBlank(h) ? `Column ${i + 1}` : String(h).trim();
      if (seen[s]) { seen[s] += 1; s = `${s} (${seen[s]})`; } else seen[s] = 1;
      return s;
    });
    const rows = grid.slice(hi + 1).filter(nonEmpty).map(r => header.map((_, i) => (r[i] === undefined ? null : r[i])));
    return { name, header, rows, headerRow: hi + 1 };
  }

  function flatten(obj, prefix, out) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
      else if (Array.isArray(v)) out[key] = v.every(x => typeof x !== 'object' || x === null) ? v.join(', ') : JSON.stringify(v);
      else out[key] = v;
    }
    return out;
  }
  function objectsToSheet(name, objs) {
    const flat = objs.map(o => (o && typeof o === 'object' ? flatten(o, '', {}) : { value: o }));
    const header = [];
    flat.forEach(o => Object.keys(o).forEach(k => { if (!header.includes(k)) header.push(k); }));
    return { name, header, rows: flat.map(o => header.map(h => (o[h] === undefined ? null : o[h]))), headerRow: 1 };
  }
  /** JSON shapes: [ {...} ], {key: [ {...} ]}, {name: {...}, name2: {...}} (keys become a _key column). */
  function jsonToSheets(data) {
    if (Array.isArray(data)) return [objectsToSheet('JSON', data)];
    if (data && typeof data === 'object') {
      const arrays = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length && typeof v[0] === 'object');
      if (arrays.length) return arrays.map(([k, v]) => objectsToSheet(k, v));
      const vals = Object.values(data);
      if (vals.length && vals.every(v => v && typeof v === 'object' && !Array.isArray(v))) {
        return [objectsToSheet('JSON', Object.entries(data).map(([k, v]) => Object.assign({ _key: k }, v)))];
      }
      return [objectsToSheet('JSON', [data])];
    }
    throw new Error('The JSON holds no records.');
  }

  function guessTarget(header) {
    const n = header.map(norm);
    let best = 'experiments', score = -1;
    for (const [t, spec] of Object.entries(IMPORT)) {
      let s = spec.fields.reduce((acc, f) => acc + (n.some(h => f.aliases.includes(h)) ? 1 : 0), 0);
      // Script-result columns look like T2_intra, T2_total, D_A; a bare "T2" column is more likely a measurement.
      if (t === 'processed_results' && n.some(h => /^(t1|t2|r1|r2|d|tau_c)_(intra|inter|total|tot|a|b|mix|err|error|sd)\b/.test(h))) s += 3;
      if (t === 'compounds' && n.some(h => ['delta_d', 'hsp_d', 'dd', 'cas'].includes(h))) s += 2;
      if (t === 'simulations' && n.some(h => ['force_field', 'ff', 'n_molecules_a', 'production_ns'].includes(h))) s += 2;
      if (t === 'experiments' && n.some(h => ['magnet', 'pulse_sequence', 'n_scans', 'degassed'].includes(h))) s += 2;
      if (s > score) { score = s; best = t; }
    }
    return best;
  }

  /** Recognise wide result columns such as "T2_intra", "T2_inter_A", "D_total (cm^2/s)", "T1". */
  function wideSpec(header) {
    const raw = String(header ?? '');
    const base = raw.replace(/[([][^)\]]*[)\]]/g, '').trim();
    const tokens = base.split(/[\s_\-.]+/).filter(Boolean);
    if (!tokens.length) return null;
    const qs = quantitiesList().map(x => x.quantity);
    const qty = qs.find(x => x.toLowerCase() === tokens[0].toLowerCase()) || (tokens[0].toLowerCase() === 'tauc' ? 'tau_c' : null);
    if (!qty) return null;
    let rest = tokens.slice(1);
    if (qty === 'tau_c' && rest[0] && rest[0].toLowerCase() === 'c') rest = rest.slice(1);
    const spec = { quantity: qty, species: '', contribution: 'total', method: '', isErr: false };
    const leftover = [];
    for (const t of rest) {
      const l = t.toLowerCase();
      if (['intra', 'inter', 'total', 'tot'].includes(l)) spec.contribution = l === 'tot' ? 'total' : l;
      else if (l === 'a' || l === 'b') spec.species = l.toUpperCase();
      else if (['mix', 'mixture', 'whole', 'sample', 'all'].includes(l)) spec.species = '';
      else if (['err', 'error', 'unc', 'uncertainty', 'sd', 'std', 'stdev', 'sigma', 'stderr'].includes(l)) spec.isErr = true;
      else if (['sim', 'calc', 's'].includes(l)) { /* noise */ }
      else leftover.push(t);
    }
    // A bare "D" could also be a diffusion coefficient in a wide file; that is exactly what we want.
    spec.method = leftover.join(' ');
    const qk = qtyKind(qty);
    spec.unit = (qk.kind && detectUnit(qk.kind, raw)) || (qk.kind ? UNITS[qk.kind].base : '');
    return spec;
  }

  function autoMap(target, header) {
    const spec = IMPORT[target];
    const used = new Set();
    return header.map(h => {
      const n = norm(h);
      const f = spec.fields.find(x => !used.has(x.key) && x.aliases.includes(n));
      if (f) {
        used.add(f.key);
        return { target: f.key, unit: f.kind ? (detectUnit(f.kind, h) || UNITS[f.kind].base) : null };
      }
      if (target === 'processed_results') {
        const w = wideSpec(h);
        if (w && !w.isErr) return { target: '__value', ...w };
      }
      return { target: '' };
    }).map((m, i, all) => {
      // pair wide uncertainty columns with their value column
      if (target === 'processed_results' && m.target === '') {
        const w = wideSpec(header[i]);
        if (w && w.isErr) {
          const j = all.findIndex((o, k) => o.target === '__value' && o.quantity === w.quantity && o.contribution === w.contribution && o.species === w.species && o.method === w.method && k !== i);
          if (j >= 0) return { target: '__err', of: j, unit: w.unit };
        }
      }
      return m;
    });
  }

  async function handleImportFile(file) {
    try {
      const res = await readImportFile(file);
      if (res.sqliteFile) { openSqliteFile(res.sqliteFile); return; }
      if (res.backup) { imp = { fileName: file.name, backup: res.backup }; render(); return; }
      const sheets = res.sheets.filter(s => s.header.length);
      if (!sheets.length) throw new Error('No rows with column headers were found in this file.');
      const sheet = sheets[0];
      const target = guessTarget(sheet.header);
      imp = { fileName: file.name, sheets, sheetIdx: 0, target, mapping: autoMap(target, sheet.header),
        options: { createCompounds: true, createSims: true, skipDuplicates: true, onExisting: 'skip', filterCol: '', filterVal: '' } };
      render();
    } catch (e) {
      toast(e.message || String(e), { err: true });
    }
  }

  const sheetOf = () => imp.sheets[imp.sheetIdx];

  /* --- value converters for import ------------------------------------ */
  function impText(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return isoDate(v);
    const s = String(v).trim();
    return s === '' ? null : s;
  }
  /** CAS numbers: trim, drop spaces and leading zeros so "0071-43-2" matches "71-43-2". */
  function normCas(v) {
    const t = impText(v);
    return t === null ? null : t.replace(/\s+/g, '').replace(/^0+(?=\d)/, '');
  }
  /** CAS check digit: digits before it, read right to left, weighted 1, 2, 3 …; sum mod 10. */
  function casCheckOk(c) {
    const m = /^(\d{2,7})-(\d{2})-(\d)$/.exec(c);
    if (!m) return false;
    const sum = (m[1] + m[2]).split('').reverse().reduce((acc, d, i) => acc + Number(d) * (i + 1), 0);
    return sum % 10 === Number(m[3]);
  }
  /** "CAS number, then SMILES, then name": the identifiers mapped in this import, in matching order. */
  function matchKeysText() {
    const has = k => imp.mapping.some(m => m.target === k);
    const keys = [has('cas') && 'CAS number', has('smiles') && 'SMILES', has('name') && 'name'].filter(Boolean);
    return keys.length ? keys.join(', then ') : 'CAS number, SMILES or name (map at least one)';
  }
  /** What to do with compound rows that match nothing in the database. */
  function compoundNewMode() {
    const nameMapped = imp.mapping.some(m => m.target === 'name');
    const m = imp.options.newCompounds || (nameMapped ? 'file-name' : 'cas-name');
    return m === 'file-name' && !nameMapped ? 'cas-name' : m;
  }
  function isoDate(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
  function impDate(v, warn) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return isoDate(v);
    if (typeof v === 'number' && v > 20000 && v < 80000) return isoDate(new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000)); // Excel serial date
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (m) {
      warn('slash-date');
      const y = m[3].length === 2 ? `20${m[3]}` : m[3];
      if (Number(m[1]) > 12) throw new Error(`"${s}" isn't month/day/year`);
      return `${y}-${pad(m[1])}-${pad(m[2])}`;
    }
    throw new Error(`"${s}" isn't a date (use YYYY-MM-DD)`);
  }
  function impNum(v, label) {
    const n = parseNum(v instanceof Date ? NaN : v);
    if (Number.isNaN(n)) throw new Error(`${label}: "${v}" isn't a number`);
    return n;
  }
  function impBool(v, label) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const s = String(v).trim().toLowerCase();
    if (['1', 'yes', 'y', 'true', 't', 'degassed'].includes(s)) return 1;
    if (['0', 'no', 'n', 'false', 'f', 'not degassed', 'no degas'].includes(s)) return 0;
    if (['', 'unknown', '?', 'na', 'n/a'].includes(s)) return null;
    throw new Error(`${label}: "${v}" should be yes or no`);
  }

  /**
   * Turn the mapped rows into database rows. With dryRun the database is only
   * read; otherwise it runs inside mutate() and writes. Both paths share this
   * code so the preview always matches what the import does.
   */
  function runImport(dryRun) {
    const sheet = sheetOf();
    const target = imp.target;
    const map = imp.mapping;
    const o = imp.options;
    const res = { rows: 0, inserted: 0, updated: 0, dup: 0, filtered: 0, errors: [], warnings: new Set(), newCompounds: [], newSims: [], preview: [],
      unchanged: 0, newSkipped: 0, nameDiffs: [], badCas: [], matchedBy: { cas: 0, smiles: 0, name: 0 } };
    const warn = w => res.warnings.add(w);

    // Compounds can be named by name or CAS (case-insensitive) or by SMILES (exact text: SMILES is case-sensitive).
    const cIndex = new Map(), smilesIndex = new Map();
    for (const c of q('SELECT compound_id, name, cas, smiles FROM compounds')) {
      cIndex.set(c.name.toLowerCase(), c.compound_id);
      if (c.cas) cIndex.set(normCas(c.cas).toLowerCase(), c.compound_id);
      if (c.smiles && c.smiles.trim()) smilesIndex.set(c.smiles.trim(), c.compound_id);
    }
    const lookupCompound = s => {
      const k = s.toLowerCase();
      if (cIndex.has(k)) return cIndex.get(k);
      const nc = normCas(s);
      if (nc && cIndex.has(nc.toLowerCase())) return cIndex.get(nc.toLowerCase());
      if (smilesIndex.has(s.trim())) return smilesIndex.get(s.trim());
      return undefined;
    };
    let fakeId = -1;
    const compoundId = (raw, what) => {
      const s = impText(raw);
      if (s === null) return null;
      const k = s.toLowerCase();
      const found = lookupCompound(s);
      if (found !== undefined) return found;
      if (!o.createCompounds) throw new Error(`${what} "${s}" doesn't match any compound's name, CAS or SMILES (turn on "create missing compounds" or add it first)`);
      const isCas = /^\d{2,7}-\d{2}-\d$/.test(s);
      let id;
      if (dryRun) id = fakeId--;
      else { run('INSERT INTO compounds (name, cas) VALUES (?, ?)', [s, isCas ? s : null]); id = lastId(); }
      cIndex.set(k, id);
      res.newCompounds.push(s);
      return id;
    };

    const colOf = key => map.findIndex(m => m.target === key);
    const fieldSpec = key => IMPORT[target].fields.find(f => f.key === key);
    // Compound import: separate lookups by CAS and by name.
    const nameMapped = colOf('name') >= 0;
    const newMode = compoundNewMode();
    const compoundCols = IMPORT.compounds.fields.map(f => f.key).filter(k => colOf(k) >= 0);
    const byCas = new Map(), bySmiles = new Map(), byName = new Map(), seenCompounds = new Set();
    if (target === 'compounds') {
      for (const c of q('SELECT compound_id, name, cas, smiles FROM compounds')) {
        const e = { id: c.compound_id, name: c.name, cas: c.cas ? normCas(c.cas) : null, smiles: c.smiles ? c.smiles.trim() : null };
        byName.set(c.name.toLowerCase(), e);
        if (e.cas) byCas.set(e.cas, e);
        if (e.smiles) bySmiles.set(e.smiles, e);
      }
    }
    const filterIdx = o.filterCol === '' ? -1 : Number(o.filterCol);

    const readField = (cells, key) => {
      const i = colOf(key);
      if (i < 0) return undefined;
      const f = fieldSpec(key);
      const v = cells[i];
      if (f.type === 'number') { const n = impNum(v, f.label); return n === null ? null : (f.kind ? toBase(f.kind, map[i].unit, n) : n); }
      if (f.type === 'int') { const n = impNum(v, f.label); if (n !== null && (!Number.isInteger(n) || n < 0)) throw new Error(`${f.label}: "${v}" should be a whole number`); return n; }
      if (f.type === 'date') return impDate(v, warn);
      if (f.type === 'bool') return impBool(v, f.label);
      if (f.type === 'echo') {
        if (isBlank(v)) return null;
        const parts = String(v).split(/[,;\s]+/).filter(Boolean).map(p => impNum(p, f.label));
        if (parts.some(n => n === null || n <= 0)) throw new Error(`${f.label}: "${v}" should be positive numbers`);
        return parts.map(n => toBase('time', map[i].unit, n)).join(', ');
      }
      return impText(v);
    };

    const sample = cells => {
      const a = compoundId(readField(cells, 'compound_a'), 'Compound A');
      const b = compoundId(readField(cells, 'compound_b'), 'Compound B');
      let x = readField(cells, 'x_a');
      const xb = readField(cells, 'x_b');
      if (x == null && xb != null) x = clean(1 - xb);
      if (a == null) throw new Error('Compound A is empty');
      if (b == null) {
        if (x != null && Math.abs(x - 1) > 1e-9) throw new Error(`x_A is ${x} but there is no compound B (a pure liquid has x_A = 1)`);
        x = 1;
      } else {
        if (x == null) throw new Error('Mixture rows need x_A (or x_B)');
        if (a === b) throw new Error('Compound A and B are the same');
      }
      if (x < 0 || x > 1) throw new Error(`x_A = ${x} is outside 0–1`);
      return { compound_a_id: a, compound_b_id: b, x_a: x };
    };

    const findDuplicate = (table, pk, rec) => {
      const cols = Object.keys(rec);
      const row = q1(`SELECT ${pk} AS id FROM ${table} WHERE ${cols.map(c => `${c} IS ?`).join(' AND ')} LIMIT 1`, cols.map(c => rec[c]));
      return row ? row.id : null;
    };
    const insert = (table, rec) => {
      const cols = Object.keys(rec);
      run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => rec[c]));
      return lastId();
    };
    const addPaths = (col, id, raw) => {
      if (isBlank(raw)) return;
      for (const p of String(raw).split(/\s*[;\n]\s*/).map(s => s.trim()).filter(Boolean)) {
        if (!dryRun) run(`INSERT INTO raw_data (${col}, path) VALUES (?, ?)`, [id, p]);
      }
    };

    // simulation lookup for processed results
    const sims = target === 'processed_results' ? q('SELECT simulation_id, compound_a_id, compound_b_id, x_a, temperature_k FROM simulations') : [];
    const canon = s => {
      const pure = s.compound_b_id == null || s.x_a >= 1 - 1e-9 || s.x_a <= 1e-9;
      if (pure) return `${s.compound_b_id != null && s.x_a <= 1e-9 ? s.compound_b_id : s.compound_a_id}|pure`;
      return s.compound_a_id < s.compound_b_id ? `${s.compound_a_id}|${s.compound_b_id}|${s.x_a.toFixed(6)}` : `${s.compound_b_id}|${s.compound_a_id}|${(1 - s.x_a).toFixed(6)}`;
    };
    const simById = new Map(sims.map(s => [s.simulation_id, s]));
    const findSim = (smp, T) => {
      const key = canon(smp);
      const hits = sims.filter(s => canon(s) === key && (T == null ? s.temperature_k == null : s.temperature_k != null && Math.abs(s.temperature_k - T) < 1e-6));
      if (hits.length > 1) throw new Error(`matches several simulations (#${hits.map(h => h.simulation_id).join(', #')}); add a simulation_id column`);
      if (hits.length === 1) return hits[0].simulation_id;
      if (!o.createSims) throw new Error('no simulation with this sample and temperature (turn on "create missing simulations")');
      const rec = { ...smp, temperature_k: T };
      const id = dryRun ? fakeId-- : insert('simulations', rec);
      const s = { simulation_id: id, ...rec };
      sims.push(s); simById.set(id, s);
      res.newSims.push(`${id > 0 ? '#' + id : 'new'} at ${T != null ? fmtNum(T) + ' K' : 'unknown T'}`);
      return id;
    };
    const resolveSpecies = (raw, simId) => {
      const s = impText(raw);
      if (s === null || ['whole', 'whole sample', 'mixture', 'mix', 'all', 'total', 'sample'].includes(s.toLowerCase())) return null;
      const sim = simById.get(simId);
      if (!sim) throw new Error('species given but the simulation is unknown');
      if (s.toUpperCase() === 'A') return sim.compound_a_id;
      if (s.toUpperCase() === 'B') { if (sim.compound_b_id == null) throw new Error('species B given for a pure simulation'); return sim.compound_b_id; }
      const id = lookupCompound(s);
      if (id == null || (id !== sim.compound_a_id && id !== sim.compound_b_id)) throw new Error(`species "${s}" isn't compound A or B of simulation #${simId}`);
      return id;
    };
    const qtyRow = new Map(quantitiesList().map(x => [x.quantity.toLowerCase(), x]));
    const unitFromLabel = (kind, label) => {
      if (!label) return null;
      const hit = UNITS[kind].list.find(u => u[0].toLowerCase() === String(label).toLowerCase());
      return hit ? hit[0] : detectUnit(kind, `(${label})`);
    };

    sheet.rows.forEach((cells, i) => {
      const rowNo = sheet.headerRow + 1 + i;
      if (filterIdx >= 0 && String(cells[filterIdx] ?? '').trim().toLowerCase() !== String(o.filterVal).trim().toLowerCase()) { res.filtered++; return; }
      res.rows++;
      try {
        if (target === 'compounds') {
          // Recognise a compound by CAS number, then SMILES, then name (whichever columns are mapped).
          // A CAS in the row must agree with the CAS stored for the compound it matched.
          // Stored names are never changed by an import.
          const rec = {};
          for (const f of IMPORT.compounds.fields) { const v = readField(cells, f.key); if (v !== undefined) rec[f.key] = v; }
          if (rec.cas !== undefined) rec.cas = normCas(rec.cas);
          const cas = rec.cas || null, smiles = rec.smiles || null, fileName = rec.name || null;
          if (!cas && !smiles && !fileName) throw new Error('no CAS number, SMILES or name to recognise the compound by');
          if (cas && !casCheckOk(cas)) res.badCas.push(`row ${rowNo} (${cas})`);
          const agrees = (e, key) => { if (cas && e.cas && e.cas !== cas) throw new Error(`the ${key} matches ${e.name}, which has CAS ${e.cas} in the database, but this row says ${cas}`); return e; };
          let hit, how;
          if (cas && byCas.has(cas)) { hit = byCas.get(cas); how = 'cas'; }
          else if (smiles && bySmiles.has(smiles)) { hit = agrees(bySmiles.get(smiles), 'SMILES'); how = 'smiles'; }
          else if (fileName && byName.has(fileName.toLowerCase())) { hit = agrees(byName.get(fileName.toLowerCase()), 'name'); how = 'name'; }
          const pv = (action, name) => { const r = { action, name }; for (const f of compoundCols) if (f !== 'name') r[f] = rec[f] ?? ''; return r; };
          if (hit) {
            if (seenCompounds.has(hit)) { res.dup++; return; } // the same compound appeared earlier in this file
            seenCompounds.add(hit);
            res.matchedBy[how]++;
            if (how !== 'name' && fileName && fileName.toLowerCase() !== hit.name.toLowerCase()) res.nameDiffs.push(`${fileName} → ${hit.name}`);
            if (o.onExisting !== 'update') { res.unchanged++; return; }
            const cols = Object.keys(rec).filter(k => rec[k] !== null && k !== 'name' && !(k === 'cas' && hit.cas));
            if (cols.length && !dryRun) run(`UPDATE compounds SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE compound_id = ?`, [...cols.map(c => rec[c]), hit.id]);
            if (cas && !hit.cas) { hit.cas = cas; byCas.set(cas, hit); }
            if (smiles && smiles !== hit.smiles) { hit.smiles = smiles; bySmiles.set(smiles, hit); }
            res.updated++;
            if (res.preview.length < 8) res.preview.push(pv('update', hit.name));
            return;
          }
          if (newMode === 'skip') { res.newSkipped++; return; }
          const name = newMode === 'file-name' ? (fileName || cas || smiles) : (cas || smiles || fileName);
          if (byName.has(name.toLowerCase())) throw new Error(`another compound is already named "${name}"`);
          const id = dryRun ? fakeId-- : insert('compounds', { ...rec, name });
          const entry = { id, name, cas, smiles };
          seenCompounds.add(entry);
          byName.set(name.toLowerCase(), entry);
          if (cas) byCas.set(cas, entry);
          if (smiles) bySmiles.set(smiles, entry);
          res.inserted++;
          if (res.preview.length < 8) res.preview.push(pv('add', name));
        } else if (target === 'experiments' || target === 'simulations') {
          const rec = sample(cells);
          for (const f of IMPORT[target].fields) {
            if (['compound_a', 'compound_b', 'x_a', 'x_b', 'raw_path'].includes(f.key)) continue;
            const v = readField(cells, f.key);
            if (v !== undefined) rec[f.key] = v;
          }
          if (rec.temperature_k != null && rec.temperature_k <= 0) throw new Error('temperature must be above 0 K');
          if (target === 'experiments') for (const k of ['t2_s', 'diffusion_m2_s']) if (rec[k] != null && rec[k] <= 0) throw new Error(`${k} must be greater than zero`);
          const pk = target === 'experiments' ? 'experiment_id' : 'simulation_id';
          if (o.skipDuplicates && rec.compound_a_id > 0 && (rec.compound_b_id == null || rec.compound_b_id > 0)) {
            const d = findDuplicate(target, pk, rec);
            if (d != null) { res.dup++; return; }
          }
          const id = dryRun ? fakeId-- : insert(target, rec);
          const ri = colOf('raw_path');
          if (ri >= 0) addPaths(pk, id, cells[ri]);
          res.inserted++;
          if (res.preview.length < 6) res.preview.push(rec);
        } else if (target === 'processed_results') {
          let simId = readField(cells, 'simulation_id');
          if (simId != null) {
            if (!simById.has(simId)) throw new Error(`simulation #${simId} doesn't exist`);
          } else {
            const T = readField(cells, 'temperature_k');
            simId = findSim(sample(cells), T ?? null);
          }
          const common = {
            simulation_id: simId,
            method: readField(cells, 'method') ?? null,
            script: readField(cells, 'script') ?? null,
            source_path: readField(cells, 'source_path') ?? null,
            date: readField(cells, 'date') ?? null,
            comments: readField(cells, 'comments') ?? null,
          };
          const entries = [];
          if (colOf('value') >= 0) {
            const qty = readField(cells, 'quantity');
            const qr = qty ? qtyRow.get(qty.toLowerCase()) : null;
            if (!qr) throw new Error(qty ? `quantity "${qty}" isn't defined (add it under Processed data → Quantities)` : 'quantity is empty');
            const kind = QTY_UNIT_KIND[qr.unit] || null;
            const ui = colOf('unit');
            let unit = kind ? UNITS[kind].base : null;
            if (kind && ui >= 0 && !isBlank(cells[ui])) {
              unit = unitFromLabel(kind, cells[ui]);
              if (!unit) throw new Error(`unit "${cells[ui]}" can't be converted to ${prettyUnit(qr.unit)}`);
            }
            const val = impNum(cells[colOf('value')], 'Value');
            if (val !== null) {
              const unc = colOf('uncertainty') >= 0 ? impNum(cells[colOf('uncertainty')], 'Uncertainty') : null;
              entries.push({ quantity: qr.quantity, species_compound_id: resolveSpecies(readField(cells, 'species'), simId), contribution: readField(cells, 'contribution') || 'total',
                value: kind ? toBase(kind, unit, val) : val, uncertainty: unc == null ? null : (kind ? toBase(kind, unit, unc) : unc) });
            }
          }
          map.forEach((m, ci) => {
            if (m.target !== '__value') return;
            const val = impNum(cells[ci], sheet.header[ci]);
            if (val === null) return;
            const qr = qtyRow.get(String(m.quantity).toLowerCase());
            if (!qr) throw new Error(`column "${sheet.header[ci]}": quantity "${m.quantity}" isn't defined`);
            const kind = QTY_UNIT_KIND[qr.unit] || null;
            const ei = map.findIndex(x => x.target === '__err' && x.of === ci);
            const unc = ei >= 0 ? impNum(cells[ei], sheet.header[ei]) : null;
            const sp = m.species === 'A' || m.species === 'B' ? resolveSpecies(m.species, simId) : null;
            entries.push({ quantity: qr.quantity, species_compound_id: sp, contribution: m.contribution || 'total',
              value: kind ? toBase(kind, m.unit, val) : val, uncertainty: unc == null ? null : (kind ? toBase(kind, ei >= 0 ? map[ei].unit || m.unit : m.unit, unc) : unc),
              method: m.method || common.method });
          });
          if (!entries.length) throw new Error('no values in this row');
          for (const en of entries) {
            const rec = { ...common, ...en };
            if (rec.uncertainty != null && rec.uncertainty < 0) throw new Error('uncertainty cannot be negative');
            if (o.skipDuplicates && simId > 0) {
              const d = findDuplicate('processed_results', 'result_id', rec);
              if (d != null) { res.dup++; continue; }
            }
            if (!dryRun) insert('processed_results', rec);
            res.inserted++;
            if (res.preview.length < 8) res.preview.push(rec);
          }
        } else if (target === 'raw_data') {
          const rec = {};
          for (const f of IMPORT.raw_data.fields) { const v = readField(cells, f.key); if (v !== undefined) rec[f.key] = v; }
          if (!rec.path) throw new Error('path is empty');
          if (rec.experiment_id != null && rec.simulation_id != null) throw new Error('link to an experiment or a simulation, not both');
          if (rec.experiment_id != null && !q1('SELECT 1 AS x FROM experiments WHERE experiment_id = ?', [rec.experiment_id])) throw new Error(`experiment #${rec.experiment_id} doesn't exist`);
          if (rec.simulation_id != null && !q1('SELECT 1 AS x FROM simulations WHERE simulation_id = ?', [rec.simulation_id])) throw new Error(`simulation #${rec.simulation_id} doesn't exist`);
          if (o.skipDuplicates && findDuplicate('raw_data', 'raw_id', rec) != null) { res.dup++; return; }
          if (!dryRun) insert('raw_data', rec);
          res.inserted++;
          if (res.preview.length < 6) res.preview.push(rec);
        }
      } catch (e) {
        res.errors.push({ row: rowNo, msg: e.message || String(e) });
        if (!dryRun) throw new ImportRowError(rowNo, e);
      }
    });
    return res;
  }
  class ImportRowError extends Error { constructor(row, e) { super(`Row ${row}: ${e.message || e}`); this.row = row; } }

  function validateMapping() {
    const t = imp.target, map = imp.mapping, problems = [];
    const has = k => map.some(m => m.target === k);
    if (t === 'compounds' && !has('name') && !has('cas') && !has('smiles')) problems.push('Map a column to CAS number, SMILES or Name, so rows can be matched to compounds.');
    if ((t === 'experiments' || t === 'simulations') && !has('compound_a')) problems.push('Map a column to Compound A.');
    if (t === 'raw_data' && !has('path')) problems.push('Map a column to Path or URL.');
    if (t === 'processed_results') {
      const long = has('value'), wide = map.some(m => m.target === '__value');
      if (!long && !wide) problems.push('Map a Value column (long format) or mark result columns as values (wide format).');
      if (long && !has('quantity')) problems.push('Long format needs a Quantity column.');
      if (!has('simulation_id') && !has('compound_a')) problems.push('Map Simulation # or the sample columns (Compound A, x_A, Temperature) so each value can find its simulation.');
    }
    const counts = {};
    map.forEach(m => { if (m.target && !m.target.startsWith('__')) counts[m.target] = (counts[m.target] || 0) + 1; });
    Object.entries(counts).forEach(([k, n]) => { if (n > 1) problems.push(`Two columns are mapped to ${(IMPORT[t].fields.find(f => f.key === k) || {}).label || k}.`); });
    return problems;
  }

  function doImport() {
    const problems = validateMapping();
    if (problems.length) return;
    const dry = runImport(true);
    if (dry.errors.length) return;
    try {
      const res = mutate(`Import ${imp.fileName}`, () => runImport(false));
      const parts = [`${res.inserted} added`];
      if (res.updated) parts.push(`${res.updated} updated`);
      if (res.dup) parts.push(`${res.dup} skipped as duplicates`);
      if (res.unchanged) parts.push(`${res.unchanged} already in the database left unchanged`);
      if (res.newSkipped) parts.push(`${res.newSkipped} not in the database skipped`);
      if (res.newCompounds.length) parts.push(`${plural(res.newCompounds.length, 'new compound')}`);
      if (res.newSims.length) parts.push(`${plural(res.newSims.length, 'new simulation')}`);
      const dest = { compounds: 'constants', experiments: 'experimental', simulations: 'simulated', processed_results: 'processed', raw_data: 'raw' }[imp.target];
      imp = null;
      toast(`Imported: ${parts.join(', ')}.`);
      location.hash = dest;
      render();
    } catch (e) {
      toast(`Nothing was imported. ${friendlyError(e)}`, { err: true });
    }
  }

  function restoreBackup() {
    const b = imp.backup;
    const order = ['meta', 'quantities', 'compounds', 'experiments', 'simulations', 'processed_results', 'raw_data'];
    try {
      const fresh = new state.SQL.Database();
      fresh.run('PRAGMA foreign_keys = ON');
      fresh.exec(window.NMRDB_SCHEMA);
      fresh.run('BEGIN');
      for (const t of order) {
        for (const r of (b.tables[t] || [])) {
          const cols = Object.keys(r);
          if (!cols.length) continue;
          fresh.run(`INSERT OR REPLACE INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => (r[c] === undefined ? null : r[c])));
        }
      }
      fresh.run('COMMIT');
      const bytes = fresh.export();
      fresh.close();
      const before = state.currentBytes || exportBytes();
      openDb(bytes);
      pushUndo(`Restore ${imp.fileName}`, before);
      imp = null;
      state.source = 'file';
      afterChange();
      toast('Backup restored. Undo brings back what you had.');
      location.hash = 'overview';
    } catch (e) {
      toast(`Couldn't restore the backup: ${friendlyError(e)}`, { err: true });
    }
  }

  function secImport(main) {
    if (imp && imp.backup) {
      const t = imp.backup.tables || {};
      main.innerHTML = `<section class="sec-head"><div class="sec-title"><p class="eyebrow">Tools</p><h1>Import</h1></div></section>
        <div class="sheet sheet-pad"><h2>${esc(imp.fileName)} is a full backup</h2>
        <p class="sec-desc">Exported ${esc(imp.backup.exported_at || 'at an unknown time')} · ${['compounds', 'experiments', 'simulations', 'processed_results', 'raw_data'].map(k => `${(t[k] || []).length} ${k.replace('_', ' ')}`).join(' · ')}</p>
        <p class="sec-desc">Restoring replaces the whole current database with this backup. Undo brings back the current one.</p>
        <div class="template-row" style="margin-top:12px"><button class="btn primary" data-action="restore-backup">Replace database with this backup</button><button class="btn ghost" data-action="import-reset">Cancel</button></div></div>`;
      return;
    }
    if (!imp) {
      main.innerHTML = `<section class="sec-head"><div class="sec-title"><p class="eyebrow">Tools</p><h1>Import</h1>
        <p class="sec-desc">Load a spreadsheet, CSV or JSON file into any table; nothing is written until you confirm.</p></div></section>
        <label class="drop" id="drop" for="import-input">
          <h2>Choose a file, or drop one here</h2>
          <p>.csv, .tsv, .json, .xlsx or .sqlite. A .sqlite file replaces the database, and a JSON backup made here can be restored.</p>
        </label>
        <input type="file" id="import-input" accept=".csv,.tsv,.txt,.json,.xlsx,.sqlite,.sqlite3,.db" hidden>
        <dl class="kv">
          <dt>Templates</dt><dd>CSV files with the column names the importer recognises.<div class="template-row">
            ${Object.entries(IMPORT).map(([k, v]) => `<button class="btn sm" data-action="template" data-t="${k}">${esc(v.label)}</button>`).join('')}
            <button class="btn sm" data-action="template" data-t="processed_wide">Processed results (wide)</button></div></dd>
          <dt>Units</dt><dd>Headers with units, such as <span class="mono">T2 (ms)</span>, <span class="mono">Temp [°C]</span> or <span class="mono">D (cm^2/s)</span>, are converted. You can change any unit before importing.</dd>
          <dt>Script results</dt><dd>One value per row (quantity, contribution, value), or one simulation per row with columns such as <span class="mono">T2_intra</span>, <span class="mono">T2_inter</span>, <span class="mono">T2_total</span>, <span class="mono">D_A</span>.</dd>
        </dl>`;
      const drop = $('#drop'), input = $('#import-input');
      input.addEventListener('change', () => { if (input.files[0]) handleImportFile(input.files[0]); });
      ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) handleImportFile(f); });
      return;
    }
    const sheet = sheetOf();
    const spec = IMPORT[imp.target];
    const problems = validateMapping();
    const dry = problems.length ? null : runImport(true);
    const sampleVals = ci => sheet.rows.slice(0, 3).map(r => r[ci] instanceof Date ? isoDate(r[ci]) : r[ci]).filter(v => !isBlank(v)).map(v => String(v)).join(' · ');
    const targetOpts = (m, ci) => {
      let opts = `<option value="">— ignore —</option>` + spec.fields.map(f => `<option value="${f.key}" ${m.target === f.key ? 'selected' : ''}>${esc(f.label)}</option>`).join('');
      if (imp.target === 'processed_results') {
        opts += `<option value="__value" ${m.target === '__value' ? 'selected' : ''}>Result value column (wide) →</option>`;
        opts += `<option value="__err" ${m.target === '__err' ? 'selected' : ''}>Uncertainty of a value column →</option>`;
      }
      return `<select data-map="${ci}" aria-label="Destination for ${esc(sheet.header[ci])}">${opts}</select>`;
    };
    const unitPicker = (m, ci, kind) => kind ? `<select data-map-unit="${ci}" aria-label="Unit">${UNITS[kind].list.map(([u]) => `<option ${u === (m.unit || UNITS[kind].base) ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select>` : '';
    const rowExtra = (m, ci) => {
      if (m.target === '__value') {
        const qk = qtyKind(m.quantity);
        return `<div class="valspec"><select data-vs="${ci}" data-prop="quantity" aria-label="Quantity">${quantitiesList().map(x => `<option ${x.quantity === m.quantity ? 'selected' : ''}>${esc(x.quantity)}</option>`).join('')}</select>
          <select data-vs="${ci}" data-prop="species" aria-label="Species"><option value="" ${!m.species ? 'selected' : ''}>whole sample</option><option value="A" ${m.species === 'A' ? 'selected' : ''}>compound A</option><option value="B" ${m.species === 'B' ? 'selected' : ''}>compound B</option></select>
          <input type="text" data-vs="${ci}" data-prop="contribution" value="${esc(m.contribution || 'total')}" list="dl_contribution" aria-label="Contribution" style="width:96px">
          <input type="text" data-vs="${ci}" data-prop="method" value="${esc(m.method || '')}" placeholder="method" list="dl_method" aria-label="Method" style="width:150px">
          ${qk.kind ? unitPicker(m, ci, qk.kind) : `<span class="muted">${esc(prettyUnit(qk.unit))}</span>`}</div>`;
      }
      if (m.target === '__err') {
        const valueCols = imp.mapping.map((x, j) => (x.target === '__value' ? j : -1)).filter(j => j >= 0);
        return `<div class="valspec"><select data-vs="${ci}" data-prop="of" aria-label="Uncertainty of">${valueCols.map(j => `<option value="${j}" ${m.of === j ? 'selected' : ''}>${esc(sheet.header[j])}</option>`).join('') || '<option value="">(mark a value column first)</option>'}</select>
          ${(() => { const vj = imp.mapping[m.of]; const qk = vj ? qtyKind(vj.quantity) : {}; return qk.kind ? unitPicker(m, ci, qk.kind) : ''; })()}</div>`;
      }
      const f = spec.fields.find(x => x.key === m.target);
      return f && f.kind ? `<div class="valspec">${unitPicker(m, ci, f.kind)}</div>` : '';
    };
    const previewCols = dry && dry.preview.length ? Object.keys(dry.preview[0]) : [];
    const cName = id => { if (id == null) return ''; if (id < 0) return '(new)'; const r = q1('SELECT name FROM compounds WHERE compound_id = ?', [id]); return r ? r.name : id; };
    const showVal = (k, v) => /^compound_[ab]_id$|^species_compound_id$/.test(k) ? esc(cName(v)) : (k === 'simulation_id' && v < 0 ? '(new)' : typeof v === 'number' ? esc(fmtNum(v)) : esc(v ?? ''));
    main.innerHTML = `<section class="sec-head"><div class="sec-title"><div class="eyebrow">Tools · Import</div><h1>${esc(imp.fileName)}</h1>
      <p class="sec-desc">${plural(sheet.rows.length, 'data row')} under a header on row ${sheet.headerRow}. Match each column to a field, check the preview, then import.</p></div>
      <div class="sec-actions"><button class="btn ghost" data-action="import-reset">Choose another file</button></div></section>
      <div class="sheet sheet-pad"><div class="form-grid">
        <div class="field"><label for="imp-target">Import into</label><select id="imp-target">${Object.entries(IMPORT).map(([k, v]) => `<option value="${k}" ${k === imp.target ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></div>
        ${imp.sheets.length > 1 ? `<div class="field"><label for="imp-sheet">Sheet</label><select id="imp-sheet">${imp.sheets.map((s, i) => `<option value="${i}" ${i === imp.sheetIdx ? 'selected' : ''}>${esc(s.name)} (${s.rows.length} rows)</option>`).join('')}</select></div>` : '<div></div>'}
        <div class="field full"><div class="label">Options</div>${imp.target === 'compounds' ? `<p class="note" style="margin:0 0 6px">Rows are matched to compounds already in the database by ${matchKeysText()}. Names stored in the database are never changed by an import.${imp.mapping.some(m => m.target === 'smiles') ? ' SMILES match on exact text, so they need to be written the same way as in the database (for example, both from PubChem).' : ''}</p>` : ''}<div class="options">
          ${imp.target !== 'compounds' && imp.target !== 'raw_data' ? `<label><input type="checkbox" data-opt="createCompounds" ${imp.options.createCompounds ? 'checked' : ''}> Create missing compounds</label>` : ''}
          ${imp.target === 'processed_results' ? `<label><input type="checkbox" data-opt="createSims" ${imp.options.createSims ? 'checked' : ''}> Create missing simulations</label>` : ''}
          ${imp.target !== 'compounds' ? `<label><input type="checkbox" data-opt="skipDuplicates" ${imp.options.skipDuplicates ? 'checked' : ''}> Skip rows identical to existing records</label>` : `<label>Already in the database: <select data-opt="onExisting" style="width:auto;height:28px"><option value="skip" ${imp.options.onExisting !== 'update' ? 'selected' : ''}>leave unchanged</option><option value="update" ${imp.options.onExisting === 'update' ? 'selected' : ''}>update with the file's filled-in cells</option></select></label>
            <label>Not in the database: <select data-opt="newCompounds" style="width:auto;height:28px">${imp.mapping.some(m => m.target === 'name') ? `<option value="file-name" ${compoundNewMode() === 'file-name' ? 'selected' : ''}>add, using the file's name</option>` : ''}<option value="cas-name" ${compoundNewMode() === 'cas-name' ? 'selected' : ''}>add, named by CAS number (SMILES if no CAS)</option><option value="skip" ${compoundNewMode() === 'skip' ? 'selected' : ''}>skip</option></select></label>`}
          <label>Only rows where <select data-opt="filterCol" style="width:auto;height:28px"><option value="">(all rows)</option>${sheet.header.map((h, i) => `<option value="${i}" ${String(imp.options.filterCol) === String(i) ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select> = <input type="text" data-opt="filterVal" value="${esc(imp.options.filterVal)}" style="width:110px;height:28px" aria-label="Filter value"></label>
        </div></div>
      </div></div>
      <div class="sheet"><div class="table-wrap"><table class="data map-table"><thead><tr><th>Column in file</th><th>Example values</th><th>Goes to</th></tr></thead><tbody>
        ${sheet.header.map((h, ci) => { const m = imp.mapping[ci]; return `<tr><td><strong>${esc(h)}</strong></td><td class="sample-vals" title="${esc(sampleVals(ci))}">${esc(sampleVals(ci))}</td><td>${targetOpts(m, ci)}${rowExtra(m, ci)}</td></tr>`; }).join('')}
      </tbody></table></div></div>
      ${datalistHtml('contribution')}${datalistHtml('method')}
      <div class="sheet sheet-pad">
        <h2>Preview</h2>
        ${problems.length ? `<ul class="issues">${problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : `
          <dl class="kv"><dt>Will add</dt><dd><strong>${dry.inserted}</strong> ${imp.target === 'processed_results' ? (dry.inserted === 1 ? 'value' : 'values') : (dry.inserted === 1 ? 'row' : 'rows')}${dry.updated ? ` · update ${dry.updated}` : ''}</dd>
          ${dry.dup && imp.target !== 'compounds' ? `<dt>Skipped</dt><dd>${dry.dup} already in the database</dd>` : ''}
          ${dry.dup && imp.target === 'compounds' ? `<dt>Repeated</dt><dd>${plural(dry.dup, 'row repeats', 'rows repeat')} a compound from earlier in the file and ${dry.dup === 1 ? 'is' : 'are'} skipped</dd>` : ''}
          ${imp.target === 'compounds' && (dry.matchedBy.cas + dry.matchedBy.smiles + dry.matchedBy.name) ? `<dt>Recognised</dt><dd>${[['cas', 'by CAS'], ['smiles', 'by SMILES'], ['name', 'by name']].filter(([k]) => dry.matchedBy[k]).map(([k, l]) => `${dry.matchedBy[k]} ${l}`).join(', ')}</dd>` : ''}
          ${dry.unchanged ? `<dt>Left unchanged</dt><dd>${plural(dry.unchanged, 'compound is', 'compounds are')} already in the database. To fill in their values from this file, set "Already in the database" to update.</dd>` : ''}
          ${dry.newSkipped ? `<dt>Skipped</dt><dd>${plural(dry.newSkipped, 'row')} not in the database</dd>` : ''}
          ${dry.nameDiffs.length ? `<dt>Names kept</dt><dd>${plural(dry.nameDiffs.length, 'row names', 'rows name')} a compound differently from the database; the database ${dry.nameDiffs.length === 1 ? 'name is' : 'names are'} kept (${esc(dry.nameDiffs.slice(0, 6).join(', '))}${dry.nameDiffs.length > 6 ? ', …' : ''}).</dd>` : ''}
          ${dry.badCas.length ? `<dt>Check CAS</dt><dd>${esc(dry.badCas.slice(0, 8).join(', '))}${dry.badCas.length > 8 ? ', …' : ''}: the check digit doesn't match, so ${dry.badCas.length === 1 ? 'it may be a typo' : 'these may be typos'}.</dd>` : ''}
          ${dry.filtered ? `<dt>Filtered out</dt><dd>${dry.filtered} rows</dd>` : ''}
          ${dry.newCompounds.length ? `<dt>New compounds</dt><dd>${esc([...new Set(dry.newCompounds)].join(', '))}</dd>` : ''}
          ${dry.newSims.length ? `<dt>New simulations</dt><dd>${dry.newSims.length} (sample + temperature only)</dd>` : ''}
          ${dry.errors.length ? `<dt>Problems</dt><dd style="color:var(--bad)">${plural(dry.errors.length, 'row')}</dd>` : ''}</dl>
          ${dry.warnings.has('slash-date') ? '<p class="sub-note">Dates written with slashes were read as month/day/year.</p>' : ''}
          ${dry.errors.length ? `<ul class="issues">${dry.errors.slice(0, 40).map(e => `<li>Row ${e.row}: ${esc(e.msg)}</li>`).join('')}${dry.errors.length > 40 ? `<li>…and ${dry.errors.length - 40} more</li>` : ''}</ul><p class="sub-note">Fix these in the file (or change the mapping) and the preview updates. Nothing is imported while any row has a problem.</p>` : ''}
          ${previewCols.length ? `<div class="table-wrap" style="margin-top:12px"><table class="data"><thead><tr>${previewCols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${dry.preview.map(r => `<tr>${previewCols.map(c => `<td>${showVal(c, r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="sub-note">First rows as they will be stored (base units: s, m²/s, K).${imp.target === 'compounds' && dry.updated ? ' In updated rows, blank cells leave the stored value as it is.' : ''}</p>` : ''}`}
        <div class="template-row" style="margin-top:14px"><button class="btn primary" data-action="import-do" ${problems.length || !dry || dry.errors.length || (!dry.inserted && !dry.updated) ? 'disabled' : ''}>Import ${dry ? dry.inserted + dry.updated : ''}</button><button class="btn ghost" data-action="import-reset">Cancel</button></div>
      </div>`;
    wireImport();
  }

  function wireImport() {
    const t = $('#imp-target');
    if (t) t.addEventListener('change', () => { imp.target = t.value; imp.mapping = autoMap(imp.target, sheetOf().header); render(); });
    const sh = $('#imp-sheet');
    if (sh) sh.addEventListener('change', () => { imp.sheetIdx = Number(sh.value); imp.target = guessTarget(sheetOf().header); imp.mapping = autoMap(imp.target, sheetOf().header); render(); });
    $$('[data-map]').forEach(s => s.addEventListener('change', () => {
      const ci = Number(s.dataset.map), v = s.value;
      const h = sheetOf().header[ci];
      if (v === '__value') {
        const w = wideSpec(h) || { quantity: 'T2', species: '', contribution: 'total', method: '', unit: 's' };
        imp.mapping[ci] = { target: '__value', ...w };
      } else if (v === '__err') {
        const first = imp.mapping.findIndex(m => m.target === '__value');
        imp.mapping[ci] = { target: '__err', of: first >= 0 ? first : null, unit: null };
      } else {
        const f = IMPORT[imp.target].fields.find(x => x.key === v);
        imp.mapping[ci] = { target: v, unit: f && f.kind ? (detectUnit(f.kind, h) || UNITS[f.kind].base) : null };
      }
      render();
    }));
    $$('[data-map-unit]').forEach(s => s.addEventListener('change', () => { imp.mapping[Number(s.dataset.mapUnit)].unit = s.value; render(); }));
    $$('[data-vs]').forEach(s => s.addEventListener('change', () => {
      const m = imp.mapping[Number(s.dataset.vs)];
      m[s.dataset.prop] = s.dataset.prop === 'of' ? Number(s.value) : s.value;
      if (s.dataset.prop === 'quantity') { const qk = qtyKind(s.value); m.unit = qk.kind ? UNITS[qk.kind].base : ''; }
      render();
    }));
    $$('[data-opt]').forEach(s => s.addEventListener('change', () => {
      imp.options[s.dataset.opt] = s.type === 'checkbox' ? s.checked : s.value;
      render();
    }));
  }

  function downloadTemplate(t) {
    if (t === 'processed_wide') {
      saveFile('template_processed_wide.csv', toCsv(['simulation_id', 'compound_a', 'compound_b', 'x_a', 'temperature_k', 'method', 'script', 'T2_intra', 'T2_inter', 'T2_total', 'T2_total_err', 'D_A (m^2/s)', 'D_B (m^2/s)'], []), 'text/csv');
      return;
    }
    const cols = IMPORT[t].fields.map(f => f.key === 'raw_path' ? 'raw_data_path' : f.key);
    saveFile(`template_${t}.csv`, toCsv(cols, []), 'text/csv');
  }

  /* ------------------------------------------------------------------ *
   *  Export & settings
   * ------------------------------------------------------------------ */
  function backupJson() {
    const tables = {};
    for (const t of ['meta', 'quantities', 'compounds', 'experiments', 'simulations', 'processed_results', 'raw_data']) tables[t] = q(`SELECT * FROM ${t}`);
    return JSON.stringify({ format: 'nmr-relaxation-db', schema_version: SCHEMA_VERSION, exported_at: nowIso(), tables }, null, 1);
  }

  function secSettings(main) {
    const ver = q1('SELECT sqlite_version() AS v').v;
    const objs = q("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r => r.name);
    main.innerHTML = `<section class="sec-head"><div class="sec-title"><p class="eyebrow">Tools</p><h1>Export and settings</h1>
      <p class="sec-desc">Link the lab's master file, download copies, and set how simulations are matched to experiments.</p></div></section>
      <div class="split">
        <div><h2>Master file</h2>
          ${!fsSupported ? `<p class="sec-desc">This browser can't save straight to a file; Chrome and Edge can. Here, open <span class="mono">master.sqlite</span> from the shared folder, make your changes, then download a copy and replace <span class="mono">master.sqlite</span> in the folder with it, keeping the name.</p>
              <div class="template-row"><button class="btn primary" data-action="open-file">Open a .sqlite file…</button><button class="btn" data-action="download-sqlite">Download .sqlite</button></div>`
          : state.master ? `<dl class="kv"><dt>File</dt><dd class="mono">${esc(state.master.name)}</dd>
              <dt>Status</dt><dd>${!state.master.ready ? 'Not opened yet in this session' : state.dirty ? 'You have changes that aren\'t saved to it' : 'Up to date'}</dd>
              <dt>Last synced</dt><dd>${state.master.syncedAt ? esc(fmtTime(state.master.syncedAt)) : '—'}</dd></dl>
              <div class="template-row" style="margin-top:14px"><button class="btn primary" data-action="master-save">Save to master</button><button class="btn" data-action="master-reload">Check for newer version</button><button class="btn ghost" data-action="master-unlink">Unlink</button></div>
              <p class="note" style="margin-top:10px">Browsers show the file name but not its folder. The sync app uploads each save. To undo a bad save, use the drive's version history (OneDrive and Google Drive keep about 30 days).</p>`
          : `<ol class="steps-list" style="margin-top:12px">
              <li><span>Keep <span class="mono">master.sqlite</span> in the lab's shared folder (OneDrive, Google Drive or Box) that syncs to your computer.</span></li>
              <li><span>Open it here once. This browser remembers it.</span></li>
              <li><span>Edit, then Save to master (or Ctrl+S).</span></li></ol>
              <div class="template-row" style="margin-top:14px"><button class="btn primary" data-action="master-open">Open master file…</button><button class="btn" data-action="master-create">Create master file…</button></div>
              <p class="note" style="margin-top:10px">Create master file saves what's in this browser as a new file; use it once to start the master.</p>`}
          <h2 style="margin-top:28px">Download</h2>
          <dl class="kv">
            <dt>Whole database</dt><dd><div class="template-row"><button class="btn" data-action="download-sqlite">Download database.sqlite</button><button class="btn" data-action="download-json">Download JSON backup</button></div>
              <p class="sub-note" style="margin:6px 0 0">The .sqlite file opens in Python (sqlite3, pandas), DB Browser for SQLite and R. The JSON backup can be restored through Import.</p></dd>
            <dt>One table or view</dt><dd><div class="template-row"><select id="export-obj" style="width:auto">${objs.map(o => `<option>${esc(o)}</option>`).join('')}</select><button class="btn" data-action="export-obj">Download CSV</button></div></dd>
          </dl>
        </div>
        <div><h2>Sim vs exp matching</h2>
          <form id="tol-form" class="form-grid" style="margin-top:10px" novalidate>
            <div class="field"><label for="tol-x">Mole-fraction tolerance</label><input type="text" inputmode="decimal" id="tol-x" value="${esc(metaGet('match_tol_x') ?? '0.01')}"><div class="hint">|x<sub>sim</sub> − x<sub>exp</sub>| at most this.</div></div>
            <div class="field"><label for="tol-t">Temperature tolerance</label><div class="unit-input"><input type="text" inputmode="decimal" id="tol-t" value="${esc(metaGet('match_tol_t_k') ?? '1.0')}"><span class="unit-static">K</span></div><div class="hint">|T<sub>sim</sub> − T<sub>exp</sub>| at most this.</div></div>
            <div class="full"><button class="btn" type="submit">Save tolerances</button></div>
          </form>
          <h2 style="margin-top:22px">Database</h2>
          <dl class="kv"><dt>Engine</dt><dd>SQLite ${esc(ver)} via sql.js (${esc(state.engine)})</dd><dt>Schema version</dt><dd>${esc(metaGet('schema_version') ?? '?')}</dd>
            <dt>Created</dt><dd>${esc(metaGet('created_at') ?? '—')}</dd><dt>Last change</dt><dd>${esc(metaGet('modified_at') ?? '—')}</dd></dl>
          <div class="template-row" style="margin-top:14px"><button class="btn" data-action="open-file">Open a .sqlite file…</button>${state.repoAvailable ? '<button class="btn" data-action="load-repo-check">Load the repository copy</button>' : ''}<button class="btn danger" data-action="new-db">Start an empty database</button></div>
        </div>
      </div>`;
    $('#tol-form').addEventListener('submit', e => {
      e.preventDefault();
      const x = parseNum($('#tol-x').value), t = parseNum($('#tol-t').value);
      if (!Number.isFinite(x) || x < 0 || x > 1 || !Number.isFinite(t) || t < 0) { toast('Tolerances must be numbers: 0–1 for x, and 0 or more kelvin.', { err: true }); return; }
      mutate('Change matching tolerances', () => { metaSet('match_tol_x', x); metaSet('match_tol_t_k', t); });
      toast('Tolerances saved.');
    });
  }

  /* ------------------------------------------------------------------ *
   *  Loading and replacing whole databases
   * ------------------------------------------------------------------ */
  function replaceDatabase(bytes, how) {
    const before = state.currentBytes;
    openDb(bytes);
    const s = ensureSchema();
    if (s.foreign) {
      openDb(before);
      toast('That file is a SQLite database, but not one made by this site (it has no meta table). Open it in DB Browser for SQLite instead.', { err: true });
      return false;
    }
    state.schemaNewer = s.newer ? s.version : null;
    if (before) pushUndo(how.label, before);
    state.currentBytes = exportBytes();
    state.source = how.source;
    state.dirty = state.master && !how.fromMaster ? true : how.dirty;
    if (how.repoHash !== undefined) state.repoHash = how.repoHash;
    persistNow();
    closeDrawer();
    render();
    return true;
  }

  async function openSqliteFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isSqlite(bytes)) { toast(`${file.name} isn't a SQLite database file.`, { err: true }); return; }
    const go = () => { if (replaceDatabase(bytes, { label: `Open ${file.name}`, source: 'file', dirty: false })) { toast(`Opened ${file.name}. Undo returns to the previous database.`); location.hash = 'overview'; } };
    if (state.dirty) modal({ title: 'Replace your browser copy?', body: `Your browser copy has unsaved changes. Opening this file replaces it; Undo brings it back while this tab stays open.${state.master ? ` To make this file the new master, use Save to master afterwards.` : ''}`, actions: [{ label: 'Download my copy first', onClick: () => downloadSqlite(`my-copy-${today()}.sqlite`).then(go) }, { label: 'Replace', kind: 'danger', onClick: go }, { label: 'Cancel', kind: 'ghost' }] });
    else go();
  }

  async function loadRepo(bytesIn) {
    const bytes = bytesIn || await fetchRepoDb();
    if (!bytes) { toast(`No database file found at ${REPO_DB_PATH} in this site.`, { err: true }); return; }
    const hash = hashBytes(bytes);
    const go = () => { if (replaceDatabase(bytes, { label: 'Load repository copy', source: 'repo', dirty: false, repoHash: hash })) { state.repoNotice = null; render(); toast('Loaded the repository version.'); } };
    if (state.dirty) modal({ title: 'Replace your working copy?', body: 'Your working copy has changes that haven\'t been downloaded. Loading the repository file replaces them.', actions: [{ label: 'Download working copy first', onClick: () => downloadSqlite().then(go) }, { label: 'Replace', kind: 'danger', onClick: go }, { label: 'Cancel', kind: 'ghost' }] });
    else go();
  }

  async function downloadSqlite(name) {
    const ok = await saveFile(name || 'database.sqlite', state.currentBytes || exportBytes(), 'application/vnd.sqlite3');
    if (ok && !state.master) { state.dirty = false; persistNow(); renderStatus(); }
    return ok;
  }

  /* ------------------------------------------------------------------ *
   *  Master file in a shared folder (File System Access API: Chrome, Edge)
   *  The lab keeps master.sqlite in a synced folder (OneDrive, Google
   *  Drive, Box). This browser remembers the file handle in IndexedDB,
   *  reads the file and writes back to it. A SHA-256 of the file taken at
   *  every load and save shows when someone else saved in between.
   * ------------------------------------------------------------------ */
  const fsSupported = typeof window.showOpenFilePicker === 'function' && typeof window.showSaveFilePicker === 'function';
  const SQLITE_TYPES = [{ description: 'SQLite database', accept: { 'application/x-sqlite3': ['.sqlite', '.sqlite3', '.db'] } }];
  let masterBusy = false;

  async function digest(bytes) {
    try {
      if (window.crypto && crypto.subtle) {
        const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return Array.from(h, b => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (_) { /* fall back below */ }
    return hashBytes(bytes);
  }
  async function storeMaster() {
    try {
      const m = state.master;
      if (m) await idbPut('master', { handle: m.handle, name: m.name, hash: m.hash, syncedAt: m.syncedAt });
      else await idbDelete('master');
    } catch (e) { console.warn('Could not remember the master file', e); }
  }
  async function hasPermission(handle, mode, ask) {
    try {
      if ((await handle.queryPermission({ mode })) === 'granted') return true;
      return ask ? (await handle.requestPermission({ mode })) === 'granted' : false;
    } catch (_) { return false; }
  }
  async function readHandle(handle) {
    const file = await handle.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { bytes, hash: await digest(bytes), name: file.name, size: file.size };
  }
  function masterErr(e, what) {
    if (e && e.name === 'AbortError') return; // the file picker was cancelled
    if (e && e.name === 'NotFoundError') { state.masterNotice = 'missing'; render(); return; }
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) { toast(`The browser didn't allow access to ${what}. Try again and choose Allow.`, { err: true }); return; }
    if (e && e.name === 'NoModificationAllowedError') { toast('The file is busy, probably because the sync app is uploading it. Try again in a moment.', { err: true }); return; }
    toast(`Couldn't use ${what}: ${e && e.message || e}`, { err: true });
  }

  /** Make `read` (a master file just read from disk) the working copy. */
  function adoptMaster(handle, read) {
    if (!replaceDatabase(read.bytes, { label: `Load ${read.name}`, source: 'master', dirty: false, fromMaster: true })) return false;
    state.master = { handle, name: read.name, hash: read.hash, syncedAt: nowIso(), ready: true };
    state.masterNotice = null;
    storeMaster(); persistNow(); render();
    return true;
  }

  async function openMaster() {
    if (!fsSupported || state.mode === 'example') return;
    let handle, read;
    try { [handle] = await window.showOpenFilePicker({ types: SQLITE_TYPES, multiple: false }); }
    catch (e) { masterErr(e, 'the file'); return; }
    try { read = await readHandle(handle); } catch (e) { masterErr(e, 'the file'); return; }
    if (read.size === 0) { // an empty file: make the current database its first content
      const prev = state.master;
      state.master = { handle, name: read.name, hash: read.hash, syncedAt: null, ready: true };
      try { await writeMaster(); } catch (e) { state.master = prev; masterErr(e, read.name); }
      return;
    }
    if (!isSqlite(read.bytes)) { toast(`${read.name} isn't a SQLite database file.`, { err: true }); return; }
    if (state.master && read.hash === state.master.hash) { // same content as the linked master (e.g. it was moved): relink, keep local edits
      Object.assign(state.master, { handle, name: read.name, ready: true });
      state.masterNotice = null; storeMaster(); render();
      toast(`Linked to ${read.name} again.`);
      return;
    }
    const go = () => { if (adoptMaster(handle, read)) { toast(`Opened ${read.name}. Save to master writes your changes back to it.`); location.hash = 'overview'; } };
    if (state.dirty) modal({ title: 'Replace your browser copy?', body: `Your browser copy has changes that aren't saved to a file. Opening ${esc(read.name)} replaces them; Undo brings them back while this tab stays open. To start the master from your browser copy instead, use Create master file.`, actions: [
      { label: 'Download my copy first', onClick: () => downloadSqlite(`my-copy-${today()}.sqlite`).then(go) },
      { label: `Open ${read.name}`, kind: 'danger', onClick: go }, { label: 'Cancel', kind: 'ghost' }] });
    else go();
  }

  async function createMaster() {
    if (!fsSupported || state.mode === 'example') return;
    let handle;
    try { handle = await window.showSaveFilePicker({ suggestedName: 'master.sqlite', types: SQLITE_TYPES }); }
    catch (e) { masterErr(e, 'the file'); return; }
    const prev = state.master;
    state.master = { handle, name: handle.name, hash: null, syncedAt: null, ready: true };
    try { await writeMaster(); } catch (e) { state.master = prev; masterErr(e, handle.name); render(); }
  }

  async function writeMaster() {
    const m = state.master;
    const bytes = state.currentBytes || exportBytes();
    const w = await m.handle.createWritable();
    await w.write(bytes);
    await w.close();
    m.hash = await digest(bytes); m.syncedAt = nowIso(); m.ready = true;
    state.dirty = false; state.masterNotice = null;
    await storeMaster(); persistNow(); render();
    toast(`Saved to ${m.name}.`);
  }

  async function saveToMaster(opts = {}) {
    if (state.mode === 'example' || masterBusy) return;
    if (!state.master) { if (fsSupported) await createMaster(); else await downloadSqlite(); return; }
    const m = state.master;
    if (!(await hasPermission(m.handle, 'readwrite', true))) { toast(`Saving needs permission to edit ${m.name}. Click Save to master again and choose Allow.`, { err: true }); return; }
    masterBusy = true;
    try {
      if (!opts.force) {
        const cur = await readHandle(m.handle);
        if (m.hash && cur.hash !== m.hash) { conflictOnSave(cur); return; }
      }
      await writeMaster();
    } catch (e) { masterErr(e, m.name); }
    finally { masterBusy = false; }
  }

  function conflictOnSave(cur) {
    const m = state.master;
    modal({ title: `${m.name} changed after you opened it`, body: `Someone else saved ${esc(m.name)} after this browser last loaded it. Saving now would replace their changes with yours.`, actions: [
      { label: 'Download mine, load theirs', onClick: () => downloadSqlite(`my-changes-${today()}.sqlite`).then(() => { if (adoptMaster(m.handle, cur)) toast(`Loaded the latest ${m.name}. Your version was downloaded.`); }) },
      { label: 'Overwrite with mine', kind: 'danger', onClick: () => saveToMaster({ force: true }) },
      { label: 'Cancel', kind: 'ghost' }] });
  }

  function conflictOnLoad(cur) {
    const m = state.master;
    modal({ title: `${m.name} has newer changes`, body: `Someone else saved ${esc(m.name)}, and you also have changes here that aren't saved to it. Loading theirs replaces yours.`, actions: [
      { label: 'Download mine, load theirs', onClick: () => downloadSqlite(`my-changes-${today()}.sqlite`).then(() => { if (adoptMaster(m.handle, cur)) toast(`Loaded the latest ${m.name}. Your version was downloaded.`); }) },
      { label: 'Load theirs', kind: 'danger', onClick: () => { if (adoptMaster(m.handle, cur)) toast(`Loaded the latest ${m.name}.`); } },
      { label: 'Keep mine', kind: 'ghost' }] });
  }

  /** Compare the master file with what this browser last loaded or saved.
   *  ask: may show the browser's permission prompt (needs a click).
   *  auto: background check; never interrupts an open form or dialog. */
  async function checkMaster({ ask = false, auto = false } = {}) {
    const m = state.master;
    if (!m || state.mode === 'example' || masterBusy) return;
    if (!(await hasPermission(m.handle, ask ? 'readwrite' : 'read', ask))) { m.ready = false; state.masterNotice = 'permission'; render(); return; }
    let cur;
    try { cur = await readHandle(m.handle); }
    catch (e) { if (e && e.name === 'NotFoundError') { state.masterNotice = 'missing'; render(); } else if (!auto) masterErr(e, m.name); return; }
    m.ready = true;
    if (cur.hash === m.hash) {
      state.masterNotice = null; render();
      if (!auto) toast(state.dirty ? `${m.name} hasn't changed since you opened it. Your unsaved changes are still here.` : `Up to date with ${m.name}.`);
      return;
    }
    const busy = drawer || $('.modal') || imp;
    if (!state.dirty && !(auto && busy)) { if (adoptMaster(m.handle, cur)) toast(`Loaded the latest ${m.name}.`); return; }
    state.masterNotice = 'changed'; render();
    if (!auto) conflictOnLoad(cur);
  }

  function unlinkMaster() {
    if (!state.master) return;
    const name = state.master.name;
    state.master = null; state.masterNotice = null;
    if (state.dirty === false && state.source === 'master') state.source = 'browser';
    storeMaster(); render();
    toast(`Unlinked ${name}. Your browser copy is unchanged.`);
  }

  /* ------------------------------------------------------------------ *
   *  Example mode: a throwaway database with clearly marked sample data
   * ------------------------------------------------------------------ */
  function seedExample() {
    const SRC_B = 'Example. δD/δP/δH: Hansen, HSP: A User\'s Handbook, 2nd ed. (2007). M and ρ: Wikipedia infobox (temperature for ρ not stated there).';
    const SRC_T = 'Example. δD/δP/δH: Hansen, HSP: A User\'s Handbook, 2nd ed. (2007). M and ρ (25 °C): Wikipedia infobox.';
    run(`INSERT INTO compounds (name, cas, formula, mw_g_mol, density_g_cm3, hsp_d_mpa05, hsp_p_mpa05, hsp_h_mpa05, source) VALUES
      ('Benzene', '71-43-2', 'C6H6', 78.114, 0.8765, 18.4, 0.0, 2.0, ?),
      ('Toluene', '108-88-3', 'C7H8', 92.141, 0.8623, 18.0, 1.4, 2.0, ?),
      ('Ethanol', '64-17-5', 'C2H6O', 46.069, NULL, 15.8, 8.8, 19.4, 'Example. δD/δP/δH: Hansen (2007). Density left blank on purpose.')`, [SRC_B, SRC_T]);
    const note = 'EXAMPLE: synthetic value, not a measurement';
    const sweep = [[1, 15.8, 0.4, 2.21e-9], [0.7, 14.9, 0.4, 2.27e-9], [0.5, 14.1, 0.3, 2.31e-9], [0.3, 13.6, 0.3, 2.35e-9], [0, 12.9, 0.3, 2.40e-9]];
    sweep.forEach(([x, t2, e, d], i) => {
      run(`INSERT INTO experiments (compound_a_id, compound_b_id, x_a, temperature_k, magnet, pulse_sequence, echo_times_s, degassed, n_scans, t2_s, t2_err_s, diffusion_m2_s, location, date, user_name, comments)
        VALUES (1, ${x === 1 ? 'NULL' : 2}, ?, 298.15, 'Example 43 MHz benchtop', 'CPMG', '0.0005', 1, 4, ?, ?, ?, 'Example lab', ?, 'example user', ?)`, [x, t2, e, d, `2026-09-${pad(i + 1)}`, note]);
      run('INSERT INTO raw_data (experiment_id, path, file_type) VALUES (last_insert_rowid(), ?, ?)', [`/example/nmr/benzene_toluene_x${x}/cpmg.1d`, 'CPMG decay']);
    });
    run(`INSERT INTO experiments (compound_a_id, compound_b_id, x_a, temperature_k, magnet, pulse_sequence, echo_times_s, degassed, n_scans, t2_s, t2_err_s, location, date, user_name, comments)
      VALUES (1, 2, 0.5, 298.15, 'Example 43 MHz benchtop', 'CPMG', '0.0005', 0, 4, 3.1, 0.1, 'Example lab', '2026-09-06', 'example user', ?)`, [note + '; not degassed']);
    run(`INSERT INTO experiments (compound_a_id, x_a, temperature_k, pulse_sequence, degassed, t2_s, date, user_name, comments) VALUES (3, 1, 298.15, 'CPMG', 1, 2.6, '2026-09-07', 'example user', ?)`, [note]);
    const simT2 = [[1, 17.1, 16.6, 2.05e-9], [0.7, 16.0, 15.6, 2.11e-9], [0.5, 15.2, 14.8, 2.16e-9], [0.3, 14.4, 14.1, 2.20e-9], [0, 13.8, 13.5, 2.26e-9]];
    simT2.forEach(([x, ens, hm, d]) => {
      const nA = Math.round(1000 * x);
      run(`INSERT INTO simulations (compound_a_id, compound_b_id, x_a, temperature_k, n_molecules_a, n_molecules_b, force_field, software, production_ns, timestep_fs, location, date, user_name, comments)
        VALUES (1, ${x === 1 ? 'NULL' : 2}, ?, 298.15, ?, ?, 'CHARMM36 / CGenFF', 'OpenMM', 20, 2, 'Example cluster', '2026-08-20', 'example user', ?)`, [x, nA, x === 1 ? null : 1000 - nA, 'EXAMPLE record']);
      const sid = lastId();
      const intra = clean(ens * 1.9), inter = clean(1 / (1 / ens - 1 / intra));
      const rows = [
        ['T2', null, 'total', 'ensemble single-exponential fit', ens, clean(ens * 0.03), 'results'],
        ['T2', null, 'total', 'harmonic mean of rates', hm, null, 'results'],
        ['T2', null, 'intra', 'ensemble single-exponential fit', intra, null, 'intra'],
        ['T2', null, 'inter', 'ensemble single-exponential fit', inter, null, 'inter'],
        ['D', null, 'total', 'Yeh–Hummer corrected', d, null, 'results'],
      ];
      for (const r of rows) run(`INSERT INTO processed_results (simulation_id, quantity, species_compound_id, contribution, method, value, uncertainty, script, source_path, date, comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-08-25', ?)`,
        [sid, r[0], r[1], r[2], r[3], r[4], r[5], r[6], `/example/md/sim${sid}/${r[6]}_out.json`, note]);
      run('INSERT INTO raw_data (simulation_id, path, file_type) VALUES (?, ?, ?)', [sid, `/example/md/sim${sid}/prod.dcd`, 'trajectory']);
    });
  }

  function enterExample() {
    if (state.mode === 'example') return;
    state.real = { bytes: state.currentBytes, undo: state.undo, dirty: state.dirty, source: state.source };
    state.mode = 'example';
    openDb(null);
    state.db.exec(window.NMRDB_SCHEMA);
    run('BEGIN'); seedExample(); run('COMMIT');
    state.undo = [];
    state.currentBytes = exportBytes();
    closeDrawer();
    render();
  }
  function exitExample() {
    if (state.mode !== 'example') return;
    openDb(state.real.bytes);
    Object.assign(state, { currentBytes: state.real.bytes, undo: state.real.undo, dirty: state.real.dirty, source: state.real.source, mode: 'normal', real: null });
    closeDrawer();
    render();
    toast('Back to your database.');
  }

  /* ------------------------------------------------------------------ *
   *  Render + events
   * ------------------------------------------------------------------ */
  function render() {
    if (!state.db) return;
    const route = ROUTES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
    state.route = route;
    const c = counts();
    renderNav(c);
    renderStatus();
    renderBanners();
    const main = $('#main');
    const scrollY = window.scrollY;
    const focusedSearch = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.search : null;
    ({ overview: () => secOverview(main, c), constants: () => secConstants(main), experimental: () => secExperimental(main), simulated: () => secSimulated(main),
      processed: () => secProcessed(main), compare: () => secCompare(main), raw: () => secRaw(main), sql: () => secSql(main), import: () => secImport(main), settings: () => secSettings(main) }[route])();
    if (focusedSearch) { const s = $(`[data-search="${focusedSearch}"]`); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
    window.scrollTo(0, scrollY);
  }

  const ACTIONS = {
    'add': t => openForm(t.dataset.table, null),
    'open-row': (t, e) => { e.preventDefault(); openForm(t.dataset.table, t.dataset.id); },
    'drawer-close': () => closeDrawer(),
    'drawer-save': () => saveDrawer(),
    'drawer-delete': () => askDelete(),
    'drawer-delete-confirm': () => doDelete(),
    'drawer-delete-cancel': () => { if (drawer && drawer.footHtml) $('#drawer-foot').innerHTML = drawer.footHtml; },
    'drawer-duplicate': () => duplicateDrawer(),
    'add-result-for-sim': t => openForm('processed_results', null, { simulation_id: Number(t.dataset.id) }),
    'create-compound': () => createCompoundInline(),
    'cancel-compound': () => { $('#new-compound-row').hidden = true; if (pendingCompoundSelect) pendingCompoundSelect.value = ''; },
    'set-tab': t => { state.tabs[t.dataset.route] = t.dataset.tab; render(); },
    'sort': t => {
      const id = t.closest('.sheet').id.replace('table-', '');
      const cur = state.sort[id];
      state.sort[id] = cur && cur.key === t.dataset.key ? (cur.dir === 1 ? { key: t.dataset.key, dir: -1 } : null) : { key: t.dataset.key, dir: 1 };
      if (!state.sort[id]) delete state.sort[id];
      renderTable($(`#table-${id}`), tableRegistry[id]);
    },
    'show-all': t => { state.showAll[t.dataset.id] = true; renderTable($(`#table-${t.dataset.id}`), tableRegistry[t.dataset.id]); },
    'export-view': t => {
      const cfg = tableRegistry[t.dataset.id];
      const rows = sortRows(filterRows(cfg.rows, state.search[t.dataset.id]), cfg.cols, state.sort[t.dataset.id]);
      const cols = cfg.csvCols || cfg.cols.map(c => c.key);
      saveFile(`${t.dataset.id}.csv`, toCsv(cols, rows.map(r => cols.map(c => r[c]))), 'text/csv');
    },
    'cmp-qty': t => { state.compare.quantity = t.dataset.q; state.compare.method = ''; render(); },
    'undo': () => undo(),
    'download-sqlite': () => downloadSqlite(),
    'master-open': () => openMaster(),
    'master-create': () => createMaster(),
    'master-save': () => saveToMaster(),
    'master-reload': () => checkMaster({ ask: true }),
    'master-unlink': () => unlinkMaster(),
    'download-json': () => saveFile(`nmr-relaxation-db-backup-${today()}.json`, backupJson(), 'application/json'),
    'export-obj': () => {
      const name = $('#export-obj').value;
      const res = state.db.exec(`SELECT * FROM "${name.replace(/"/g, '""')}"`);
      const cols = res.length ? res[0].columns : q(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).map(c => c.name);
      saveFile(`${name}.csv`, toCsv(cols, res.length ? res[0].values : []), 'text/csv');
    },
    'open-file': () => $('#open-db-input').click(),
    'load-repo': () => loadRepo(state.repoNotice && state.repoNotice.bytes),
    'load-repo-check': () => loadRepo(null),
    'dismiss-repo': () => { state.repoHash = state.repoNotice.hash; state.repoNotice = null; persistNow(); render(); },
    'new-db': () => modal({ title: 'Start an empty database?', body: 'This replaces the working copy in this browser with an empty database. Undo can bring it back while this tab stays open; download first to keep a copy.', actions: [
      { label: 'Download current first', onClick: () => downloadSqlite() },
      { label: 'Start empty', kind: 'danger', onClick: () => { const fresh = new state.SQL.Database(); fresh.exec(window.NMRDB_SCHEMA); const b = fresh.export(); fresh.close(); replaceDatabase(b, { label: 'Start empty database', source: 'new', dirty: true }); toast('Started an empty database.'); } },
      { label: 'Cancel', kind: 'ghost' }] }),
    'enter-example': () => enterExample(),
    'exit-example': () => exitExample(),
    'sql-run': () => runSql(),
    'sql-snippet': t => { sqlText = SNIPPETS[Number(t.dataset.i)][1]; sqlResult = null; render(); const ed = $('#sql-editor'); ed.focus(); },
    'sql-insert': t => { const ed = $('#sql-editor'); const s = ed.selectionStart, en = ed.selectionEnd; ed.setRangeText(t.dataset.text, s, en, 'end'); sqlText = ed.value; ed.focus(); },
    'sql-csv': () => { const s = sqlResult && sqlResult.sets[sqlResult.sets.length - 1]; if (s) saveFile('query_result.csv', toCsv(s.columns, s.values), 'text/csv'); },
    'import-do': () => doImport(),
    'import-reset': () => resetImport(),
    'restore-backup': () => restoreBackup(),
    'template': t => downloadTemplate(t.dataset.t),
  };

  function bindEvents() {
    document.addEventListener('click', e => {
      const t = e.target.closest('[data-action]');
      if (t && !t.disabled && ACTIONS[t.dataset.action]) ACTIONS[t.dataset.action](t, e);
    });
    document.addEventListener('keydown', e => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
      if (e.key === 'Escape') { if ($('.modal')) closeModal(); else if (drawer) closeDrawer(); }
      if (e.key === 'Enter' && !typing && document.activeElement && document.activeElement.matches('tr[data-action="open-row"]')) document.activeElement.click();
      if (e.key === '/' && !typing && !drawer) { const s = $('input.search'); if (s) { e.preventDefault(); s.focus(); } }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing && !drawer && state.mode === 'normal') { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (state.mode === 'normal' && !drawer) { if (state.master) saveToMaster(); else downloadSqlite(); } }
    });
    document.addEventListener('input', e => {
      const id = e.target.dataset && e.target.dataset.search;
      if (!id) return;
      state.search[id] = e.target.value;
      if (id === 'compare') render();
      else if (tableRegistry[id]) renderTable($(`#table-${id}`), tableRegistry[id]);
    });
    $('#open-db-input').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) openSqliteFile(f); });
    window.addEventListener('hashchange', () => { closeDrawer(); render(); window.scrollTo(0, 0); });
    window.addEventListener('beforeunload', e => { if (state.mode === 'normal' && state.dirty && (state.master || !state.persistOk)) { e.preventDefault(); e.returnValue = ''; } });
    // Coming back to the tab: look for a newer master (only if permission is already granted).
    let lastCheck = 0;
    const recheck = () => {
      if (document.visibilityState !== 'visible' || !state.master || !state.master.ready || Date.now() - lastCheck < 15000) return;
      lastCheck = Date.now();
      checkMaster({ auto: true });
    };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
  }

  /* ------------------------------------------------------------------ *
   *  Start-up
   * ------------------------------------------------------------------ */
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);
  const loadScript = src => new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Couldn't load ${src}`)); document.head.appendChild(s); });

  /** WebAssembly build first; the asm.js build is the fallback (opened from disk, or where WebAssembly is blocked). */
  async function initEngine() {
    try {
      if (location.protocol === 'file:') throw new Error('opened from disk: browsers block fetching the .wasm file');
      if (typeof window.initSqlJs !== 'function') throw new Error('sql-wasm.js not loaded');
      state.SQL = await withTimeout(window.initSqlJs({ locateFile: f => `lib/${f}` }), 12000);
      state.engine = 'WebAssembly';
    } catch (e) {
      console.warn('WebAssembly SQLite unavailable, using the asm.js build:', e);
      await loadScript('lib/sql-asm.js');
      state.SQL = await withTimeout(window.initSqlJs(), 30000);
      state.engine = 'asm.js';
    }
  }

  async function boot() {
    bindEvents();
    try { await initEngine(); }
    catch (e) {
      $('#main').innerHTML = `<div class="boot"><div><h2>The SQLite engine didn't load</h2><p>${esc(e.message || e)}. Check that the <span class="mono">lib/</span> folder was uploaded next to index.html.</p></div></div>`;
      return;
    }
    let local = null;
    try { local = await idbGet('working'); } catch (e) { state.persistOk = false; }
    if (fsSupported) {
      try {
        const mm = await idbGet('master');
        if (mm && mm.handle) state.master = { handle: mm.handle, name: mm.name, hash: mm.hash, syncedAt: mm.syncedAt, ready: false };
      } catch (_) { /* no remembered master */ }
    }
    const repo = await fetchRepoDb();
    const repoHash = repo ? hashBytes(repo) : null;
    state.repoAvailable = !!repo;
    if (local && local.bytes && isSqlite(local.bytes)) {
      openDb(local.bytes);
      state.source = 'browser';
      state.repoHash = local.repoHash || null;
      state.dirty = !!local.dirty;
      if (repo && repoHash !== state.repoHash) state.repoNotice = { bytes: repo, hash: repoHash };
    } else if (repo) {
      openDb(repo);
      state.source = 'repo';
      state.repoHash = repoHash;
    } else {
      openDb(null);
      state.source = 'new';
    }
    const s = ensureSchema();
    if (s.foreign) { openDb(null); ensureSchema(); toast('The saved database was not in the expected format, so an empty one was started.', { err: true }); }
    state.schemaNewer = s.newer ? s.version : null;
    state.currentBytes = exportBytes();
    await persistNow();
    render();
    if (state.master) await checkMaster({ auto: true }); // loads it if Chrome kept permission, otherwise shows "Open latest"
  }

  // For tests and for poking at the database from the browser console.
  window.nmrdb = { q: (sql, p) => q(sql, p), state, render };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

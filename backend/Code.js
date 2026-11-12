/**
 * HDX · Backend de la mesa de control (Google Apps Script, aplicación web).
 *
 *  - GET  → entrega la configuración vigente del mercado (JSON). Con ?rev=N responde {same:true} si no cambió.
 *           Con ?log=1 entrega el registro de publicaciones. Con ?integrations=1, el estado (enmascarado) de las integraciones.
 *  - POST → {password, config}: guarda la nueva configuración con rev+1 si la contraseña coincide con el hash guardado.
 *           {password, action, ...}: acciones de integración (secrets, catalog, catalogGet, sales, pushPrices) y del motor
 *           (engineStart, engineResume, engineStop, engineRun, engineStatus), misma verificación.
 *  - GET ?state=1&srev=N → estado del mercado en vivo (Engine.js); ?engine=1 → estado del motor y del disparador.
 *  Ventas: si están GASTRO_API_KEY y GASTRO_RESOURCE se usa la API de Gastronomía (atenciones cerradas y pagadas, con
 *  productCatalogueId por línea); si no, la API antigua de ventas por ítem (SALES_*).
 *
 * Almacena en Script Properties (no requiere autorización de Google para leer/escribir), partiendo el JSON en trozos de 8 KB.
 * Las integraciones con el catálogo y las ventas de Haulmer usan UrlFetchApp, que sí requiere que el dueño del script
 * autorice una vez (ejecutar `authorize` desde el editor).
 * La contraseña nunca se guarda: solo su hash SHA-256, que viene dentro de la configuración (adminHash).
 * Se edita y despliega con clasp desde el repositorio (carpeta backend/).
 */

const CHUNK = 8000;
const CACHE_KEY = 'hdx-config';
const CACHE_SECONDS = 15;
const LOG_KEY = 'hdx-log';
const LOG_MAX = 100;
const TZ = 'America/Santiago';

/* Claves de integración guardadas en Script Properties. Las *_KEY nunca se devuelven completas. */
const SECRET_KEYS = ['CAT_BASE_URL', 'CAT_API_KEY', 'CAT_RESOURCE', 'SALES_BASE_URL', 'SALES_API_KEY', 'SALES_TAX_ID', 'GASTRO_BASE_URL', 'GASTRO_API_KEY', 'GASTRO_RESOURCE', 'GASTRO_BRANCH_ID'];
/* Sin valores por defecto: las URLs y claves de las APIs internas de Haulmer se cargan solo en Script Properties. */
const SECRET_DEFAULTS = {};

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.log) return json(readLog());
  if (p.integrations) return json({ integrations: secretsStatus(), version: 11 });
  if (p.engine) return json(engineStatus());
  if (p.state) {
    const st = readState();
    if (!st) return json({ srev: 0, empty: true });
    if (Number(p.srev || -1) === st.srev) return json({ srev: st.srev, same: true });
    return json(enginePublicState(st));
  }
  const stored = readStored();
  const rev = Number(p.rev || -1);
  if (stored && stored.rev === rev) return json({ rev: rev, same: true });
  if (!stored) return json({ rev: 0, empty: true });
  return json(stored);
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const password = String(body.password || '');
    if (body.action) return handleAction(body, password);

    const cfg = body.config;
    if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.products)) return json({ ok: false, error: 'config' });

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const stored = readStored(true);
      // La referencia es el hash ya guardado; si no hay nada guardado (primera publicación), el de la configuración enviada.
      const reference = stored && stored.adminHash ? stored.adminHash : cfg.adminHash;
      if (!reference || sha256(password) !== reference) return json({ ok: false, error: 'auth' });

      cfg.rev = ((stored && stored.rev) || 0) + 1;
      cfg.updatedAt = Date.now();
      writeStored(cfg);
      appendLog(cfg, stored);
      return json({ ok: true, rev: cfg.rev });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* ---------- acciones de integración (requieren la contraseña vigente) ---------- */

function handleAction(body, password) {
  const stored = readStored(true);
  if (!stored || !stored.adminHash) return json({ ok: false, error: 'auth' });
  if (sha256(password) !== stored.adminHash) return json({ ok: false, error: 'auth' });

  try {
    switch (body.action) {
      case 'secrets': {
        const given = body.secrets || {};
        const props = PropertiesService.getScriptProperties();
        const set = {};
        SECRET_KEYS.forEach(function (k) { const v = given[k]; if (v != null && String(v).trim() !== '') set[k] = String(v).trim(); });
        if (Object.keys(set).length) props.setProperties(set);
        if (set.GASTRO_BRANCH_ID === '0' || set.GASTRO_BRANCH_ID === '-') props.deleteProperty('GASTRO_BRANCH_ID'); // "0" o "-" = todas las sucursales
        logEvent('integraciones: ' + Object.keys(set).join(', '));
        return json({ ok: true, integrations: secretsStatus() });
      }
      case 'catalog': {
        const products = catalogProducts({ includeVariants: body.includeVariants === true, raw: body.raw === true });
        return json({ ok: true, resource: getSecrets().CAT_RESOURCE, products: products });
      }
      case 'engineStart': {
        const cfg = readStored(true);
        const st = engineInit(cfg, Date.now());
        writeState(st);
        ensureTrigger();
        logEvent('motor iniciado (estado reiniciado)');
        return json({ ok: true, status: engineStatus() });
      }
      case 'engineStop': {
        removeTrigger();
        logEvent('motor detenido');
        return json({ ok: true, status: engineStatus() });
      }
      case 'engineRun': {
        const cfgRun = readStored(true);
        if (((cfgRun && cfgRun.settings && cfgRun.settings.mode) || 'demo') !== 'live') return json({ ok: false, error: 'el modo publicado es demo: el motor no corre' });
        const summary = engineTick(true);
        return json({ ok: true, summary: summary, status: engineStatus() });
      }
      case 'engineResume': {
        ensureTrigger();
        logEvent('motor reanudado');
        return json({ ok: true, status: engineStatus() });
      }
      case 'engineStatus':
        return json({ ok: true, status: engineStatus() });
      case 'catalogGet': {
        // Solo lectura, para explorar el gateway desde la mesa de control: {path:'/products', query:{...}}
        const path = String(body.path || '');
        if (!/^\/[A-Za-z0-9\/_-]*$/.test(path)) return json({ ok: false, error: 'path inválido' });
        return json({ ok: true, data: catalogRequest('get', path, body.query || null) });
      }
      case 'sales': {
        const now = new Date();
        const init = body.initDate || fmtLocal(new Date(now.getTime() - 24 * 3600000));
        const end = body.endDate || fmtLocal(now);
        const opts = { raw: body.raw === true, all: body.all === true, catalog: body.catalog };
        const summary = gastroConfigured() && body.source !== 'legacy' ? gastroSummary(init, end, opts) : salesSummary(init, end, opts);
        return json(Object.assign({ ok: true, initDate: init, endDate: end }, summary));
      }
      case 'pushPrices': {
        const list = Array.isArray(body.prices) ? body.prices : [];
        if (!list.length) return json({ ok: false, error: 'sin precios' });
        const results = pushPrices(list);
        logEvent('precios al catálogo: ' + results.filter(function (r) { return r.ok; }).length + ' ok, ' + results.filter(function (r) { return !r.ok; }).length + ' con error');
        return json({ ok: true, results: results });
      }
      default:
        return json({ ok: false, error: 'acción desconocida' });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/* ---------- motor de precios en vivo (Engine.js) ---------- */

const STATE_CACHE_KEY = 'hdx-state';
const STATE_CACHE_SECONDS = 5;
const TRIGGER_FN = 'engineTick';

/** Corrida del motor: la llama el disparador por minuto. Con force=true corre aunque el modo publicado no sea "live". */
function engineTick(force) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { skipped: 'lock' };
  try {
    const cfg = readStored(true);
    if (!cfg) return { skipped: 'sin configuración' };
    const mode = (cfg.settings || {}).mode || 'demo';
    if (mode !== 'live' && !force) return { skipped: 'modo ' + mode };
    let st = readState();
    const now = Date.now();
    if (!st || st.open !== cfg.openAt) st = engineInit(cfg, now);
    else if (st.moveSec !== ((cfg.settings || {}).moveSec || 15)) st = engineRestartKeepingPrices(cfg, st, now);
    if (st.cfgRev !== (cfg.rev || 0)) engineSyncConfig(st, cfg);
    const summary = engineRunOnce(cfg, st, now, {
      fetchLines: function (fromMs, toMs) { return fetchSalesLines(cfg, fromMs, toMs); },
      pushPrice: function (catalogId, price) {
        catalogRequest('put', '/products/' + encodeURIComponent(catalogId) + '/complex-update', null, { price: Number(price) });
        return { ok: true };
      }
    });
    writeState(st);
    return summary;
  } finally {
    lock.releaseLock();
  }
}

/** Ventas reales del período mapeadas a ticker: [{key, at, t, qty}]. Solo las del catálogo configurado. */
function fetchSalesLines(cfg, fromMs, toMs) {
  if (gastroConfigured()) return gastroLines(cfg, fromMs, toMs);
  const s = getSecrets();
  const items = salesItems(fmtLocal(new Date(fromMs)), fmtLocal(new Date(toMs)));
  const seq = {};
  const out = [];
  items.forEach(function (it) {
    if (!it || String(it.idCatalogue || '') !== s.CAT_RESOURCE) return;
    const base = String(it.saleId) + '|' + (it.productId || it.itemCode || it.itemName || '');
    const n = seq[base] = (seq[base] || 0) + 1;
    out.push(engineMapLine(it, n, cfg, parseLocalDate));
  });
  return out;
}

/* ---------- integraciones: ventas de Gastronomía (atenciones cerradas y pagadas, header X-API-Key) ---------- */

function gastroConfigured() { const s = getSecrets(); return !!(s.GASTRO_API_KEY && s.GASTRO_RESOURCE); }

/** GET {GASTRO_BASE_URL}/integrations/v1/gastronomy/{resource}/sales?startDate&endDate&page&pageSize[&restaurantBranchId]. Devuelve data (data[], totalCount, totalPages). */
function gastroRequest(query) {
  const s = getSecrets();
  const base = String(s.GASTRO_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !s.GASTRO_API_KEY || !s.GASTRO_RESOURCE) throw new Error('Faltan GASTRO_BASE_URL, GASTRO_API_KEY o GASTRO_RESOURCE');
  const prefix = base.indexOf('azure-api.net') !== -1 ? '/integrations/v1' : '/public/integrations/v1';
  const q = Object.assign({}, query);
  if (s.GASTRO_BRANCH_ID && s.GASTRO_BRANCH_ID !== '0') q.restaurantBranchId = s.GASTRO_BRANCH_ID;
  const qs = Object.keys(q).filter(function (k) { return q[k] !== null && q[k] !== undefined && q[k] !== ''; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }).join('&');
  const url = base + prefix + '/gastronomy/' + encodeURIComponent(s.GASTRO_RESOURCE) + '/sales' + (qs ? '?' + qs : '');
  let attempt = 0;
  while (true) {
    const response = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, headers: { 'X-API-Key': s.GASTRO_API_KEY, Accept: 'application/json' } });
    const code = response.getResponseCode();
    const text = response.getContentText();
    if ((code === 502 || code === 503 || code === 504) && attempt < 2) { attempt++; Utilities.sleep(800 * attempt); continue; }
    if (code < 200 || code >= 300) throw new Error('Gastronomía HTTP ' + code + ': ' + text.slice(0, 200));
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error('Gastronomía: respuesta no JSON'); }
    if (parsed && parsed.error === true) throw new Error(parsed.message || 'Gastronomía: error');
    return (parsed && parsed.data) || {};
  }
}

/** Atenciones completadas entre fromMs y toMs (epoch). La API filtra por día (UTC), así que se pide con un día de margen y se filtra aquí.
 *  Las páginas vienen de la más reciente a la más antigua: se deja de paginar al pasar fromMs. */
function gastroAttentions(fromMs, toMs, maxPages) {
  const day = function (ms) { return Utilities.formatDate(new Date(ms), 'GMT', 'yyyy-MM-dd'); };
  const start = day(fromMs - 86400000), end = day(toMs + 86400000);
  const out = []; let page = 1, totalPages = 1, pages = 0;
  do {
    const block = gastroRequest({ startDate: start, endDate: end, page: page, pageSize: 50 });
    const list = block.data || [];
    totalPages = Number(block.totalPages) || 1; pages++;
    let oldest = Infinity;
    list.forEach(function (a) { const t = Date.parse(a.completedAt); if (t < oldest) oldest = t; if (t >= fromMs && t <= toMs) out.push(a); });
    if (list.length && oldest < fromMs) break;
    page++;
  } while (page <= totalPages && pages < (maxPages || 20));
  return out;
}

/** Líneas para el motor: [{key, at, t, qty}] solo del catálogo configurado, mapeadas a ticker por el id de producto del catálogo. */
function gastroLines(cfg, fromMs, toMs) {
  const s = getSecrets();
  const byId = {}; (cfg.products || []).forEach(function (p) { if (p.catalogId) byId[String(p.catalogId)] = p.t; });
  const out = [];
  gastroAttentions(fromMs, toMs).forEach(function (a) {
    (a.products || []).forEach(function (p) {
      const cr = String(p.catalogueResource || a.catalogueResource || '');
      if (s.CAT_RESOURCE && cr !== s.CAT_RESOURCE) return;
      out.push({ key: 'g' + a.attentionId + '|' + p.productId, at: Date.parse(a.completedAt), t: byId[String(p.productCatalogueId || '')] || '', qty: Number(p.quantity) || 0 });
    });
  });
  return out;
}

/** Resumen para la mesa de control: mismo formato que salesSummary, más atenciones y sucursales. */
function gastroSummary(initDate, endDate, opts) {
  opts = opts || {};
  const s = getSecrets(); const cfg = readStored() || {};
  const target = opts.catalog ? String(opts.catalog) : s.CAT_RESOURCE;
  const byId = {}; (cfg.products || []).forEach(function (p) { if (p.catalogId) byId[String(p.catalogId)] = p.t; });
  const atts = gastroAttentions(parseLocalDate(initDate), parseLocalDate(endDate));
  const catalogs = {}, branches = {}, by = {}; let total = 0, matched = 0; const items = [];
  atts.forEach(function (a) {
    const b = String(a.restaurantBranchId || '?') + ' ' + (a.restaurantBranchName || ''); branches[b] = (branches[b] || 0) + 1;
    (a.products || []).forEach(function (p) {
      total++;
      const cr = String(p.catalogueResource || a.catalogueResource || '(sin catálogo)'); catalogs[cr] = (catalogs[cr] || 0) + 1;
      if (target && cr !== target) return;
      matched++;
      const key = byId[String(p.productCatalogueId || '')] || ('#' + p.productCatalogueId);
      const o = by[key] || (by[key] = { sku: key, productId: p.productCatalogueId, name: String(p.name || '').trim(), qty: 0, total: 0, last: '' });
      o.qty += Number(p.quantity) || 0; o.total += Number(p.totalAmount) || 0;
      const when = fmtLocal(new Date(Date.parse(a.completedAt))); if (when > o.last) o.last = when;
      if (opts.raw) items.push({ attentionId: a.attentionId, completedAt: a.completedAt, branch: a.restaurantBranchName, origin: a.origin && a.origin.typeName, productId: p.productId, productCatalogueId: p.productCatalogueId, name: p.name, quantity: p.quantity, unitPrice: p.unitPrice, totalAmount: p.totalAmount, attentionTotal: a.totalAmount });
    });
  });
  const result = { source: 'gastronomy', total: total, attentions: atts.length, matched: matched, catalog: target, catalogs: catalogs, branches: branches,
    bySku: Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.qty - a.qty; }) };
  if (opts.raw) result.items = items.slice(0, 300);
  return result;
}

/** "yyyy-MM-ddTHH:mm:ss(.SSS)" en hora de Chile → epoch ms. */
function parseLocalDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(String(str || ''));
  if (!m) return 0;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +((m[7] || '0') + '00').slice(0, 3));
  const off = Utilities.formatDate(new Date(guess), TZ, 'Z'); // ej. -0300
  const sign = off[0] === '-' ? -1 : 1; const offMs = sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(3, 5))) * 60000;
  return guess - offMs;
}

function engineStatus() {
  const st = readState();
  const cfg = readStored();
  const trig = triggerExists();
  return {
    mode: (cfg && cfg.settings && cfg.settings.mode) || 'demo', trigger: trig, version: 10,
    state: st ? { srev: st.srev, status: st.status, k: st.k, t: st.t, open: st.open, closeTick: st.closeTick, runs: st.runs, lastRunAt: st.lastRunAt, lastRunMs: st.lastRunMs, lastError: st.lastError,
      counted: st.sales.counted, lastFetch: st.sales.lastFetch, pushLog: st.pushLog.slice(0, 10), prices: st.prods.map(function (p) { return { t: p.t, eff: p.eff, W: p.W, stock: p.stock, pushed: st.pushed[p.t] }; }) } : null
  };
}

function triggerExists() {
  try { return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === TRIGGER_FN; }); } catch (e) { return false; }
}
function ensureTrigger() {
  if (triggerExists()) return;
  ScriptApp.newTrigger(TRIGGER_FN).timeBased().everyMinutes(1).create();
}
function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === TRIGGER_FN) ScriptApp.deleteTrigger(t); });
}

function readState() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(STATE_CACHE_KEY);
  if (hit) return JSON.parse(hit);
  const props = PropertiesService.getScriptProperties();
  const n = Number(props.getProperty('st_n') || 0);
  if (!n) return null;
  let text = '';
  for (let i = 0; i < n; i++) text += props.getProperty('st_' + i) || '';
  if (!text) return null;
  if (text.length < 100000) cache.put(STATE_CACHE_KEY, text, STATE_CACHE_SECONDS);
  return JSON.parse(text);
}
function writeState(st) {
  const text = JSON.stringify(st);
  const props = PropertiesService.getScriptProperties();
  const parts = {}; let n = 0;
  for (let i = 0; i < text.length; i += CHUNK) parts['st_' + (n++)] = text.slice(i, i + CHUNK);
  parts['st_n'] = String(n);
  const old = Number(props.getProperty('st_n') || 0);
  props.setProperties(parts);
  for (let i = n; i < old; i++) props.deleteProperty('st_' + i);
  if (text.length < 100000) CacheService.getScriptCache().put(STATE_CACHE_KEY, text, STATE_CACHE_SECONDS);
  else CacheService.getScriptCache().remove(STATE_CACHE_KEY);
}

/** Ejecutar UNA VEZ desde el editor para autorizar el acceso a internet del script (UrlFetchApp) y los disparadores (ScriptApp). */
function authorize() {
  ScriptApp.getProjectTriggers();
  UrlFetchApp.fetch('https://www.google.com', { muteHttpExceptions: true });
  PropertiesService.getScriptProperties().getProperty('cfg_n');
  Logger.log('Autorizado. Ya puedes desplegar la versión con integraciones.');
}

/* ---------- integraciones: secretos ---------- */

function getSecrets() {
  const p = PropertiesService.getScriptProperties();
  const o = {};
  SECRET_KEYS.forEach(function (k) { o[k] = p.getProperty(k) || SECRET_DEFAULTS[k] || ''; });
  return o;
}

function secretsStatus() {
  const s = getSecrets();
  const o = {};
  SECRET_KEYS.forEach(function (k) { o[k] = s[k] ? (k.indexOf('KEY') >= 0 ? mask(s[k]) : s[k]) : ''; });
  return o;
}

function mask(v) {
  v = String(v);
  return v.length > 8 ? v.slice(0, 4) + '…' + v.slice(-4) : '••••';
}

/* ---------- integraciones: catálogo (gateway APIM, header apikey) ---------- */

function catalogRequest(method, path, query, body) {
  const s = getSecrets();
  if (!s.CAT_API_KEY || !s.CAT_RESOURCE) throw new Error('Faltan CAT_API_KEY o CAT_RESOURCE');
  let url = s.CAT_BASE_URL.replace(/\/$/, '') + '/integrations/' + encodeURIComponent(s.CAT_RESOURCE) + path;
  if (query) {
    const qs = Object.keys(query)
      .filter(function (k) { return query[k] !== null && query[k] !== undefined && query[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]); })
      .join('&');
    if (qs) url += '?' + qs;
  }
  const options = { method: method, muteHttpExceptions: true, headers: { apikey: s.CAT_API_KEY, Accept: 'application/json' } };
  if (body !== undefined && body !== null) { options.contentType = 'application/json'; options.payload = JSON.stringify(body); }
  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const text = response.getContentText();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }
  if (code < 200 || code >= 300) throw new Error('Catálogo HTTP ' + code + ': ' + text.slice(0, 300));
  if (parsed && parsed.error === true) throw new Error(parsed.message || text.slice(0, 300));
  return parsed;
}

/** Todos los productos del catálogo, ya mapeados: id, name, price, sku, categories, active, hasVariants.
 *  opts.includeVariants agrega el campo variants tal como lo entrega el gateway; opts.raw devuelve los productos sin mapear. */
function catalogProducts(opts) {
  opts = opts || {};
  let page = 1, hasNext = true;
  const out = [];
  while (hasNext && page <= 50) {
    const payload = catalogRequest('get', '/products', {
      pageNumber: page, pageSize: 200, sortBy: 'name_asc',
      includeVariants: opts.includeVariants ? 'true' : 'false', includeTaxes: 'false', includeTags: 'true', includePromotions: 'false'
    });
    const block = payload.data || {};
    (block.products || []).forEach(function (p) {
      if (opts.raw) { out.push(p); return; }
      // El gateway marca el SKU con typeName "SKU" (codeType 20); codeType 10 es el código de barras.
      let sku = '';
      (p.codes || []).forEach(function (c) { if (!sku && String(c.typeName || '').toUpperCase() === 'SKU') sku = String(c.value || '').trim(); });
      if (!sku) (p.codes || []).forEach(function (c) { if (!sku && Number(c.codeType) === 20) sku = String(c.value || '').trim(); });
      const categories = (p.tags || []).filter(function (t) { return Number(t.tagType) === 10; }).map(function (t) { return String(t.name || '').trim(); }).filter(Boolean);
      const row = { id: p.id, name: p.name || '', price: Number(p.price) || 0, sku: sku, categories: categories,
        active: p.active === true || p.active === 1, hasVariants: !!p.hasVariants };
      if (opts.includeVariants) row.variants = p.variants || p.variantGroups || p.options || null;
      out.push(row);
    });
    hasNext = !!(block.pagination && block.pagination.hasNext);
    page++;
    if (hasNext) Utilities.sleep(100);
  }
  return out;
}

/** Actualiza el precio de cada producto del catálogo: [{productId, price}] → [{productId, price, ok, error?}]. */
function pushPrices(list) {
  return list.map(function (it) {
    try {
      catalogRequest('put', '/products/' + encodeURIComponent(it.productId) + '/complex-update', null, { price: Number(it.price) });
      return { productId: it.productId, price: it.price, ok: true };
    } catch (e) {
      return { productId: it.productId, price: it.price, ok: false, error: String(e && e.message ? e.message : e) };
    }
  });
}

/* ---------- integraciones: ventas (POST item/by-period/{rut}, header X-API-Key) ---------- */

function salesItems(initDate, endDate) {
  const s = getSecrets();
  if (!s.SALES_API_KEY || !s.SALES_TAX_ID) throw new Error('Faltan SALES_API_KEY o SALES_TAX_ID');
  const url = s.SALES_BASE_URL.replace(/\/$/, '') + '/item/by-period/' + encodeURIComponent(s.SALES_TAX_ID);
  const response = UrlFetchApp.fetch(url, {
    method: 'post', muteHttpExceptions: true, contentType: 'application/json',
    headers: { 'X-API-Key': s.SALES_API_KEY, Accept: 'application/json' },
    payload: JSON.stringify({ initDate: initDate, endDate: endDate })
  });
  const code = response.getResponseCode();
  const text = response.getContentText();
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error('Ventas HTTP ' + code + ': respuesta no JSON'); }
  if (code < 200 || code >= 300) throw new Error('Ventas HTTP ' + code + ': ' + text.slice(0, 300));
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.data)) return parsed.data;
  throw new Error('Ventas: se esperaba una lista de ítems');
}

/** Ventas del período, solo las del catálogo configurado (o opts.catalog), agregadas por SKU.
 *  Siempre incluye el conteo de líneas por idCatalogue; opts.raw agrega las líneas sin agregar (máx. 300). */
function salesSummary(initDate, endDate, opts) {
  opts = opts || {};
  const s = getSecrets();
  const items = salesItems(initDate, endDate);
  const target = opts.catalog ? String(opts.catalog) : s.CAT_RESOURCE;
  const catalogs = {};
  items.forEach(function (it) { const k = String((it && it.idCatalogue) || '(sin catálogo)'); catalogs[k] = (catalogs[k] || 0) + 1; });
  const mine = opts.all ? items.slice() : items.filter(function (it) { return it && String(it.idCatalogue || '') === target; });
  const by = {};
  mine.forEach(function (it) {
    const key = it.itemCode || ('#' + it.productId);
    const o = by[key] || (by[key] = { sku: key, productId: it.productId, name: String(it.itemName || '').replace(/[\u0000-\u001F\u007F]/g, '').trim(), qty: 0, total: 0, last: '' });
    o.qty += Number(it.itemQuantity) || 0;
    o.total += Number(it.itemTotal) || 0;
    if (String(it.saleDate || '') > o.last) o.last = String(it.saleDate || '');
  });
  const result = { total: items.length, matched: mine.length, catalog: target, catalogs: catalogs,
    bySku: Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.qty - a.qty; }) };
  if (opts.raw) result.items = mine.slice(0, 300);
  return result;
}

function fmtLocal(date) {
  return Utilities.formatDate(date, TZ, "yyyy-MM-dd'T'HH:mm:ss");
}

/* ---------- almacenamiento en Script Properties ---------- */

function readStored(skipCache) {
  const cache = CacheService.getScriptCache();
  if (!skipCache) {
    const hit = cache.get(CACHE_KEY);
    if (hit) return JSON.parse(hit);
  }
  const props = PropertiesService.getScriptProperties();
  const n = Number(props.getProperty('cfg_n') || 0);
  if (!n) return null;
  let text = '';
  for (let i = 0; i < n; i++) text += props.getProperty('cfg_' + i) || '';
  if (!text) return null;
  const cfg = JSON.parse(text);
  if (text.length < 100000) cache.put(CACHE_KEY, text, CACHE_SECONDS);
  return cfg;
}

function writeStored(cfg) {
  const text = JSON.stringify(cfg);
  const props = PropertiesService.getScriptProperties();
  const parts = {};
  let n = 0;
  for (let i = 0; i < text.length; i += CHUNK) parts['cfg_' + (n++)] = text.slice(i, i + CHUNK);
  parts['cfg_n'] = String(n);
  const old = Number(props.getProperty('cfg_n') || 0);
  props.setProperties(parts);
  for (let i = n; i < old; i++) props.deleteProperty('cfg_' + i);
  if (text.length < 100000) CacheService.getScriptCache().put(CACHE_KEY, text, CACHE_SECONDS);
}

function readLog() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(LOG_KEY) || '[]'); } catch (e) { return []; }
}

function logEvent(text) {
  const log = readLog();
  log.push({ at: new Date().toISOString(), changes: text });
  while (log.length > LOG_MAX) log.shift();
  PropertiesService.getScriptProperties().setProperty(LOG_KEY, JSON.stringify(log));
}

function appendLog(cfg, previous) {
  const changes = [];
  if (previous) {
    if (previous.openAt !== cfg.openAt) changes.push('apertura ' + new Date(cfg.openAt).toISOString());
    const prevEv = (previous.events || []).length, nowEv = (cfg.events || []).length;
    if (nowEv > prevEv) changes.push('evento ' + cfg.events[nowEv - 1].type);
    if (previous.nextRefillAt !== cfg.nextRefillAt) changes.push('refill anunciado');
    if (previous.adminHash !== cfg.adminHash) changes.push('contraseña');
    if (JSON.stringify(previous.settings) !== JSON.stringify(cfg.settings)) changes.push('ajustes');
    if (JSON.stringify(previous.products) !== JSON.stringify(cfg.products)) changes.push('productos');
    if (JSON.stringify(previous.headlines) !== JSON.stringify(cfg.headlines)) changes.push('titulares');
    if (!changes.length) changes.push('sin cambios visibles');
  } else {
    changes.push('primera publicación');
  }
  const log = readLog();
  log.push({ at: new Date().toISOString(), rev: cfg.rev, changes: changes.join(', ') });
  while (log.length > LOG_MAX) log.shift();
  PropertiesService.getScriptProperties().setProperty(LOG_KEY, JSON.stringify(log));
}

/* ---------- utilidades ---------- */

function sha256(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

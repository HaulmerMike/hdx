/**
 * HDX · Backend de la mesa de control (Google Apps Script, aplicación web).
 *
 *  - GET  → entrega la configuración vigente del mercado (JSON). Con ?rev=N responde {same:true} si no cambió.
 *           Con ?log=1 entrega el registro de publicaciones.
 *  - POST → recibe {password, config}; verifica la contraseña contra el hash guardado y, si coincide,
 *           guarda la nueva configuración con rev+1 y anota la publicación en el registro.
 *
 * Almacena en Script Properties (no requiere autorización de Google), partiendo el JSON en trozos de 8 KB.
 * La contraseña nunca se guarda: solo su hash SHA-256, que viene dentro de la configuración (adminHash).
 * Se edita y despliega con clasp desde el repositorio (carpeta backend/).
 */

const CHUNK = 8000;
const CACHE_KEY = 'hdx-config';
const CACHE_SECONDS = 15;
const LOG_KEY = 'hdx-log';
const LOG_MAX = 100;

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.log) return json(readLog());
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

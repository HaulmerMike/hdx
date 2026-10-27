/**
 * HDX · Backend de la mesa de control (Google Apps Script, vinculado a una hoja de cálculo).
 *
 * Qué hace:
 *  - GET  → entrega la configuración vigente del mercado (JSON). Con ?rev=N responde {same:true} si no cambió.
 *  - POST → recibe {password, config}; verifica la contraseña contra el hash guardado y, si coincide,
 *           guarda la nueva configuración con rev+1 y deja una línea en la hoja "log".
 *
 * Dónde guarda: hoja "config", celda A1 (JSON). Hoja "log": una fila por publicación.
 * La contraseña nunca se guarda: solo su hash SHA-256, que viene dentro de la configuración (adminHash).
 */

const CFG_SHEET = 'config';
const LOG_SHEET = 'log';
const CACHE_KEY = 'hdx-config';
const CACHE_SECONDS = 15;

function doGet(e) {
  const stored = readStored();
  const rev = Number((e && e.parameter && e.parameter.rev) || -1);
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
      // La referencia es el hash ya guardado; si la hoja está vacía (primera publicación), el de la configuración enviada.
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

/* ---------- almacenamiento ---------- */

function sheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function readStored(skipCache) {
  const cache = CacheService.getScriptCache();
  if (!skipCache) {
    const hit = cache.get(CACHE_KEY);
    if (hit) return JSON.parse(hit);
  }
  const raw = sheet(CFG_SHEET).getRange('A1').getValue();
  if (!raw) return null;
  const cfg = JSON.parse(String(raw));
  cache.put(CACHE_KEY, JSON.stringify(cfg), CACHE_SECONDS);
  return cfg;
}

function writeStored(cfg) {
  const text = JSON.stringify(cfg);
  sheet(CFG_SHEET).getRange('A1').setValue(text);
  CacheService.getScriptCache().put(CACHE_KEY, text, CACHE_SECONDS);
}

function appendLog(cfg, previous) {
  const s = sheet(LOG_SHEET);
  if (s.getLastRow() === 0) s.appendRow(['fecha', 'rev', 'eventos', 'productos', 'cambios']);
  const changes = [];
  if (previous) {
    if (previous.openAt !== cfg.openAt) changes.push('apertura ' + new Date(cfg.openAt).toLocaleTimeString('es-CL'));
    const prevEv = (previous.events || []).length, nowEv = (cfg.events || []).length;
    if (nowEv > prevEv) changes.push('evento ' + cfg.events[nowEv - 1].type);
    if (previous.nextRefillAt !== cfg.nextRefillAt) changes.push('refill anunciado');
    if (previous.adminHash !== cfg.adminHash) changes.push('contraseña');
    if (JSON.stringify(previous.settings) !== JSON.stringify(cfg.settings)) changes.push('ajustes');
    if (JSON.stringify(previous.products) !== JSON.stringify(cfg.products)) changes.push('productos');
  } else {
    changes.push('primera publicación');
  }
  s.appendRow([new Date(), cfg.rev, (cfg.events || []).length, (cfg.products || []).length, changes.join(', ')]);
}

/* ---------- utilidades ---------- */

function sha256(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Útil para probar desde el editor: muestra la configuración guardada. */
function debugShow() {
  Logger.log(JSON.stringify(readStored(true), null, 2));
}

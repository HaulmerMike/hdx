/**
 * HDX · Motor de precios en el servidor (modo "en vivo").
 *
 * Archivo compartido: Apps Script lo carga como script global junto a Code.js; el mock local lo carga con require.
 * No usa ninguna API de Apps Script: todo lo que necesita del exterior (ventas, catálogo, hora) entra por parámetros.
 *
 * Reglas (las mismas de la simulación de la página, con ventas reales en lugar de simuladas):
 *  - El tiempo se divide en ticks de `settings.moveSec` segundos desde `openAt`. En cada tick se evalúa UN producto, por turnos.
 *  - La demanda de un producto es la suma de sus ventas reales en el tick + los impulsos manuales de la mesa de control.
 *  - W = ventas en la ventana de 10 minutos. Precio objetivo = base + round((W - ref) / salesPerStep) * $50,
 *    con ref = settings.refSales * demanda (pop) del producto, +1 escalón si el stock está bajo 15 %. Cada evaluación mueve
 *    el precio hasta $100 y se mantiene entre $100 y $500. Happy Hour aplica el descuento sobre el precio.
 *  - Índice HDX (base 1000) ponderado por volumen, ruedas (tiers) cada minuto, noticias y traders deterministas con la semilla.
 */

var HDX_STEP = 50, HDX_PMIN = 100, HDX_PMAX = 500;
var HDX_TRADER_NAMES = ["La Loba de Haulmerland", "Warren Piscola", "El Oráculo del Fernet", "Gordon Gin", "Doña Dividendos", "Capitán Caipirinha", "La Mano Invisible", "Señor Spritz", "Michelada Capital", "Tío Refill", "Bull de Bellavista", "La Bajista", "Cuenta Corriente Jr.", "Fondo Mutuo Mojito", "El Inversionista Hidratado", "Tasa Fija"];

function hdxClamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function hdxSnap(v) { return Math.round(v / HDX_STEP) * HDX_STEP; }
function hdxHash32(a, b, c) { var h = (a ^ 0x9E3779B9) >>> 0; h = Math.imul(h ^ (b >>> 0), 0x85EBCA6B) >>> 0; h = Math.imul(h ^ (c >>> 0), 0xC2B2AE35) >>> 0; h ^= h >>> 16; h = Math.imul(h, 0x27D4EB2F) >>> 0; h ^= h >>> 15; return h >>> 0; }
function hdxRng(seed) { return function () { seed = (seed + 0x6D2B79F5) >>> 0; var t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function hdxFmtIdx(v) { return v.toFixed(1).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

/** Constantes de tiempo derivadas de settings.moveSec (idénticas a las de la página). */
function engineConsts(settings) {
  var moveSec = Math.max(3, Math.min(120, Number(settings && settings.moveSec) || 15));
  var TICK = moveSec * 1000;
  return {
    TICK: TICK,
    WIN: Math.max(6, Math.round(600000 / TICK)),
    TIER_EVAL: Math.max(2, Math.round(60000 / TICK)),
    TRADER_EVAL: Math.max(4, Math.round(300000 / TICK)),
    MAXH: Math.round(3600000 / TICK),
    BIG_N: Math.max(2, Math.round(30000 / TICK)),
    BIG_COOL: Math.max(4, Math.round(120000 / TICK))
  };
}

function engineHappyAt(cfg, t) { var ev = cfg.events || []; for (var i = 0; i < ev.length; i++) { var e = ev[i]; if (e.type === 'happy' && t >= e.at && t < e.at + e.dur * 60000) return e; } return null; }

/** Estado inicial del motor para una configuración publicada. */
function engineInit(cfg, now) {
  var C = engineConsts(cfg.settings);
  var prods = [], i = 0;
  (cfg.products || []).forEach(function (p) {
    if (p.hidden) return;
    prods.push({ t: p.t, i: i++, base: p.base, stock0: p.stock, stock: p.stock, pop: p.pop || 1, pinned: !!(p.pinned || p.pin), fixed: !!p.fixed, ipoAt: p.ipoAt || null, catalogId: p.catalogId || null,
      price: p.base, eff: p.base, mood: 1, W: 0, ring: [], vol: 0, hist: [], full: [], fullMin: -1, moves: [], suspended: false, active: !p.ipoAt,
      hi: p.base, lo: p.base, changedAt: -1, dir: 0, bigAt: -999, bigDir: 0, pct10: 0 });
    for (var r = 0; r < C.WIN; r++) prods[prods.length - 1].ring.push(0);
  });
  var avgBase = prods.length ? prods.reduce(function (a, p) { return a + p.base; }, 0) / prods.length : 300;
  return {
    srev: 1, version: 1, mode: 'live', cfgRev: cfg.rev || 0, moveSec: (cfg.settings || {}).moveSec || 15, open: cfg.openAt, closeTick: Math.floor((cfg.sessionHours || 8) * 3600000 / C.TICK),
    k: -1, t: cfg.openAt, status: 'pre', startedAt: now, updatedAt: now, lastRunAt: null, lastRunMs: 0, runs: 0, lastError: '',
    prods: prods, idx: [], idxHi: 1000, idxLo: 1000, tiers: { t1: [], t2: [], t3: [] }, news: [], traders: [], totalVol: 0, avgBase: avgBase,
    sales: { seen: {}, counted: 0, unmatched: 0, lastFetch: null },
    pushed: {}, pushLog: []
  };
}

function engineScore(p, C) { return Math.abs(p.pct10) * 100 + p.W * 4 + (p.suspended ? -30 : 0) + (p.bigAt >= 0 && p.changedAt - p.bigAt < C.TRADER_EVAL ? 10 : 0); }

function engineTiers(state, cfg, C) {
  var s = cfg.settings || {}; var act = state.prods.filter(function (p) { return p.active; });
  var pinned = act.filter(function (p) { return p.pinned; }), rest = act.filter(function (p) { return !p.pinned; }).sort(function (a, b) { return engineScore(b, C) - engineScore(a, C); });
  var all = pinned.concat(rest); var n1 = Math.max(pinned.length, s.tier1 || 8), n2 = s.tier2 || 8;
  var tk = function (p) { return p.t; };
  state.tiers = { t1: all.slice(0, n1).map(tk), t2: all.slice(n1, n1 + n2).map(tk), t3: all.slice(n1 + n2).map(tk) };
}

function engineNews(state, cfg, k, t, C) {
  var r = hdxRng(hdxHash32(cfg.seed, 7777, k)); var act = state.prods.filter(function (p) { return p.active && !p.suspended; });
  if (!act.length) return;
  var nameOf = {}; (cfg.products || []).forEach(function (p) { nameOf[p.t] = p.name; });
  var nm = function (p) { return nameOf[p.t] || p.t; };
  var secOf = {}; (cfg.products || []).forEach(function (p) { secOf[p.t] = p.sector; });
  var byChg = act.slice().sort(function (a, b) { return (b.eff / b.base) - (a.eff / a.base); }); var top = byChg[0], bot = byChg[byChg.length - 1];
  var byW = act.slice().sort(function (a, b) { return b.W - a.W; }); var hot = byW[0];
  var pc = function (p) { return Math.abs(Math.round((p.eff - p.base) / p.base * 100)); };
  var last = state.idx[state.idx.length - 1] || 1000;
  var pinOf = {}; (cfg.products || []).forEach(function (p) { pinOf[p.t] = p.pin || ''; });
  var bank = [
    function () { return top.eff > top.base ? nm(top) + ' sube ' + pc(top) + '% tras fuerte demanda en la pista' : null; },
    function () { return bot.eff < bot.base ? nm(bot) + ' toca mínimo de la noche: "oportunidad de compra", dicen en la barra' : null; },
    function () { return 'Analistas recomiendan comprar ' + nm(bot) + ' antes del próximo refill'; },
    function () { return bot.eff < bot.base ? 'Pánico en el sector ' + (secOf[bot.t] || '') + ': ' + nm(bot) + ' cae ' + pc(bot) + '%' : null; },
    function () { return hot.W > 0 ? nm(hot) + ' lidera el volumen con ' + hot.W + ' unidades en 10 minutos' : null; },
    function () { return 'Banco Central de Haulmerland evalúa nueva inyección de liquidez'; },
    function () { return 'Índice HDX en ' + hdxFmtIdx(last) + ' puntos: ' + (last >= 1000 ? 'optimismo' : 'cautela') + ' en la barra'; },
    function () { return 'Rumores de Happy Hour mueven el mercado'; },
    function () { return state.totalVol > 0 ? 'Se transaron ' + state.totalVol + ' tragos desde la apertura' : null; },
    function () { return top.pinned ? nm(top) + ' se mantiene fijado por la organización' + (pinOf[top.t] ? ': "' + pinOf[top.t] + '"' : '') : nm(top) + ' es el activo más rentable de la noche'; }
  ];
  var susp = null; state.prods.forEach(function (p) { if (!susp && p.suspended && p.changedAt >= k - C.TIER_EVAL) susp = p; });
  if (susp) state.news.unshift({ k: k, text: nm(susp) + ' agotado: el mercado suspende su cotización' });
  for (var i = 0; i < 2; i++) { var f = bank[Math.floor(r() * bank.length)]; var txt = f(); if (txt && !state.news.some(function (n) { return n.text === txt; })) state.news.unshift({ k: k, text: txt }); }
  state.news = state.news.slice(0, 8);
}

function engineTraders(state, cfg, k, C) {
  var r = hdxRng(hdxHash32(cfg.seed, 4242, Math.floor(k / C.TRADER_EVAL)));
  var names = HDX_TRADER_NAMES.slice().sort(function () { return r() - 0.5; }).slice(0, 8);
  state.traders = names.map(function (n, i) { var drinks = 2 + Math.floor(r() * 11); var avgPaid = i < 3 ? Math.round((100 + r() * 120) / 10) * 10 : Math.round((120 + r() * 330) / 10) * 10; return { name: n, drinks: drinks, avgPaid: avgPaid, spent: drinks * avgPaid, tx: Math.floor(r() * 7), save: Math.round((state.avgBase - avgPaid) / state.avgBase * 100) }; });
}

/** Un tick del motor. demandFn(k, prod) devuelve las unidades vendidas de ese producto en el tick (ventas reales). */
function engineStep(state, cfg, k, demandFn, C) {
  var t = state.open + k * C.TICK; var s = cfg.settings || {};
  var happy = engineHappyAt(cfg, t); var hp = (s.happyPct || 30) / 100;
  var refSales = Number(s.refSales) > 0 ? Number(s.refSales) : 3.6; var perStep = Number(s.salesPerStep) > 0 ? Number(s.salesPerStep) : 2.5;
  var imps = cfg.impulses || []; var n = state.prods.length;
  var minute = Math.floor(t / 60000);
  state.prods.forEach(function (p) {
    if (p.ipoAt && t < p.ipoAt) { p.hist.push(null); if (p.hist.length > C.MAXH) p.hist.shift(); if (p.fullMin !== minute) { p.full.push(null); p.fullMin = minute; if (p.full.length > 720) p.full.shift(); } return; }
    p.active = true;
    var r = hdxRng(hdxHash32(cfg.seed, p.i + 1, k + 1));
    if (k % C.TRADER_EVAL === 0) p.mood = hdxClamp(p.mood + (r() - 0.5) * 0.55, 0.45, 1.85);
    var sales = Math.max(0, Math.round(Number(demandFn(k, p)) || 0));
    imps.forEach(function (im) { if (im.t === p.t && Math.floor((im.at - state.open) / C.TICK) === k) sales += Number(im.qty) || 0; });
    if (p.stock <= 0) { sales = 0; p.suspended = true; } else { sales = Math.min(sales, p.stock); p.stock -= sales; if (p.stock <= 0) p.suspended = true; }
    var old = p.ring[k % C.WIN]; p.ring[k % C.WIN] = sales; p.W += sales - old; p.vol += sales; state.totalVol += sales;
    if (p.fixed) { p.price = p.base; } // precio fijo: se queda en la base, sin reaccionar a la demanda
    else if (k % n === p.i && !p.suspended) {
      // La referencia crece con la ventana: en los primeros 10 minutos no hay historia completa y no corresponde bajar precios por eso.
      var warm = Math.min(1, (k + 1) / C.WIN);
      var wref = refSales * p.pop * warm; var steps = Math.round((p.W - wref) / perStep);
      if (p.stock > 0 && p.stock <= p.stock0 * 0.15) steps += 1;
      var target = hdxClamp(p.base + steps * HDX_STEP, HDX_PMIN, HDX_PMAX);
      var jump = Math.abs(target - p.price) >= 2 * HDX_STEP ? 2 * HDX_STEP : HDX_STEP;
      if (target > p.price) p.price = Math.min(target, p.price + jump); else if (target < p.price) p.price = Math.max(target, p.price - jump);
    }
    var prevEff = p.eff;
    if (!p.suspended) p.eff = happy ? Math.max(HDX_PMIN, hdxSnap(p.price * (1 - hp))) : p.price;
    if (p.eff !== prevEff) { p.changedAt = k; p.dir = p.eff > prevEff ? 1 : -1; p.moves.push({ k: k, price: p.eff, d: p.eff - prevEff }); if (p.moves.length > 40) p.moves.shift(); }
    p.hi = Math.max(p.hi, p.eff); p.lo = Math.min(p.lo, p.eff);
    p.hist.push(p.eff); if (p.hist.length > C.MAXH) p.hist.shift();
    if (p.fullMin !== minute) { p.full.push(p.eff); p.fullMin = minute; if (p.full.length > 720) p.full.shift(); }
    var h = p.hist, ref = h.length > C.WIN ? h[h.length - 1 - C.WIN] : h[0];
    p.pct10 = ref ? (p.eff - ref) / ref : 0;
    var ref6 = h.length > C.BIG_N ? h[h.length - 1 - C.BIG_N] : null;
    if (ref6 != null && Math.abs(p.eff - ref6) >= 2 * HDX_STEP && k - p.bigAt > C.BIG_COOL) { p.bigAt = k; p.bigDir = p.eff > ref6 ? 1 : -1; }
  });
  var num = 0, den = 0; state.prods.forEach(function (p) { if (!p.active) return; var w = p.vol + 5; num += p.eff * w; den += p.base * w; });
  var idx = den ? Math.round(1000 * num / den * 10) / 10 : 1000; state.idx.push(idx); if (state.idx.length > C.MAXH) state.idx.shift();
  state.idxHi = Math.max(state.idxHi, idx); state.idxLo = Math.min(state.idxLo, idx);
  if (k % C.TIER_EVAL === 0) { engineTiers(state, cfg, C); engineNews(state, cfg, k, t, C); }
  if (k % C.TRADER_EVAL === 0) engineTraders(state, cfg, k, C);
  state.k = k; state.t = t;
}

/** Cuando se publica una configuración nueva sin cambiar la apertura: toma productos nuevos/quitados y stock/pop/pin actualizados. */
function engineSyncConfig(st, cfg) {
  var C = engineConsts({ moveSec: st.moveSec || (cfg.settings || {}).moveSec });
  var byT = {}; st.prods.forEach(function (p) { byT[p.t] = p; });
  var prods = []; var i = 0;
  (cfg.products || []).forEach(function (p) {
    if (p.hidden) return;
    var old = byT[p.t];
    if (old) { old.i = i++; old.base = p.base; old.pop = p.pop || 1; old.pinned = !!(p.pinned || p.pin); old.fixed = !!p.fixed; old.catalogId = p.catalogId || null; if (p.stock !== old.stock0) { old.stock += (p.stock - old.stock0); old.stock0 = p.stock; if (old.stock > 0) old.suspended = false; } prods.push(old); }
    else {
      var np = { t: p.t, i: i++, base: p.base, stock0: p.stock, stock: p.stock, pop: p.pop || 1, pinned: !!(p.pinned || p.pin), fixed: !!p.fixed, ipoAt: p.ipoAt || null, catalogId: p.catalogId || null,
        price: p.base, eff: p.base, mood: 1, W: 0, ring: [], vol: 0, hist: [], full: [], fullMin: -1, moves: [], suspended: false, active: !p.ipoAt, hi: p.base, lo: p.base, changedAt: -1, dir: 0, bigAt: -999, bigDir: 0, pct10: 0 };
      for (var r = 0; r < C.WIN; r++) np.ring.push(0);
      prods.push(np);
    }
  });
  st.prods = prods; st.cfgRev = cfg.rev || 0;
  st.closeTick = Math.floor((cfg.sessionHours || 8) * 3600000 / C.TICK);
}

/** Si cambió el ritmo (moveSec) con el motor andando: estado nuevo con el ritmo nuevo, conservando precio, stock y volumen de cada
 *  producto y la memoria de ventas contadas; el historial parte de cero y el próximo tick a procesar es el actual. */
function engineRestartKeepingPrices(cfg, old, now) {
  var st = engineInit(cfg, now);
  var byT = {}; (old.prods || []).forEach(function (p) { byT[p.t] = p; });
  st.prods.forEach(function (p) { var o = byT[p.t]; if (!o) return; p.price = o.price; p.eff = o.eff; p.stock = o.stock; p.stock0 = o.stock0; p.vol = o.vol; p.hi = o.hi; p.lo = o.lo; p.suspended = o.suspended; p.active = o.active; p.mood = o.mood; });
  st.totalVol = old.totalVol || 0; st.sales = old.sales || st.sales; st.pushed = old.pushed || {}; st.pushLog = old.pushLog || []; st.runs = old.runs || 0; st.startedAt = old.startedAt || now;
  var C = engineConsts({ moveSec: st.moveSec });
  var kNow = Math.floor((now - st.open) / C.TICK);
  st.k = Math.max(-1, kNow - 1); st.t = st.open + Math.max(0, st.k) * C.TICK; st.srev = (old.srev || 0) + 1;
  return st;
}

/** Agrupa las líneas de venta por tick y por ticker. lines: [{key, at(ms), t(ticker), qty}]. Devuelve {buckets, counted, dup}. */
function engineBucketSales(state, lines, kFrom, kTo, C) {
  var buckets = {}, counted = 0, dup = 0; var seen = state.sales.seen || (state.sales.seen = {});
  lines.forEach(function (l) {
    if (!l.t || !(l.qty > 0)) return;
    if (seen[l.key]) { dup++; return; }
    seen[l.key] = l.at;
    var k = Math.floor((l.at - state.open) / C.TICK);
    if (k < kFrom) k = kFrom; if (k > kTo) k = kTo;
    var b = buckets[k] || (buckets[k] = {}); b[l.t] = (b[l.t] || 0) + l.qty; counted += l.qty;
  });
  var cut = Date.now() - 30 * 60000; Object.keys(seen).forEach(function (key) { if (seen[key] < cut) delete seen[key]; });
  return { buckets: buckets, counted: counted, dup: dup };
}

/**
 * Una corrida del motor (la llama el disparador por minuto). Avanza todos los ticks pendientes hasta `now`.
 * io.fetchLines(fromMs, toMs) → [{key, at, t, qty}] (ventas reales ya mapeadas a ticker); io.pushPrice(catalogId, price) → {ok, error}.
 * Devuelve un resumen; muta `state`.
 */
function engineRunOnce(cfg, state, now, io) {
  var C = engineConsts({ moveSec: state.moveSec || (cfg.settings || {}).moveSec }); var started = Date.now();
  state.runs = (state.runs || 0) + 1; state.lastRunAt = now; state.lastError = '';
  var kNow = Math.floor((now - state.open) / C.TICK);
  var summary = { ticks: 0, sales: 0, pushed: 0, errors: [] };
  if (kNow < 0) { state.status = 'pre'; state.lastRunMs = Date.now() - started; return summary; }
  var kTo = Math.min(kNow, state.closeTick);
  if (kTo > state.k) {
    var kFrom = state.k + 1;
    var fromMs = Math.max(state.open, state.open + kFrom * C.TICK - 3 * 60000);
    var lines = [];
    try { lines = io.fetchLines(fromMs, now) || []; state.sales.lastFetch = { at: now, lines: lines.length, error: '' }; }
    catch (e) { var msg = String(e && e.message ? e.message : e); state.sales.lastFetch = { at: now, lines: 0, error: msg }; summary.errors.push('ventas: ' + msg); state.lastError = 'ventas: ' + msg; }
    var bk = engineBucketSales(state, lines, kFrom, kTo, C);
    state.sales.counted = (state.sales.counted || 0) + bk.counted; summary.sales = bk.counted;
    var demandFn = function (k, p) { var b = bk.buckets[k]; return b ? (b[p.t] || 0) : 0; };
    for (var k = kFrom; k <= kTo; k++) { engineStep(state, cfg, k, demandFn, C); summary.ticks++; }
  }
  state.status = kNow >= state.closeTick ? 'closed' : 'open';
  if (state.status === 'open' && (cfg.settings || {}).pushToCatalog !== false && io.pushPrice) {
    state.prods.forEach(function (p) {
      if (!p.catalogId || !p.active) return;
      if (state.pushed[p.t] === p.eff) return;
      var r; try { r = io.pushPrice(p.catalogId, p.eff) || { ok: true }; } catch (e) { r = { ok: false, error: String(e && e.message ? e.message : e) }; }
      if (r.ok) { state.pushed[p.t] = p.eff; summary.pushed++; state.pushLog.unshift({ at: now, t: p.t, price: p.eff, ok: true }); }
      else { summary.errors.push(p.t + ': ' + r.error); state.lastError = 'catálogo ' + p.t + ': ' + r.error; state.pushLog.unshift({ at: now, t: p.t, price: p.eff, ok: false, error: r.error }); }
    });
    state.pushLog = state.pushLog.slice(0, 30);
  }
  state.srev = (state.srev || 0) + 1; state.updatedAt = now; state.lastRunMs = Date.now() - started;
  return summary;
}

/** Versión del estado que se entrega a la página (sin la memoria de ventas ya contadas). */
function enginePublicState(state) {
  if (!state) return null;
  var out = {}; Object.keys(state).forEach(function (k) { if (k !== 'sales' && k !== 'pushed') out[k] = state[k]; });
  out.sales = { counted: state.sales.counted, lastFetch: state.sales.lastFetch };
  return out;
}

/** Mapea una línea de la API de ventas a {key, at, t, qty} usando la configuración (SKU → ticker, catalogId → ticker). */
function engineMapLine(line, index, cfg, parseDate) {
  var bySku = {}, byId = {};
  (cfg.products || []).forEach(function (p) { if (p.t) bySku[String(p.t).toUpperCase()] = p.t; if (p.catalogId) byId[String(p.catalogId)] = p.t; });
  var t = bySku[String(line.itemCode || '').toUpperCase()] || byId[String(line.productId || '')] || '';
  var at = parseDate(line.saleDate);
  return { key: String(line.saleId) + '|' + (line.productId || line.itemCode || line.itemName || '') + '|' + index, at: at, t: t, qty: Number(line.itemQuantity) || 0 };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { engineConsts: engineConsts, engineSyncConfig: engineSyncConfig, engineRestartKeepingPrices: engineRestartKeepingPrices, engineInit: engineInit, engineRunOnce: engineRunOnce, enginePublicState: enginePublicState, engineMapLine: engineMapLine, engineBucketSales: engineBucketSales };
}

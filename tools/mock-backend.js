// Servidor de prueba que imita la aplicación web de Apps Script (config, acciones de integración y motor en vivo) y sirve la página apuntando aquí.
// Uso: node tools/mock-backend.js index.html [puerto]   · env: ENGINE_EVERY=20 (seg entre corridas del motor), AUTO_SALES=1 (ventas aleatorias)
process.env.TZ = 'America/Santiago';
const http = require('http'), fs = require('fs'), crypto = require('crypto'), path = require('path');
const E = require(path.join(__dirname, '..', 'backend', 'Engine.js'));
const PAGE = process.argv[2]; const PORT = Number(process.argv[3] || 8767);
const ENGINE_EVERY = Number(process.env.ENGINE_EVERY || 20) * 1000; const AUTO_SALES = process.env.AUTO_SALES === '1';
let stored = null; let state = null; let trigger = false; const log = [];
const secrets = { CAT_BASE_URL: 'https://mock.gateway/catalogue', CAT_API_KEY: 'mock-key', CAT_RESOURCE: 'mock-catalog', SALES_BASE_URL: 'https://mock.sales', SALES_API_KEY: '', SALES_TAX_ID: '76264675', GASTRO_BASE_URL: 'https://mock.gastro', GASTRO_API_KEY: 'mock-gastro-key', GASTRO_RESOURCE: 'mock-gastro', GASTRO_BRANCH_ID: '' };
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
// catálogo simulado (misma estructura que el de dev)
const ROWS = [['Pisco', 'PSCO', 'Combinados', true], ['Whisky', 'WSKY', 'Combinados', true], ['Gin', 'GINT', 'Combinados', true], ['Fernet', 'FRNT', 'Combinados', true], ['Cerveza', 'CERV', 'Cervezas', true], ['Michelada', 'MICH', 'Cervezas', true], ['Bebida', 'BEBD', 'Sin alcohol', false], ['Jugo', 'JUGO', 'Sin alcohol', false], ['Red Bull', 'RBLL', 'Sin alcohol', false], ['Agua', 'AGUA', 'Sin alcohol', false], ['Tropical Gin', 'TGIN', 'Cócteles', false], ['Ramazzotti', 'RAMZ', 'Cócteles', false], ['Mojito', 'MOJT', 'Cócteles', false], ['Sangría', 'SANG', 'Cócteles', false], ['Aperol Spritz', 'APRL', 'Cócteles', false], ['Tequila Margarita', 'MARG', 'Cócteles', false], ['Caipirinha', 'CAIP', 'Cócteles', false]];
const CAT = ROWS.map((r, i) => ({ id: 1797700 + i, name: r[0], price: 100, sku: r[1], categories: [r[2]], active: true, hasVariants: r[3] }));
const pushed = []; const attentions = []; let attSeq = 2400, lineSeq = 5000;
const fmtLocal = d => { const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };
const parseLocal = s => new Date(String(s).replace(' ', 'T')).getTime();
// Ventas con la estructura de la API de Gastronomía: una atención cerrada y pagada con sus productos.
function sell(sku, qty, when) {
  const c = CAT.find(x => x.sku === sku); if (!c) return null; const at = when || Date.now();
  const line = { productId: ++lineSeq, productCatalogueId: c.id, catalogueResource: secrets.CAT_RESOURCE, name: c.name, quantity: qty, unitPrice: c.price, totalAmount: c.price * qty, isManualProduct: false, isPack: false, packItems: [] };
  const att = { attentionId: ++attSeq, completedAt: new Date(at).toISOString(), totalAmount: c.price * qty, restaurantBranchId: 134, restaurantBranchName: 'Haulmerland Barra', catalogueResource: secrets.CAT_RESOURCE, origin: { typeCode: 'PICKUP', typeName: 'Mostrador', channel: 'POS', deviceId: null }, payments: [{ paymentMethodName: 'Efectivo', amount: c.price * qty }], products: [line] };
  attentions.push(att); return att;
}
function salesItems(initMs, endMs) { return attentions.filter(a => { const t = Date.parse(a.completedAt); return t >= initMs && t <= endMs; }); }
function salesSummary(init, end, opts) {
  const atts = salesItems(parseLocal(init), parseLocal(end)); const catalogs = {}, branches = {}, by = {}; let total = 0, matched = 0; const items = [];
  const byId = {}; ((stored && stored.products) || []).forEach(p => { if (p.catalogId) byId[String(p.catalogId)] = p.t; });
  atts.forEach(a => { const b = a.restaurantBranchId + ' ' + a.restaurantBranchName; branches[b] = (branches[b] || 0) + 1; (a.products || []).forEach(p => { total++; const cr = p.catalogueResource || '(sin catálogo)'; catalogs[cr] = (catalogs[cr] || 0) + 1; if (cr !== secrets.CAT_RESOURCE) return; matched++; const key = byId[String(p.productCatalogueId)] || ('#' + p.productCatalogueId); const o = by[key] || (by[key] = { sku: key, productId: p.productCatalogueId, name: p.name, qty: 0, total: 0, last: '' }); o.qty += p.quantity; o.total += p.totalAmount; const when = fmtLocal(new Date(Date.parse(a.completedAt))); if (when > o.last) o.last = when; if (opts && opts.raw) items.push(Object.assign({ attentionId: a.attentionId, completedAt: a.completedAt }, p)); }); });
  const r = { source: 'gastronomy', total, attentions: atts.length, matched, catalog: secrets.CAT_RESOURCE, catalogs, branches, bySku: Object.values(by).sort((a, b) => b.qty - a.qty) }; if (opts && opts.raw) r.items = items.slice(0, 300); return r;
}
function fetchSalesLines(cfg, fromMs, toMs) { const byId = {}; (cfg.products || []).forEach(p => { if (p.catalogId) byId[String(p.catalogId)] = p.t; }); const out = []; salesItems(fromMs, toMs).forEach(a => (a.products || []).forEach(p => { if (p.catalogueResource !== secrets.CAT_RESOURCE) return; out.push({ key: 'g' + a.attentionId + '|' + p.productId, at: Date.parse(a.completedAt), t: byId[String(p.productCatalogueId)] || '', qty: p.quantity }); })); return out; }
function engineTick(force) {
  const cfg = stored; if (!cfg) return { skipped: 'sin configuración' };
  const mode = (cfg.settings || {}).mode || 'demo'; if (mode !== 'live' && !force) return { skipped: 'modo ' + mode };
  const now = Date.now(); if (!state || state.open !== cfg.openAt) state = E.engineInit(cfg, now); else if (state.moveSec !== ((cfg.settings || {}).moveSec || 15)) state = E.engineRestartKeepingPrices(cfg, state, now);
  if (state.cfgRev !== (cfg.rev || 0)) E.engineSyncConfig(state, cfg);
  const summary = E.engineRunOnce(cfg, state, now, { fetchLines: (a, b) => fetchSalesLines(cfg, a, b), pushPrice: (id, price) => { const c = CAT.find(x => x.id === id); if (!c) return { ok: false, error: 'no existe' }; c.price = price; pushed.push({ at: now, id, price }); return { ok: true }; } });
  console.log(new Date().toLocaleTimeString(), 'engineTick', JSON.stringify(summary), 'k', state.k, 'srev', state.srev);
  return summary;
}
function engineStatus() { return { mode: (stored && stored.settings && stored.settings.mode) || 'demo', trigger, version: 10, state: state ? { srev: state.srev, status: state.status, k: state.k, t: state.t, open: state.open, closeTick: state.closeTick, runs: state.runs, lastRunAt: state.lastRunAt, lastRunMs: state.lastRunMs, lastError: state.lastError, counted: state.sales.counted, lastFetch: state.sales.lastFetch, pushLog: state.pushLog.slice(0, 10), prices: state.prods.map(p => ({ t: p.t, eff: p.eff, W: p.W, stock: p.stock, pushed: state.pushed[p.t] })) } : null }; }
setInterval(() => { if (trigger) engineTick(false); }, ENGINE_EVERY);
if (AUTO_SALES) setInterval(() => { const c = CAT[Math.floor(Math.random() * CAT.length)]; const q = Math.random() < 0.6 ? 1 : 2; if (Math.random() < 0.8) { sell(c.sku, q); console.log('venta', c.sku, q); } }, 12000);

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const send = (o) => { res.writeHead(200, cors); res.end(JSON.stringify(o)); };
  if (u.pathname === '/api' && req.method === 'GET') {
    if (u.searchParams.get('integrations')) return send({ integrations: Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, k.includes('KEY') ? (v.length > 8 ? v.slice(0, 4) + '…' + v.slice(-4) : '••••') : v])), version: 11 });
    if (u.searchParams.get('log')) return send(log);
    if (u.searchParams.get('engine')) return send(engineStatus());
    if (u.searchParams.get('state')) { if (!state) return send({ srev: 0, empty: true }); if (Number(u.searchParams.get('srev') || -1) === state.srev) return send({ srev: state.srev, same: true }); return send(E.enginePublicState(state)); }
    const rev = Number(u.searchParams.get('rev') || -1);
    if (stored && stored.rev === rev) return send({ rev, same: true });
    if (!stored) return send({ rev: 0, empty: true });
    return send(stored);
  }
  if (u.pathname === '/api' && req.method === 'POST') {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      try {
        const body = JSON.parse(b);
        if (body.action) {
          const ref = stored && stored.adminHash; if (!ref || sha(String(body.password || '')) !== ref) return send({ ok: false, error: 'auth' });
          switch (body.action) {
            case 'secrets': Object.assign(secrets, body.secrets || {}); log.push({ at: new Date().toISOString(), changes: 'integraciones' }); return send({ ok: true });
            case 'catalog': return send({ ok: true, resource: secrets.CAT_RESOURCE, products: CAT });
            case 'catalogGet': return send({ ok: false, error: 'Catálogo HTTP 404: ruta no disponible en integrations' });
            case 'sales': { const now = new Date(); const init = body.initDate || fmtLocal(new Date(now.getTime() - 86400000)), end = body.endDate || fmtLocal(now); return send(Object.assign({ ok: true, initDate: init, endDate: end }, salesSummary(init, end, { raw: body.raw === true, all: body.all === true }))); }
            case 'pushPrices': { const results = (body.prices || []).map(p => { const c = CAT.find(x => x.id === p.productId); if (c) c.price = p.price; pushed.push({ at: Date.now(), id: p.productId, price: p.price }); return { productId: p.productId, price: p.price, ok: !!c, error: c ? undefined : 'no existe' }; }); console.log('pushPrices', JSON.stringify(results)); return send({ ok: true, results }); }
            case 'engineStart': state = E.engineInit(stored, Date.now()); trigger = true; log.push({ at: new Date().toISOString(), changes: 'motor iniciado' }); return send({ ok: true, status: engineStatus() });
            case 'engineStop': trigger = false; return send({ ok: true, status: engineStatus() });
            case 'engineRun': return send({ ok: true, summary: engineTick(true), status: engineStatus() });
            case 'engineStatus': return send({ ok: true, status: engineStatus() });
            default: return send({ ok: false, error: 'acción desconocida' });
          }
        }
        const cfg = body.config; const ref = stored && stored.adminHash ? stored.adminHash : cfg.adminHash; if (sha(String(body.password || '')) !== ref) return send({ ok: false, error: 'auth' });
        cfg.rev = ((stored && stored.rev) || 0) + 1; cfg.updatedAt = Date.now(); stored = cfg; log.push({ rev: cfg.rev, changes: 'publicación' }); console.log('publicado rev', cfg.rev, 'modo', cfg.settings && cfg.settings.mode); return send({ ok: true, rev: cfg.rev });
      } catch (e) { return send({ ok: false, error: String(e) }); }
    });
    return;
  }
  if (u.pathname === '/sell') { const a = sell(String(u.searchParams.get('t') || '').toUpperCase(), Number(u.searchParams.get('qty') || 1)); return send(a ? { ok: true, attention: a } : { ok: false, error: 'ticker desconocido' }); }
  if (u.pathname === '/tick') { return send({ ok: true, summary: engineTick(true) }); }
  if (u.pathname === '/state') { return send({ rev: stored && stored.rev, mode: stored && stored.settings && stored.settings.mode, trigger, k: state && state.k, srev: state && state.srev, pushed: pushed.slice(-20), cat: CAT.map(c => [c.sku, c.price]), sales: attentions.length }); }
  let html = fs.readFileSync(PAGE, 'utf8').replace(/const BACKEND_URL='[^']*';/, "const BACKEND_URL='http://localhost:" + PORT + "/api';");
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
}).listen(PORT, () => console.log('mock backend on http://localhost:' + PORT + ' · motor cada ' + ENGINE_EVERY / 1000 + ' s · ventas automáticas: ' + (AUTO_SALES ? 'sí' : 'no')));

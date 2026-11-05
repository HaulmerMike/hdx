#!/usr/bin/env node
// Compara el catálogo configurado en el backend HDX con la estructura de tragos de la página.
// Uso: HDX_PW='<contraseña admin>' node tools/check-catalog.js [--variants] [--raw]
const fs = require('fs');
const path = require('path');
const HDX = path.join(__dirname, '..');
const URL_ = require(path.join(HDX, 'backend/deployment.json')).url;
const PW = process.env.HDX_PW;
if (!PW) { console.error('Falta HDX_PW'); process.exit(1); }
const wantVariants = process.argv.includes('--variants');
const wantRaw = process.argv.includes('--raw');

// Estructura esperada (export del catálogo de producción "Haulmerland Barra").
const EXPECTED = [
  ['PSCO', 'Pisco', 'Combinados'], ['WSKY', 'Whisky', 'Combinados'], ['GINT', 'Gin', 'Combinados'], ['FRNT', 'Fernet', 'Combinados'],
  ['TGIN', 'Tropical Gin', 'Combinados'], ['RAMZ', 'Ramazzotti', 'Combinados'],
  ['CERV', 'Cerveza', 'Cervezas'], ['MICH', 'Michelada', 'Cervezas'],
  ['BEBD', 'Bebida', 'Sin alcohol'], ['JUGO', 'Jugo', 'Sin alcohol'], ['RBLL', 'Red Bull', 'Sin alcohol'], ['AGUA', 'Agua', 'Sin alcohol'],
  ['MOJT', 'Mojito', 'Cócteles'], ['SANG', 'Sangría', 'Cócteles'], ['APRL', 'Aperol Spritz', 'Cócteles'], ['MARG', 'Tequila Margarita', 'Cócteles'], ['CAIP', 'Caipirinha', 'Cócteles'],
];

async function post(body) {
  const r = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(Object.assign({ password: PW }, body)), redirect: 'follow' });
  return r.json();
}

function pageProducts() {
  const h = fs.readFileSync(path.join(HDX, 'src/index.html'), 'utf8');
  const m = h.match(/<script type="application\/json" id="hdx-config">([\s\S]*?)<\/script>/);
  return JSON.parse(m[1]).products;
}

(async () => {
  const res = await post({ action: 'catalog', includeVariants: wantVariants, raw: wantRaw });
  if (!res.ok) { console.error('Error catálogo:', res.error); process.exit(2); }
  if (wantRaw) { console.log(JSON.stringify(res.products, null, 2)); return; }
  const cat = res.products;
  console.log(`Catálogo ${res.resource}: ${cat.length} productos\n`);
  const w = (s, n) => String(s == null ? '' : s).padEnd(n).slice(0, n);
  console.log(w('SKU', 6) + w('Nombre', 24) + w('Precio', 8) + w('Categorías', 24) + w('Activo', 7) + 'Variantes');
  for (const p of cat) console.log(w(p.sku || '—', 6) + w(p.name, 24) + w(p.price, 8) + w(p.categories.join(', '), 24) + w(p.active ? 'sí' : 'NO', 7) + (p.hasVariants ? 'sí' : ''));

  const issues = [];
  const bySku = new Map();
  for (const p of cat) {
    if (!p.sku) issues.push(`Sin SKU: "${p.name}" (#${p.id})`);
    else if (bySku.has(p.sku)) issues.push(`SKU duplicado ${p.sku}: "${p.name}" y "${bySku.get(p.sku).name}"`);
    else bySku.set(p.sku, p);
    if (!p.categories.length) issues.push(`Sin categoría: ${p.sku || p.name}`);
    if (p.categories.length > 1) issues.push(`Varias categorías (se usa la primera): ${p.sku || p.name} → ${p.categories.join(', ')}`);
    if (!p.active) issues.push(`Inactivo (quedaría oculto): ${p.sku || p.name}`);
    if (p.price && (p.price < 100 || p.price > 500 || p.price % 50)) issues.push(`Precio fuera de la escala HDX ($100–$500 de a $50), se usará $300 de base: ${p.sku || p.name} = $${p.price}`);
  }
  for (const [sku, name, sector] of EXPECTED) {
    const p = bySku.get(sku);
    if (!p) { issues.push(`Falta en el catálogo: ${sku} (${name})`); continue; }
    if (p.name.trim().toLowerCase() !== name.toLowerCase()) issues.push(`Nombre distinto en ${sku}: catálogo "${p.name}" vs esperado "${name}"`);
    if ((p.categories[0] || '').toLowerCase() !== sector.toLowerCase()) issues.push(`Categoría distinta en ${sku}: catálogo "${p.categories[0] || '—'}" vs esperada "${sector}"`);
  }
  for (const sku of bySku.keys()) if (!EXPECTED.some(e => e[0] === sku)) issues.push(`Producto extra (no estaba en prod): ${sku} "${bySku.get(sku).name}"`);

  const page = pageProducts();
  const pageSkus = new Set(page.map(p => p.t));
  const willRename = [...bySku.keys()].filter(s => !pageSkus.has(s));
  const willDrop = [...pageSkus].filter(s => !bySku.has(s));

  console.log('\n' + (issues.length ? 'Observaciones:\n- ' + issues.join('\n- ') : 'Sin observaciones: estructura idéntica a la esperada.'));
  console.log(`\nAl importar en la página: ${willRename.length} tickers nuevos (${willRename.join(', ') || '—'}), ${willDrop.length} tickers actuales que desaparecen (${willDrop.join(', ') || '—'}).`);
  if (wantVariants) {
    console.log('\nVariantes:');
    for (const p of cat.filter(p => p.hasVariants || p.variants)) console.log(p.sku || p.name, JSON.stringify(p.variants));
  }
})().catch(e => { console.error(e); process.exit(3); });

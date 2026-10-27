// Genera index.html (documento completo para GitHub Pages) a partir de src/index.html,
// que es el fragmento que se publica como artefacto en claude.ai.
const fs = require('fs');
let src = fs.readFileSync('src/index.html', 'utf8');
// La versión publicada en Pages usa el backend de Apps Script; el artefacto de claude.ai no (su sandbox bloquea fetch externo).
const backend = JSON.parse(fs.readFileSync('backend/deployment.json', 'utf8'));
if (!src.includes("const BACKEND_URL='';")) throw new Error('No se encontró BACKEND_URL en src/index.html');
src = src.replace("const BACKEND_URL='';", "const BACKEND_URL='" + backend.url + "';");
const title = (src.match(/<title>[\s\S]*?<\/title>/) || [''])[0];
src = src.replace(title, '').replace(/<meta name="claude:viewport-fit-sides"[^>]*>\s*/, '');
const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${title}
<meta name="description" content="Bolsa de tragos de Haulmerland: precios que cambian con la demanda.">
<style>:root{color-scheme:dark}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
${src.trim()}
</body>
</html>
`;
fs.writeFileSync('index.html', html);
console.log('index.html generado:', (html.length / 1024).toFixed(0), 'KB');

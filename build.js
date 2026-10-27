// Genera index.html (documento completo para GitHub Pages) a partir de src/index.html,
// que es el fragmento que se publica como artefacto en claude.ai.
const fs = require('fs');
let src = fs.readFileSync('src/index.html', 'utf8');
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

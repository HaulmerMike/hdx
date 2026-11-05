# Haulmerland Drinking Exchange (HDX)

Bolsa de tragos para la fiesta aniversario Haulmerland.
Un solo archivo (`index.html`): tablero, modo TV (`#tv`) y mesa de control (`#admin`).

- Precios simbólicos entre $100 y $500, en escalones de $50, que reaccionan a la demanda.
- Modo demo: mercado simulado de forma determinista (semilla + reloj), todas las pantallas muestran lo mismo.
- Modo en vivo: el backend lee las ventas reales del catálogo cada minuto, mueve los precios y los envía al catálogo del Kiosko.
- Verde = más barato que la apertura, rojo = más caro.

Publicado con GitHub Pages desde la rama `main`.

## Estructura

- `src/index.html`: fuente de la página (fragmento, también publicado como artefacto en claude.ai).
- `build.js`: envuelve la fuente en un documento HTML completo, inyecta la URL del backend y genera `index.html`, que es lo que sirve GitHub Pages.
- `backend/`: aplicación web de Apps Script (configuración compartida, integraciones con catálogo y ventas, motor en vivo). Ver `backend/README.md`.
- `tools/check-catalog.js`: compara el catálogo configurado con la carta esperada y con los tickers de la página (`HDX_PW=… node tools/check-catalog.js [--variants|--raw]`).
- `tools/mock-backend.js`: servidor local que imita el backend, incluido el motor en vivo, para probar la página sin tocar las APIs reales
  (`node tools/mock-backend.js index.html 8767`; `ENGINE_EVERY=20` segundos entre corridas, `AUTO_SALES=1` ventas aleatorias,
  `GET /sell?t=PSCO&qty=2` inyecta una venta, `GET /tick` fuerza una corrida).

Después de editar `src/index.html`:

```bash
node build.js
```

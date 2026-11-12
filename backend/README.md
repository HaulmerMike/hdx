# Backend de la mesa de control (Apps Script)

La página publicada lee la configuración del mercado desde este script cada 10 segundos
y la mesa de control la escribe aquí. Así un Happy Hour, un refill o un pin llegan a la TV
y a todos los teléfonos. En modo "en vivo", además, el script corre el motor de precios con
las ventas reales del catálogo y publica el estado del mercado para todas las pantallas.

- `Code.js`: aplicación web (configuración, integraciones con catálogo y ventas, acciones del motor, disparador).
- `Engine.js`: motor de precios puro (sin APIs de Apps Script); lo usa también el mock local `tools/mock-backend.js`.
- `appsscript.json`: manifiesto (acceso anónimo, se ejecuta como el dueño; scopes `external_request` y `scriptapp`).
- `deployment.json`: ids del script y de la implementación, y la URL `/exec` que `build.js` inyecta en `index.html`.

## Editar y desplegar (clasp, ya autenticado en esta máquina)

```bash
cd backend && clasp push --force && clasp deploy -i AKfycbzJiQlKQd0Z9rwzcP4d38dVPdxZvsncmq_st8JxVFu7zuGoAsPPst6QbbLwYc9Kknw6 -d "descripción"
```

La URL no cambia entre versiones. Un `push` sin `deploy` solo actualiza el borrador (HEAD), no la URL publicada.
Si cambian los scopes del manifiesto, el dueño debe ejecutar `authorize` una vez desde el editor.

## API

- `GET <url>?rev=N` → `{same:true}` si no cambió; si no, la configuración completa. Sin nada guardado: `{rev:0, empty:true}`.
- `GET <url>?state=1&srev=N` → estado del mercado en vivo (precios, historial, índice, ruedas, noticias); `{same:true}` si no cambió.
- `GET <url>?engine=1` → estado del motor: disparador activo, modo publicado, último tick, ventas contadas, envíos al catálogo.
- `GET <url>?integrations=1` → estado enmascarado de las claves. `GET <url>?log=1` → registro de publicaciones.
- `POST <url>` con `{"password": "...", "config": {...}}` como texto plano (evita el preflight de CORS) → `{ok:true, rev}`.
- `POST <url>` con `{"password": "...", "action": "..."}`:
  `secrets` (guardar claves), `catalog` (listar; `includeVariants`, `raw`), `catalogGet` (GET libre al gateway, solo lectura),
  `sales` (`initDate`, `endDate`, `raw`, `all`, `catalog`), `pushPrices` (`[{productId, price}]`),
  `engineStart` (reinicia el estado y crea el disparador por minuto), `engineStop` (quita el disparador), `engineRun` (una corrida ahora), `engineStatus`.
- Lecturas con caché corta para soportar muchos teléfonos consultando a la vez.

## Fuentes de ventas

- **Gastronomía** (preferida): con `GASTRO_BASE_URL`, `GASTRO_API_KEY` y `GASTRO_RESOURCE` (gastronomyId del espacio; opcional `GASTRO_BRANCH_ID`,
  "0" = todas las sucursales). `GET {base}/integrations/v1/gastronomy/{resource}/sales?startDate&endDate&page&pageSize` con header
  `X-API-Key`: atenciones cerradas y pagadas, cada una con `products[]` (`productCatalogueId`, `quantity`, `unitPrice`) y
  `catalogueResource`. Filtra por día en UTC (máx. 90 días, 50 por página, de la más reciente a la más antigua); el backend pide con un
  día de margen, filtra por `completedAt` y deja de paginar al pasar el inicio del período. Las líneas se mapean a ticker por el id de
  producto del catálogo y se descartan las de otros catálogos. `totalAmount` de la atención incluye la propina, por eso puede superar la
  suma de las líneas.
- **Ventas por ítem** (API antigua, respaldo): `SALES_BASE_URL`, `SALES_API_KEY`, `SALES_TAX_ID`; solo las líneas que traen
  `idCatalogue` del catálogo configurado. Las ventas hechas desde Gastronomía llegan ahí como "Item Manual" sin detalle.

## Motor en vivo

`engineTick` corre cada minuto por un disparador de tiempo. Si el modo publicado es `live`:

1. Lee las ventas del catálogo configurado desde el último tick procesado (con 3 minutos de traslape y memoria de líneas ya contadas).
2. Avanza todos los ticks pendientes con las reglas de la simulación (un producto evaluado por tick, ventana de 10 minutos,
   `refSales` ventas esperadas por producto, `salesPerStep` ventas por escalón de $50, Happy Hour, stock, IPO, impulsos manuales).
3. Envía al catálogo (complex-update) el precio de cada producto que cambió, si `pushToCatalog` está activo.
4. Guarda el estado en Script Properties (`st_*`) y lo entrega en `?state=1`. La página en modo en vivo lo lee cada 4 segundos.

El estado se reinicia con `engineStart` o cuando cambia la hora de apertura publicada. Publicar una configuración nueva sin cambiar
la apertura conserva precios e historial y sincroniza productos, stock, demanda y pines.

## Seguridad

- La contraseña viaja por HTTPS y nunca se guarda; el script compara su SHA-256 con el hash guardado.
- Las claves de las APIs internas viven solo en Script Properties y nunca vuelven completas a la página.
- Sin nada guardado, la primera publicación se acepta cuando la contraseña coincide con el hash de la
  configuración enviada. Cambiar la contraseña desde la admin requiere la vigente.

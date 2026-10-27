# Backend de la mesa de control (Apps Script)

La página publicada lee la configuración del mercado desde este script cada 10 segundos
y la mesa de control la escribe aquí. Así un Happy Hour, un refill o un pin llegan a la TV
y a todos los teléfonos.

- Script: `Code.js` (aplicación web de Apps Script, almacena en Script Properties, sin autorización de Google).
- Manifiesto: `appsscript.json` (acceso: cualquier usuario, anónimo; se ejecuta como el dueño).
- `deployment.json`: ids del script y de la implementación, y la URL `/exec` que `build.js` inyecta en `index.html`.
- Contenedor: hoja de cálculo "HDX config" en el Drive de Miguel (sin uso por ahora).

## Editar y desplegar (clasp, ya autenticado en esta máquina)

```bash
cd backend && clasp push --force && clasp deploy -i AKfycbzJiQlKQd0Z9rwzcP4d38dVPdxZvsncmq_st8JxVFu7zuGoAsPPst6QbbLwYc9Kknw6 -d "descripción"
```

La URL no cambia entre versiones. Un `push` sin `deploy` solo actualiza el borrador (HEAD), no la URL publicada.

## API

- `GET <url>?rev=N` → `{same:true}` si no cambió; si no, la configuración completa. Sin nada guardado: `{rev:0, empty:true}`.
- `GET <url>?log=1` → registro de publicaciones (últimas 100).
- `POST <url>` con cuerpo `{"password": "...", "config": {...}}` como texto plano (evita el preflight de CORS).
  Responde `{ok:true, rev}` o `{ok:false, error:"auth"|"config"}`.
- Lecturas con caché de 15 segundos para soportar muchos teléfonos consultando a la vez.

## Seguridad

- La contraseña viaja por HTTPS y nunca se guarda; el script compara su SHA-256 con el hash guardado.
- Sin nada guardado, la primera publicación se acepta cuando la contraseña coincide con el hash de la
  configuración enviada. Cambiar la contraseña desde la admin requiere la vigente.

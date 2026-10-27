# Backend de la mesa de control (Apps Script)

La página publicada lee la configuración del mercado desde este script cada 10 segundos
y la mesa de control la escribe aquí. Así un Happy Hour, un refill o un pin llegan a la TV
y a todos los teléfonos.

## Despliegue (una vez, unos 5 minutos)

1. Crea una hoja de cálculo nueva en Google Drive, por ejemplo `HDX config`.
2. En la hoja: **Extensiones → Apps Script**. Borra el contenido de `Código.gs` y pega el de `backend/Code.gs`. Guarda.
3. **Implementar → Nueva implementación**. Tipo: **Aplicación web**.
   - Descripción: `HDX`.
   - Ejecutar como: **Yo**.
   - Quién tiene acceso: **Cualquier usuario** (necesario para que la TV y los teléfonos lean sin iniciar sesión).
   - Autoriza los permisos cuando los pida.
4. Copia la **URL de la aplicación web** (termina en `/exec`).
5. Pega esa URL en `src/index.html`, en la constante `BACKEND_URL`, ejecuta `node build.js` y sube los cambios.
6. Abre la página con `#admin`, entra con la contraseña y pulsa **Publicar cambios** una vez: esa primera
   publicación deja la configuración guardada en la hoja.

Para cambiar el código del script más adelante: pega la versión nueva y haz **Implementar → Administrar
implementaciones → editar → Versión: Nueva**. La URL se mantiene.

## Cómo funciona

- `GET <url>?rev=N` responde `{same:true}` si la configuración no cambió, o la configuración completa.
- `POST <url>` con cuerpo `{"password": "...", "config": {...}}` (como texto plano, para evitar el
  preflight de CORS) guarda la configuración si la contraseña coincide con el hash guardado.
- La hoja `config` guarda el JSON en A1; la hoja `log` registra cada publicación.
- Lecturas con caché de 15 segundos para soportar muchos teléfonos consultando a la vez.

## Seguridad

- La contraseña viaja por HTTPS y nunca se guarda; el script compara su SHA-256 con el hash guardado.
- Si la hoja está vacía, la primera publicación se acepta cuando la contraseña coincide con el hash
  de la configuración enviada. Haz esa primera publicación apenas despliegues.
- Cambiar la contraseña desde la admin requiere la contraseña vigente.

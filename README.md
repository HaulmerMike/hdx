# Haulmerland Drinking Exchange (HDX)

Maqueta de la bolsa de tragos para la fiesta aniversario Haulmerland.
Un solo archivo (`index.html`): tablero, modo TV (`#tv`) y mesa de control (`#admin`).

- Precios simbólicos entre $100 y $500, en escalones de $50, que reaccionan a la demanda.
- Mercado simulado de forma determinista (semilla + reloj): todas las pantallas muestran lo mismo.
- Verde = más barato que la apertura, rojo = más caro.

Publicado con GitHub Pages desde la rama `main`.

## Estructura

- `src/index.html`: fuente de la página (fragmento, también publicado como artefacto en claude.ai).
- `build.js`: envuelve la fuente en un documento HTML completo y genera `index.html`, que es lo que sirve GitHub Pages.

Después de editar `src/index.html`:

```bash
node build.js
```

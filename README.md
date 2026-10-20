# Evercade Library

App web para llevar al día tu colección de cartuchos Evercade. Sin dependencias: HTML, CSS y JavaScript.

## Uso

```bash
npm start          # abre http://localhost:5173
```

Desde el móvil, conectado a la misma red Wi-Fi, abre la dirección "En tu red local" que muestra la consola.

## Funciones

- Marca los cartuchos que tienes (botón a la derecha de cada cartucho).
- Despliega un cartucho para ver sus juegos con captura, género, jugadores y descripción. Toca una captura para ampliarla.
- Cada juego tiene un botón **Pasado / Por pasar**. Cada cartucho muestra su % de compleción, que es la media de sus juegos: cada juego pasado cuenta como 100 %. Por ejemplo, 3 de 13 pasados = 23 %.
- Un único buscador para cartuchos y juegos:
  - En la pestaña **Cartuchos** aparecen los cartuchos cuyo nombre coincide o que contienen un juego que coincide.
  - En la pestaña **Juegos** se muestra cada juego y en qué cartucho o cartuchos está. Los que ya tienes salen en verde.
- Etiqueta **Legacy** y filtros: Tengo / Me faltan, Legacy / En producción, categoría (Arcade, Console, Home Computer) y orden.
- Sección **Desbloqueables**, con dos apartados:
  - **Por código**: códigos de texto, combinaciones de botones y extras que no son juegos.
  - **Con 2 cartuchos** (Evercade VS / VS-R): indica qué cartuchos tienes y cuáles te faltan para cada juego.

  Los datos están en `public/data/unlockables.json` y se editan a mano.
- Exportar e importar la colección en JSON, como copia de seguridad o para pasarla a otro dispositivo.

## Datos

- **Catálogo**: `public/data/catalog.json`, generado desde https://evercade.co.uk/cartridges/.
  Para actualizarlo cuando salgan cartuchos nuevos:
  ```bash
  npm run scrape          # las imágenes se cargan desde evercade.co.uk
  npm run scrape:images   # además descarga portadas y capturas a public/img (uso sin conexión)
  ```
- **Base de datos local**: IndexedDB del navegador (`evercade-library`), con el catálogo y tu colección.
  Cada navegador o dispositivo guarda su propia colección. Usa Exportar/Importar para pasarla de uno a otro.

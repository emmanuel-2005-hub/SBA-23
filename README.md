# Catálogo desde el celular

Prototipo independiente del ticket SBA-23. No se conecta al repositorio ni a los servicios reales de SIGBA.

## Requisitos y ejecución

Requiere Node.js 24 o superior (usa el SQLite integrado en Node).

```powershell
npm start
```

Abre `http://localhost:3000`. La base de datos local se crea en `.data/catalogo.sqlite`. El catálogo de ejemplo incluye arroz, frijol y sus presentaciones.

## Pruebas

```powershell
npm test
```

## Qué incluye

- Catálogo adaptable a celular, búsqueda por nombre, presentación, categoría o código externo del Banco.
- Comparación de texto sin distinguir mayúsculas ni tildes; la búsqueda espera 160 ms antes de consultar.
- Sugerencias del mismo producto cuando coincide el nombre normalizado o la equivalencia en kilos.
- Alta de presentaciones solo para productos existentes; quedan activas y marcadas `createdFromMobile`.
- Persistencia SQLite, con la referencia y la clave idempotente guardadas en una sola transacción.
- `commandId` UUIDv7 en el navegador. El servidor devuelve el resultado anterior ante un reintento idéntico y responde 409 si el mismo comando llega con otros datos.
- Catálogo con ETag y respuesta 304; PWA con caché de la aplicación y caché local del catálogo para consulta sin señal.
- Sin alta optimista fuera de línea: la cola de comandos y su reconciliación pertenecen a la iteración 3.

## Endpoints

- `GET /api/products`
- `GET /api/search?q=arr`
- `GET /api/references/suggestions?productId=prod-arroz&presentation=500%20g&equivalenceKg=0.5`
- `GET /api/catalog` (ETag y `If-None-Match`)
- `POST /api/references/from-mobile`

El `POST` recibe `commandId`, `productId`, `presentation` y `equivalenceKg`. Requiere un UUID válido y un producto existente.

## Límites frente al ticket original

Este prototipo no sustituye la implementación en SIGBA. No incluye NestJS, Prisma, roles/autorización, la migración del esquema existente, integración con recepciones, edición o desactivación de categorías/productos, pruebas contra Postgres ni la cola de sincronización. El catálogo y los códigos son datos sintéticos de demostración. Antes de integrar, hay que adaptar nombres, contratos, persistencia, autenticación y reglas al repositorio real.

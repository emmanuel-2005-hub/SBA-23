# Catálogo local de bodega

Aplicación independiente inspirada en el flujo descrito para SBA-23. Usa datos de demostración y una base SQLite propia; no se conecta a SIGBA, Auth0 ni a servicios externos.

## Requisitos y ejecución

Requiere Node.js 24 o superior (incluye `node:sqlite`).

```powershell
npm start
```

Abre <http://localhost:3000>. En la primera visita desde el mismo equipo, crea la cuenta administradora con nombre, correo y una contraseña de al menos 12 caracteres. Esa configuración inicial solo se permite desde una dirección local para impedir que otra persona reclame la cuenta por la red. No hay contraseñas predeterminadas ni registro público. La administración crea después cuentas con rol de operario, coordinación o administración.

La base persistente se crea en `.data/catalogo.sqlite`. Incluye datos sintéticos de arroz y frijol para probar el flujo. Protege ese archivo y haz copias de respaldo: contiene las cuentas, sesiones y datos de la aplicación.

Por seguridad, el servidor solo escucha en `127.0.0.1` de forma predeterminada. Para probar desde un teléfono en una red local de confianza, configura `HOST=0.0.0.0` y permite el puerto 3000 solo en esa red; configura la primera cuenta desde el equipo servidor. No uses HTTP en una red pública ni introduzcas contraseñas reales fuera de un despliegue HTTPS protegido.

Puedes elegir otra ruta de base de datos y puerto con variables de entorno de PowerShell:

```powershell
$env:DATABASE_PATH = "C:\datos\catalogo.sqlite"
$env:PORT = "3000"
npm start
```

## SBA-23

- Búsqueda por nombre, presentación, categoría o código; ignora mayúsculas y tildes.
- Sugerencias para el mismo producto cuando coincide la presentación normalizada o la equivalencia en kilos.
- Alta desde el celular solo para productos existentes. La presentación queda activa y marcada con `createdFromMobile`.
- Idempotencia con UUIDv7, hash SHA-256 y clave única por banco/comando. La referencia y el resultado quedan guardados en una transacción SQLite; un reintento idéntico devuelve el resultado anterior y un comando reutilizado con otra carga responde `409`.
- Una clave de referencia provisional UUIDv7 y una estructura de borrador local para preparar el flujo de sincronización; el ID provisional se sustituye por el ID real al responder la API.
- PWA con caché de la aplicación y del catálogo para consulta sin conexión.

La autenticación incluida es local y usa los roles `operario_bodega`, `coordinacion` y `admin_banco` como sustituto de demostración. No es Auth0 ni forma parte de la entrega real de SBA-23 (Auth0 corresponde a SBA-8). Las presentaciones nuevas quedan disponibles de inmediato: no se agregó pantalla de revisión.

## Fuera del alcance de SBA-23

- La cola completa, los reintentos automáticos y la reconciliación de identificadores sin conexión pertenecen a la iteración 3. Mientras no haya conexión, la aplicación conserva un borrador local; no lo envía automáticamente al reconectar.
- La recepción y el registro de cantidades corresponden a SBA-24 y no están implementados aquí.
- La pantalla de revisión de coordinación es un ticket aparte.
- No se implementa Auth0, ni integración con SIGBA, NestJS, Prisma, Postgres o su catálogo real. La base SQLite y los datos de ejemplo son locales y sintéticos.

## API local

- `GET /api/auth/setup` y `POST /api/auth/setup` (configuración única de la primera cuenta administradora).
- `POST /api/auth/login`, `GET /api/auth/session`, `POST /api/auth/logout`.
- `GET /api/admin/users`, `POST /api/admin/users` y `PATCH /api/admin/users/:id` (solo administración).
- `GET /api/products`, `GET /api/search?q=arr`, `GET /api/catalog`.
- `GET /api/references/suggestions?productId=prod-arroz&presentation=500%20g&equivalenceKg=0.5`.
- `POST /api/references/from-mobile`.

Las rutas de catálogo requieren sesión. El alta recibe `commandId`, `productId`, `presentation` y `equivalenceKg`; la API devuelve `201` la primera vez, `200` en un reintento idéntico y `409` si se reutiliza el comando con otra carga o si ya existe una presentación equivalente.

## Pruebas

```powershell
npm test
```

## Uso

Este es un prototipo local para el flujo de creación de presentaciones de SBA-23. Antes de usarlo con datos reales, hace falta integrarlo con la infraestructura y los servicios autorizados de la organización.

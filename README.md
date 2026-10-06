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

## Funciones

- Inicio de sesión local con contraseñas derivadas mediante scrypt, sesiones aleatorias almacenadas como hashes y cookies `HttpOnly`/`SameSite=Strict`. Las mutaciones requieren token CSRF.
- Roles: `operario_bodega` puede consultar y crear; `coordinacion` puede revisar altas; `admin_banco` también puede crear y desactivar cuentas. No se puede desactivar la última cuenta administradora.
- Búsqueda por nombre, presentación, categoría o código; ignora mayúsculas y tildes.
- Alta de presentaciones solo para productos existentes. Compara nombre normalizado o equivalencia en kilos, evita duplicados y deja la presentación disponible de inmediato, marcada para revisión.
- Idempotencia con UUIDv7, hash SHA-256 y clave única por banco/comando; la referencia y el resultado quedan persistidos en una transacción SQLite.
- Panel de coordinación para aprobar o rechazar altas. Rechazar desactiva la presentación; aprobar la conserva activa. Ambas acciones guardan quién revisó, cuándo y una nota opcional.
- Cola local en IndexedDB para altas cuando no hay conexión. Al recuperar la conexión, reintenta el mismo comando para evitar duplicados y reconcilia el identificador provisional con la respuesta del servidor. Las altas no sincronizadas se muestran en el catálogo de ese dispositivo.
- PWA con caché de la aplicación y del catálogo para consultar sin conexión. La cola queda en el navegador; una presentación creada sin señal todavía no está guardada en la base del servidor.
- Las sesiones expiran después de 12 horas. Para sincronizar, vuelve a conectarte e inicia sesión con una cuenta activa.

## API local

- `GET /api/auth/setup` y `POST /api/auth/setup` (configuración única de la primera cuenta administradora).
- `POST /api/auth/login`, `GET /api/auth/session`, `POST /api/auth/logout`.
- `GET /api/admin/users`, `POST /api/admin/users` y `PATCH /api/admin/users/:id` (solo administración).
- `GET /api/products`, `GET /api/search?q=arr`, `GET /api/catalog`.
- `GET /api/references/suggestions?productId=prod-arroz&presentation=500%20g&equivalenceKg=0.5`.
- `POST /api/references/from-mobile`.
- `GET /api/references/review` y `POST /api/references/:id/review` (coordinación o administración).

Las rutas de catálogo requieren sesión. El alta recibe `commandId`, `productId`, `presentation` y `equivalenceKg`; la API devuelve `201` la primera vez, `200` en un reintento idéntico y `409` si se reutiliza el comando con otra carga o si ya existe una presentación equivalente.

## Pruebas

```powershell
npm test
```

## Alcance y uso

Este proyecto adapta el flujo a una instalación local: no implementa NestJS, Prisma, Postgres, Auth0, integración con recepciones, sincronización entre varios dispositivos ni conexión al catálogo real. La autenticación local y los paneles de revisión/cola se añadieron a petición para completar la demostración independiente, aunque aparecen fuera del alcance de SBA-23 en el PDF. Antes de usarlo con datos reales, requiere una revisión de seguridad y operación, HTTPS, copias de seguridad, gestión segura de cuentas y adaptación a la infraestructura de la organización.

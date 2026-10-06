import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createCatalog } from './catalog.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = resolve(root, 'public');
const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 16_384) {
      const error = new Error('La solicitud supera el tamaño permitido.');
      error.status = 413;
      throw error;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('El cuerpo debe ser JSON válido.');
    error.status = 400;
    throw error;
  }
}

function validateCreate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return 'Envía los datos de la presentación.';
  }
  if (typeof input.commandId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.commandId)) {
    return 'commandId debe ser un UUID válido.';
  }
  if (typeof input.productId !== 'string' || !input.productId.trim()) {
    return 'Selecciona un producto existente.';
  }
  if (typeof input.presentation !== 'string' ||
      !input.presentation.trim() || input.presentation.trim().length > 100) {
    return 'La presentación es obligatoria y debe tener máximo 100 caracteres.';
  }
  if (typeof input.equivalenceKg !== 'number' ||
      !Number.isFinite(input.equivalenceKg) || input.equivalenceKg <= 0) {
    return 'La equivalencia en kilos debe ser mayor que cero.';
  }
  return null;
}

export function createApp({ databasePath, bankId = 'banco-local' } = {}) {
  const path = databasePath ?? join(root, '.data', 'catalogo.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  const catalog = createCatalog(database);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');

      if (request.method === 'GET' && url.pathname === '/api/products') {
        return json(response, 200, catalog.listProducts());
      }

      if (request.method === 'GET' && url.pathname === '/api/search') {
        return json(response, 200, catalog.search(url.searchParams.get('q') ?? ''));
      }

      if (request.method === 'GET' && url.pathname === '/api/references/suggestions') {
        const productId = url.searchParams.get('productId') ?? '';
        const presentation = url.searchParams.get('presentation') ?? '';
        const equivalenceKg = Number(url.searchParams.get('equivalenceKg'));
        if (!productId || !presentation.trim() || !Number.isFinite(equivalenceKg) || equivalenceKg <= 0) {
          return json(response, 400, { message: 'Producto, presentación y equivalencia son obligatorios.' });
        }
        return json(response, 200, catalog.suggestions({ productId, presentation, equivalenceKg }));
      }

      if (request.method === 'GET' && url.pathname === '/api/catalog') {
        const body = catalog.search('');
        const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('hex')}"`;
        if (request.headers['if-none-match'] === etag) {
          response.writeHead(304, { ETag: etag });
          return response.end();
        }
        return json(response, 200, body, { ETag: etag, 'Cache-Control': 'no-cache' });
      }

      if (request.method === 'POST' && url.pathname === '/api/references/from-mobile') {
        const input = await readBody(request);
        const invalid = validateCreate(input);
        if (invalid) return json(response, 400, { message: invalid });
        const result = catalog.createFromMobile(input, bankId);
        return json(response, result.status, result.body, {
          ...(result.replay ? { 'Idempotent-Replay': 'true' } : {}),
        });
      }

      if (request.method !== 'GET') {
        return json(response, 404, { message: 'Ruta no encontrada.' });
      }

      const requested = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = resolve(publicRoot, `.${requested}`);
      if (file !== publicRoot && !file.startsWith(`${publicRoot}${sep}`)) {
        return json(response, 403, { message: 'Ruta no permitida.' });
      }
      const { readFile } = await import('node:fs/promises');
      let content;
      try {
        content = await readFile(file);
      } catch (error) {
        if (error.code === 'ENOENT') return json(response, 404, { message: 'Página no encontrada.' });
        throw error;
      }
      response.writeHead(200, {
        'Content-Type': types[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(content);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const status = error.status ?? 500;
      json(response, status, {
        message: status === 500 ? 'No se pudo completar la solicitud.' : error.message,
      });
    }
  });

  return {
    server,
    close() {
      database.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp({ bankId: process.env.BANK_ID ?? 'banco-local' });
  const port = Number(process.env.PORT ?? 3000);
  app.server.listen(port, () => {
    console.log(`Catálogo disponible en http://localhost:${port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      app.server.close(() => {
        app.close();
        process.exit(0);
      });
    });
  }
}

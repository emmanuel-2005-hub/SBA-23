import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';

const initialAccount = {
  name: 'Administración',
  email: 'admin@example.test',
  password: 'Admin-local-2026!',
};
let baseUrl;

describe('catálogo independiente', () => {
  let folder;
  let app;
  let admin;
  let operator;
  let coordinator;

  beforeEach(async () => {
    folder = mkdtempSync(join(tmpdir(), 'catalogo-test-'));
    app = createApp({ databasePath: join(folder, 'test.sqlite'), bankId: 'banco-test' });
    await listen(app);
    baseUrl = `http://127.0.0.1:${app.server.address().port}`;

    const setup = await fetch(`${baseUrl}/api/auth/setup`, jsonOptions('POST', initialAccount));
    assert.equal(setup.status, 201);
    admin = await clientFromResponse(setup);
    operator = await addAccount(baseUrl, admin, {
      name: 'Operario',
      email: 'operario@example.test',
      password: 'Operario-local-2026!',
      role: 'operario_bodega',
    });
    coordinator = await addAccount(baseUrl, admin, {
      name: 'Coordinación',
      email: 'coordinacion@example.test',
      password: 'Coordinacion-local-2026!',
      role: 'coordinacion',
    });
  });

  afterEach(async () => {
    if (app.server.listening) {
      await new Promise((resolve, reject) =>
        app.server.close((error) => error ? reject(error) : resolve()));
    }
    app.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it('requiere autenticación para consultar el catálogo', async () => {
    const anonymous = await fetch(`${baseUrl}/api/search?q=arr`);
    const search = await request(operator, '/api/search?q=arr');
    assert.equal(anonymous.status, 401);
    assert.equal(search.status, 200);
    assert.deepEqual((await search.json()).map((item) => item.presentation), ['500 g', '1 kg', 'Arroba']);
  });

  it('busca por fragmento de nombre y código sin distinguir mayúsculas ni tildes', async () => {
    const byName = await request(operator, '/api/search?q=arr');
    const byAccent = await request(operator, '/api/search?q=arroz');
    const byCode = await request(operator, '/api/search?q=cat-01');
    assert.equal((await byName.json()).length, 3);
    assert.equal((await byAccent.json()).length, 3);
    assert.equal((await byCode.json()).length, 3);
  });

  it('sugiere una presentación que ya tiene la misma equivalencia', async () => {
    const params = new URLSearchParams({
      productId: 'prod-arroz',
      presentation: 'medio kilo',
      equivalenceKg: '0.5',
    });
    const response = await request(operator, `/api/references/suggestions?${params}`);
    assert.deepEqual((await response.json()).map((item) => item.presentation), ['500 g']);
  });

  it('crea una presentación disponible y marcada para revisión', async () => {
    const response = await createReference(operator, '0.48', 'paquete de 480 g');
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.createdFromMobile, true);
    assert.equal(body.active, true);
    assert.equal(body.reviewStatus, 'pending');
    const search = await request(operator, '/api/search?q=480');
    assert.equal((await search.json()).length, 1);
    const pending = await request(coordinator, '/api/references/review');
    assert.equal((await pending.json()).length, 1);
  });

  it('devuelve el mismo resultado al reintentar el mismo comando', async () => {
    const payload = createPayload('0.48', 'paquete 480 g');
    const first = await sendCommand(operator, payload);
    const firstBody = await first.json();
    const second = await sendCommand(operator, payload);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('Idempotent-Replay'), 'true');
    assert.equal((await second.json()).id, firstBody.id);
  });

  it('serializa dos altas simultáneas con el mismo comando en una sola referencia', async () => {
    const payload = createPayload('0.48', 'paquete 480 g');
    const [first, second] = await Promise.all([
      sendCommand(operator, payload),
      sendCommand(operator, payload),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 201]);
    const results = await request(operator, '/api/search?q=480');
    assert.equal((await results.json()).length, 1);
  });

  it('normaliza mayúsculas y tildes al comparar reintentos', async () => {
    const payload = createPayload('0.48', 'paquete cafe 480 g');
    const first = await sendCommand(operator, payload);
    const firstBody = await first.json();
    const retry = await sendCommand(operator, { ...payload, presentation: 'Paquete café 480 G' });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).id, firstBody.id);
  });

  it('rechaza el mismo comando con una carga diferente', async () => {
    const payload = createPayload('0.48', 'paquete 480 g');
    await sendCommand(operator, payload);
    const retry = await sendCommand(operator, { ...payload, equivalenceKg: 0.49 });
    assert.equal(retry.status, 409);
  });

  it('rechaza una presentación equivalente creada con otro comando', async () => {
    await sendCommand(operator, createPayload('0.48', 'paquete 480 g'));
    const duplicate = await sendCommand(operator, createPayload('0.48', 'otra forma 480 g'));
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).reference.presentation, 'paquete 480 g');
  });

  it('responde 304 si el catálogo conserva el mismo ETag', async () => {
    const first = await request(operator, '/api/catalog');
    const etag = first.headers.get('ETag');
    const second = await request(operator, '/api/catalog', { headers: { 'If-None-Match': etag } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 304);
  });

  it('solo permite que coordinación y administración revisen altas', async () => {
    const created = await createReference(operator, '0.48', 'paquete 480 g');
    const reference = await created.json();
    const forbidden = await request(operator, '/api/references/review');
    assert.equal(forbidden.status, 403);

    const denied = await post(operator, `/api/references/${reference.id}/review`, {
      decision: 'approve',
    });
    assert.equal(denied.status, 403);

    const approved = await post(coordinator, `/api/references/${reference.id}/review`, {
      decision: 'approve',
      note: 'Presentación verificada.',
    });
    assert.deepEqual(await approved.json(), {
      id: reference.id,
      decision: 'approve',
      active: true,
    });
    const pending = await request(coordinator, '/api/references/review');
    assert.deepEqual(await pending.json(), []);
  });

  it('desactiva una presentación rechazada', async () => {
    const created = await createReference(operator, '0.48', 'paquete 480 g');
    const reference = await created.json();
    const rejected = await post(admin, `/api/references/${reference.id}/review`, {
      decision: 'reject',
      note: 'No corresponde al producto.',
    });
    assert.equal(rejected.status, 200);
    assert.equal((await rejected.json()).active, false);
    const search = await request(operator, '/api/search?q=480');
    assert.deepEqual(await search.json(), []);
  });

  it('solo administración puede crear y listar cuentas', async () => {
    const forbidden = await post(coordinator, '/api/admin/users', {
      name: 'Otra persona',
      email: 'otra@example.test',
      password: 'Otra-persona-2026!',
      role: 'operario_bodega',
    });
    assert.equal(forbidden.status, 403);
    const created = await post(admin, '/api/admin/users', {
      name: 'Nueva persona',
      email: 'nueva@example.test',
      password: 'Nueva-persona-2026!',
      role: 'operario_bodega',
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).role, 'operario_bodega');
    const list = await request(admin, '/api/admin/users');
    assert.equal((await list.json()).length, 4);
  });

  it('permite desactivar cuentas y revoca sus sesiones', async () => {
    const deactivated = await patch(admin, `/api/admin/users/${operator.user.id}`, { active: false });
    assert.equal(deactivated.status, 200);
    const rejectedSession = await request(operator, '/api/search?q=arr');
    assert.equal(rejectedSession.status, 401);

    const reactivated = await patch(admin, `/api/admin/users/${operator.user.id}`, { active: true });
    assert.equal(reactivated.status, 200);
    const login = await fetch(`${baseUrl}/api/auth/login`, jsonOptions('POST', {
      email: 'operario@example.test',
      password: 'Operario-local-2026!',
    }));
    assert.equal(login.status, 200);
  });

  it('impide desactivar la última cuenta administradora', async () => {
    const response = await patch(admin, `/api/admin/users/${admin.user.id}`, { active: false });
    assert.equal(response.status, 409);
  });

  it('rechaza contraseñas incorrectas y revoca la sesión al cerrar', async () => {
    const invalid = await fetch(`${baseUrl}/api/auth/login`, jsonOptions('POST', {
      email: initialAccount.email,
      password: 'incorrecta y muy larga',
    }));
    assert.equal(invalid.status, 401);

    const response = await post(admin, '/api/auth/logout', {});
    assert.equal(response.status, 200);
    const next = await request(admin, '/api/auth/session');
    assert.equal(next.status, 401);
  });

  it('limita los intentos fallidos de inicio de sesión', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await fetch(`${baseUrl}/api/auth/login`, jsonOptions('POST', {
        email: 'inexistente@example.test',
        password: 'contraseña incorrecta',
      }));
      assert.equal(response.status, 401);
    }
    const limited = await fetch(`${baseUrl}/api/auth/login`, jsonOptions('POST', {
      email: 'inexistente@example.test',
      password: 'contraseña incorrecta',
    }));
    assert.equal(limited.status, 429);
  });

  it('exige CSRF para mutaciones autenticadas', async () => {
    const response = await fetch(`${baseUrl}/api/references/from-mobile`, {
      ...jsonOptions('POST', createPayload('0.48', 'paquete 480 g')),
      headers: { Cookie: operator.cookie },
    });
    assert.equal(response.status, 403);
  });

  it('solo permite configurar la primera cuenta una vez', async () => {
    const second = await fetch(`${baseUrl}/api/auth/setup`, jsonOptions('POST', {
      ...initialAccount,
      email: 'second@example.test',
    }));
    assert.equal(second.status, 409);
  });
});

async function listen(app) {
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
}

async function clientFromResponse(response) {
  const body = await response.json();
  return {
    user: body.user,
    csrfToken: body.csrfToken,
    cookie: response.headers.get('set-cookie').split(';')[0],
  };
}

async function addAccount(baseUrl, admin, account) {
  const created = await post(admin, '/api/admin/users', account);
  assert.equal(created.status, 201);
  const login = await fetch(`${baseUrl}/api/auth/login`, jsonOptions('POST', {
    email: account.email,
    password: account.password,
  }));
  assert.equal(login.status, 200);
  return clientFromResponse(login);
}

function jsonOptions(method, body) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function request(client, path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Cookie: client.cookie,
      ...(options.headers ?? {}),
    },
  });
}

function post(client, path, body) {
  return request(client, path, {
    ...jsonOptions('POST', body),
    headers: {
      'Content-Type': 'application/json',
      Cookie: client.cookie,
      'X-CSRF-Token': client.csrfToken,
    },
  });
}

function patch(client, path, body) {
  return request(client, path, {
    ...jsonOptions('PATCH', body),
    headers: {
      'Content-Type': 'application/json',
      Cookie: client.cookie,
      'X-CSRF-Token': client.csrfToken,
    },
  });
}

function createPayload(equivalenceKg, presentation) {
  return {
    commandId: crypto.randomUUID(),
    productId: 'prod-arroz',
    presentation,
    equivalenceKg: Number(equivalenceKg),
  };
}

function createReference(client, equivalenceKg, presentation) {
  return sendCommand(client, createPayload(equivalenceKg, presentation));
}

function sendCommand(client, payload) {
  return post(client, '/api/references/from-mobile', payload);
}

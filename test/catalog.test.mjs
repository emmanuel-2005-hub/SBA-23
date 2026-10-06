import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';

describe('catálogo móvil', () => {
  let folder;
  let app;
  let baseUrl;

  beforeEach(async () => {
    folder = mkdtempSync(join(tmpdir(), 'catalogo-test-'));
    app = createApp({ databasePath: join(folder, 'test.sqlite'), bankId: 'banco-test' });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    app.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it('busca por fragmento de nombre y código sin distinguir mayúsculas ni tildes', async () => {
    const byName = await fetch(`${baseUrl}/api/search?q=arr`);
    const byCode = await fetch(`${baseUrl}/api/search?q=cat-01`);
    assert.equal(byName.status, 200);
    assert.deepEqual((await byName.json()).map((item) => item.presentation), ['500 g', '1 kg', 'Arroba']);
    assert.equal((await byCode.json()).length, 3);
  });

  it('sugiere una presentación que ya tiene la misma equivalencia', async () => {
    const params = new URLSearchParams({
      productId: 'prod-arroz',
      presentation: 'medio kilo',
      equivalenceKg: '0.5',
    });
    const response = await fetch(`${baseUrl}/api/references/suggestions?${params}`);
    assert.deepEqual((await response.json()).map((item) => item.presentation), ['500 g']);
  });

  it('crea la presentación desde el celular marcada para revisión', async () => {
    const response = await createReference(baseUrl, '0.48', 'paquete de 480 g');
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.createdFromMobile, true);
    assert.equal(body.active, true);
    const search = await fetch(`${baseUrl}/api/search?q=480`);
    assert.equal((await search.json()).length, 1);
  });

  it('devuelve el mismo resultado al reintentar el mismo comando', async () => {
    const payload = createPayload('0.48', 'paquete 480 g');
    const first = await sendCommand(baseUrl, payload);
    const firstBody = await first.json();
    const second = await sendCommand(baseUrl, payload);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('Idempotent-Replay'), 'true');
    assert.equal((await second.json()).id, firstBody.id);
  });

  it('normaliza mayúsculas y tildes al comparar reintentos', async () => {
    const payload = createPayload('0.48', 'paquete cafe 480 g');
    const first = await sendCommand(baseUrl, payload);
    const firstBody = await first.json();
    const retry = await sendCommand(baseUrl, { ...payload, presentation: 'Paquete café 480 G' });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).id, firstBody.id);
  });

  it('rechaza el mismo comando con una carga diferente', async () => {
    const payload = createPayload('0.48', 'paquete 480 g');
    await sendCommand(baseUrl, payload);
    const retry = await sendCommand(baseUrl, { ...payload, equivalenceKg: 0.49 });
    assert.equal(retry.status, 409);
  });

  it('rechaza una presentación equivalente creada con otro comando', async () => {
    await sendCommand(baseUrl, createPayload('0.48', 'paquete 480 g'));
    const duplicate = await sendCommand(baseUrl, createPayload('0.48', 'otra forma 480 g'));
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).reference.presentation, 'paquete 480 g');
  });

  it('responde 304 si el catálogo conserva el mismo ETag', async () => {
    const first = await fetch(`${baseUrl}/api/catalog`);
    const etag = first.headers.get('ETag');
    const second = await fetch(`${baseUrl}/api/catalog`, { headers: { 'If-None-Match': etag } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 304);
  });
});

function createPayload(equivalenceKg, presentation) {
  return {
    commandId: crypto.randomUUID(),
    productId: 'prod-arroz',
    presentation,
    equivalenceKg: Number(equivalenceKg),
  };
}

function createReference(baseUrl, equivalenceKg, presentation) {
  return sendCommand(baseUrl, createPayload(equivalenceKg, presentation));
}

function sendCommand(baseUrl, payload) {
  return fetch(`${baseUrl}/api/references/from-mobile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

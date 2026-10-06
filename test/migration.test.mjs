import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCatalog, normalizeText } from '../src/catalog.mjs';

describe('migración de idempotencia al catálogo', () => {
  let folder;
  let database;

  afterEach(() => {
    if (database) database.close();
    database = null;
    if (folder) rmSync(folder, { recursive: true, force: true });
    folder = null;
  });

  it('mueve comandos existentes a sus referencias y conserva el resultado de reintento', () => {
    folder = mkdtempSync(join(tmpdir(), 'catalogo-migration-'));
    database = new DatabaseSync(join(folder, 'legacy.sqlite'));
    database.exec(`
      CREATE TABLE categories (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, bank_code TEXT NOT NULL
      );
      CREATE TABLE products (
        id TEXT PRIMARY KEY, category_id TEXT NOT NULL REFERENCES categories(id),
        name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE
      );
      CREATE TABLE references_catalog (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id),
        presentation TEXT NOT NULL,
        presentation_key TEXT NOT NULL,
        equivalence_kg REAL NOT NULL CHECK (equivalence_kg > 0),
        created_from_mobile INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        UNIQUE (product_id, presentation_key)
      );
      CREATE TABLE mobile_commands (
        bank_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        PRIMARY KEY (bank_id, command_id)
      );
      INSERT INTO categories VALUES ('cat-granos', 'Granos', 'granos', 'CAT-01');
      INSERT INTO products VALUES ('prod-arroz', 'cat-granos', 'Arroz', 'arroz');
    `);

    const input = {
      commandId: '018f47a0-7b5c-7cc4-98b4-123456789abc',
      productId: 'prod-arroz',
      presentation: 'Paquete café 480 g',
      equivalenceKg: 0.48,
    };
    const reference = {
      id: 'ref-legacy',
      productId: input.productId,
      presentation: input.presentation,
      equivalenceKg: input.equivalenceKg,
      createdFromMobile: true,
      active: true,
      createdAt: '2026-10-01T00:00:00.000Z',
    };
    const payload = JSON.stringify({
      productId: input.productId,
      presentation: normalizeText(input.presentation),
      equivalenceKg: input.equivalenceKg,
    });
    const payloadHash = createHash('sha256').update(payload).digest('hex');
    database.prepare(`
      INSERT INTO references_catalog
        (id, product_id, presentation, presentation_key, equivalence_kg,
          created_from_mobile, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(
      reference.id,
      reference.productId,
      reference.presentation,
      normalizeText(reference.presentation),
      reference.equivalenceKg,
      reference.createdAt,
    );
    database.prepare(`
      INSERT INTO mobile_commands (bank_id, command_id, payload_hash, response_json)
      VALUES (?, ?, ?, ?)
    `).run('banco-local', input.commandId, payloadHash, JSON.stringify(reference));

    const catalog = createCatalog(database);
    const replay = catalog.createFromMobile(input, 'banco-local', 'user-id');
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, reference);
    assert.equal(database.prepare(`
      SELECT command_id FROM references_catalog WHERE id = ?
    `).get(reference.id).command_id, input.commandId);
    assert.equal(database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mobile_commands'
    `).get(), undefined);
  });
});

import { createHash } from 'node:crypto';

export function normalizeText(value) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export function createCatalog(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE,
      bank_code TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL REFERENCES categories(id),
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS references_catalog (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      bank_id TEXT,
      command_id TEXT,
      payload_hash TEXT,
      command_response_json TEXT,
      presentation TEXT NOT NULL,
      presentation_key TEXT NOT NULL,
      equivalence_kg REAL NOT NULL CHECK (equivalence_kg > 0),
      created_from_mobile INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE (product_id, presentation_key)
    );

    CREATE INDEX IF NOT EXISTS references_product_active
      ON references_catalog(product_id, active);
    CREATE INDEX IF NOT EXISTS references_equivalence
      ON references_catalog(product_id, equivalence_kg);

  `);

  const referenceColumns = new Set(
    database.prepare('PRAGMA table_info(references_catalog)').all().map((column) => column.name),
  );
  for (const [name, declaration] of [
    ['bank_id', 'TEXT'],
    ['command_id', 'TEXT'],
    ['payload_hash', 'TEXT'],
    ['command_response_json', 'TEXT'],
  ]) {
    if (!referenceColumns.has(name)) {
      database.exec(`ALTER TABLE references_catalog ADD COLUMN ${name} ${declaration}`);
    }
  }

  const legacyCommands = database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mobile_commands'
  `).get();
  if (legacyCommands) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const commands = database.prepare(`
        SELECT bank_id AS bankId, command_id AS commandId,
          payload_hash AS payloadHash, response_json AS responseJson
        FROM mobile_commands
      `).all();
      const migrateCommand = database.prepare(`
        UPDATE references_catalog
        SET bank_id = ?, command_id = ?, payload_hash = ?, command_response_json = ?
        WHERE id = ?
      `);
      for (const command of commands) {
        const response = JSON.parse(command.responseJson);
        const migrated = migrateCommand.run(
          command.bankId,
          command.commandId,
          command.payloadHash,
          command.responseJson,
          response.id,
        );
        if (migrated.changes !== 1) {
          throw new Error(`No se pudo migrar el comando ${command.commandId}.`);
        }
      }
      database.exec('DROP TABLE mobile_commands');
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS references_command_key
      ON references_catalog(bank_id, command_id) WHERE command_id IS NOT NULL;
  `);

  const count = database.prepare('SELECT COUNT(*) AS count FROM categories').get().count;
  if (count === 0) {
    const addCategory = database.prepare(
      'INSERT INTO categories (id, name, name_key, bank_code) VALUES (?, ?, ?, ?)',
    );
    const addProduct = database.prepare(
      'INSERT INTO products (id, category_id, name, name_key) VALUES (?, ?, ?, ?)',
    );
    const addReference = database.prepare(`
      INSERT INTO references_catalog
        (id, product_id, presentation, presentation_key, equivalence_kg, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();

    database.exec('BEGIN');
    try {
      addCategory.run('cat-granos', 'Granos', normalizeText('Granos'), 'CAT-01');
      addCategory.run('cat-legumbres', 'Legumbres', normalizeText('Legumbres'), 'CAT-02');
      addProduct.run('prod-arroz', 'cat-granos', 'Arroz', normalizeText('Arroz'));
      addProduct.run('prod-frijol', 'cat-legumbres', 'Frijol', normalizeText('Frijol'));
      addReference.run('ref-arroz-500g', 'prod-arroz', '500 g', normalizeText('500 g'), 0.5, now);
      addReference.run('ref-arroz-1kg', 'prod-arroz', '1 kg', normalizeText('1 kg'), 1, now);
      addReference.run('ref-arroz-arroba', 'prod-arroz', 'Arroba', normalizeText('Arroba'), 12.5, now);
      addReference.run('ref-frijol-1kg', 'prod-frijol', '1 kg', normalizeText('1 kg'), 1, now);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    listProducts() {
      return database.prepare(`
        SELECT p.id, p.name, c.name AS category, c.bank_code AS bankCode
        FROM products p
        JOIN categories c ON c.id = p.category_id
        ORDER BY p.name_key
      `).all();
    },

    search(query = '') {
      const key = normalizeText(query);
      const rows = database.prepare(`
        SELECT r.id, r.product_id AS productId, p.name AS product,
          r.presentation, r.equivalence_kg AS equivalenceKg,
          r.created_from_mobile AS createdFromMobile, r.active,
          c.name AS category, c.bank_code AS bankCode
        FROM references_catalog r
        JOIN products p ON p.id = r.product_id
        JOIN categories c ON c.id = p.category_id
        WHERE r.active = 1
          AND (? = '' OR p.name_key LIKE ? OR r.presentation_key LIKE ?
            OR c.name_key LIKE ? OR lower(c.bank_code) LIKE ?)
        ORDER BY p.name_key, r.equivalence_kg, r.presentation_key
      `).all(key, `%${key}%`, `%${key}%`, `%${key}%`, `%${key}%`);
      return rows.map((row) => ({
        ...row,
        createdFromMobile: Boolean(row.createdFromMobile),
        active: Boolean(row.active),
      }));
    },

    suggestions({ productId, presentation, equivalenceKg }) {
      const presentationKey = normalizeText(presentation);
      const rows = database.prepare(`
        SELECT id, presentation, equivalence_kg AS equivalenceKg
        FROM references_catalog
        WHERE product_id = ? AND active = 1
          AND (presentation_key = ? OR equivalence_kg = ?)
        ORDER BY presentation_key
      `).all(productId, presentationKey, equivalenceKg);
      return rows.map((row) => ({
        id: row.id,
        presentation: row.presentation,
        equivalenceKg: row.equivalenceKg,
      }));
    },

    createFromMobile(input, bankId) {
      const presentation = input.presentation.trim();
      const payload = JSON.stringify({
        productId: input.productId,
        presentation: normalizeText(presentation),
        equivalenceKg: input.equivalenceKg,
      });
      const payloadHash = createHash('sha256').update(payload).digest('hex');

      database.exec('BEGIN IMMEDIATE');
      try {
        const previous = database.prepare(`
          SELECT payload_hash AS payloadHash, command_response_json AS responseJson
          FROM references_catalog WHERE bank_id = ? AND command_id = ?
        `).get(bankId, input.commandId);

        if (previous) {
          if (previous.payloadHash !== payloadHash) {
            database.exec('ROLLBACK');
            return { status: 409, body: { message: 'El comando ya se usó con otros datos.' } };
          }
          database.exec('COMMIT');
          return {
            status: 200,
            body: JSON.parse(previous.responseJson),
            replay: true,
          };
        }

        const product = database.prepare('SELECT id FROM products WHERE id = ?').get(input.productId);
        if (!product) {
          database.exec('ROLLBACK');
          return { status: 404, body: { message: 'El producto no existe.' } };
        }

        const existing = database.prepare(`
          SELECT id, presentation, equivalence_kg AS equivalenceKg
          FROM references_catalog
          WHERE product_id = ? AND active = 1
            AND (presentation_key = ? OR equivalence_kg = ?)
          LIMIT 1
        `).get(input.productId, normalizeText(presentation), input.equivalenceKg);

        if (existing) {
          database.exec('ROLLBACK');
          return {
            status: 409,
            body: {
              message: 'El producto ya tiene una presentación equivalente.',
              reference: existing,
            },
          };
        }

        const reference = {
          id: crypto.randomUUID(),
          productId: input.productId,
          presentation,
          equivalenceKg: input.equivalenceKg,
          createdFromMobile: true,
          active: true,
          createdAt: new Date().toISOString(),
        };
        database.prepare(`
          INSERT INTO references_catalog
            (id, product_id, bank_id, command_id, payload_hash, command_response_json,
              presentation, presentation_key, equivalence_kg, created_from_mobile, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(
          reference.id,
          reference.productId,
          bankId,
          input.commandId,
          payloadHash,
          JSON.stringify(reference),
          reference.presentation,
          normalizeText(reference.presentation),
          reference.equivalenceKg,
          reference.createdAt,
        );
        database.exec('COMMIT');
        return { status: 201, body: reference };
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

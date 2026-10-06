import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const PASSWORD_LENGTH = 64;
const PASSWORD_ROLES = new Set(['operario_bodega', 'coordinacion', 'admin_banco']);
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
const DUMMY_SALT = Buffer.from('catalogo-local-login-salt');
const DUMMY_PASSWORD_HASH = scryptSync('not-a-real-account-password', DUMMY_SALT, PASSWORD_LENGTH);

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}

function validateUserInput(input, { creatingFirstAdmin = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return 'Envía los datos de la cuenta.';
  }
  if (typeof input.email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()) ||
      input.email.trim().length > 254) {
    return 'Escribe un correo electrónico válido.';
  }
  if (typeof input.name !== 'string' ||
      input.name.trim().length < 2 || input.name.trim().length > 100) {
    return 'El nombre debe tener entre 2 y 100 caracteres.';
  }
  if (typeof input.password !== 'string' ||
      input.password.length < 12 || input.password.length > 128) {
    return 'La contraseña debe tener entre 12 y 128 caracteres.';
  }
  if (!creatingFirstAdmin && !PASSWORD_ROLES.has(input.role)) {
    return 'Selecciona un rol válido.';
  }
  return null;
}

function normalizedEmail(email) {
  return email.trim().toLowerCase();
}

function createPasswordRecord(password) {
  const salt = randomBytes(16);
  return {
    salt: salt.toString('hex'),
    passwordHash: scryptSync(password, salt, PASSWORD_LENGTH).toString('hex'),
  };
}

function passwordMatches(password, saltHex, expectedHex) {
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), PASSWORD_LENGTH);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createSession(database, userId) {
  const token = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  database.prepare(`
    INSERT INTO sessions (token_hash, user_id, csrf_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(hash(token), userId, hash(csrfToken), expiresAt, new Date().toISOString());
  return { token, csrfToken, expiresAt };
}

export function createAuth(database, { secureCookies = false } = {}) {
  const loginAttempts = new Map();

  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('operario_bodega', 'coordinacion', 'admin_banco')),
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  `);

  const cookieOptions = [
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_DURATION_MS / 1000}`,
    ...(secureCookies ? ['Secure'] : []),
  ].join('; ');

  function cookieToken(request) {
    const cookie = request.headers.cookie ?? '';
    const entry = cookie.split(';').map((part) => part.trim())
      .find((part) => part.startsWith('catalog_session='));
    return entry?.slice('catalog_session='.length) ?? null;
  }

  function authenticate(request) {
    const token = cookieToken(request);
    if (!token || !/^[0-9a-f]{64}$/i.test(token)) return null;
    const user = database.prepare(`
      SELECT u.id, u.email, u.name, u.role, u.active,
        s.token_hash AS tokenHash, s.csrf_hash AS csrfHash,
        s.expires_at AS expiresAt
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `).get(hash(token));
    if (!user || !user.active || Date.parse(user.expiresAt) <= Date.now()) {
      if (user) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(user.tokenHash);
      return null;
    }
    return { ...user, publicUser: publicUser(user) };
  }

  function requireCsrf(session, request) {
    const provided = request.headers['x-csrf-token'];
    if (typeof provided !== 'string' || !/^[0-9a-f]{64}$/i.test(provided) ||
        !timingSafeEqual(Buffer.from(hash(provided), 'hex'), Buffer.from(session.csrfHash, 'hex'))) {
      const error = new Error('La sesión cambió o expiró. Recarga la página e inténtalo de nuevo.');
      error.status = 403;
      throw error;
    }
  }

  function login(input) {
    const email = typeof input?.email === 'string' ? normalizedEmail(input.email) : '';
    const now = Date.now();
    const attempts = loginAttempts.get(email);
    if (attempts && attempts.resetAt <= now) loginAttempts.delete(email);
    const activeAttempts = loginAttempts.get(email);
    if (activeAttempts?.count >= MAX_LOGIN_ATTEMPTS) {
      const error = new Error('Demasiados intentos. Espera 15 minutos antes de volver a intentar.');
      error.status = 429;
      throw error;
    }
    const user = database.prepare(`
      SELECT id, email, name, role, password_salt AS passwordSalt,
        password_hash AS passwordHash, active
      FROM users WHERE email = ?
    `).get(email);
    const candidate = typeof input?.password === 'string' ? input.password : '';
    const matches = user
      ? passwordMatches(candidate, user.passwordSalt, user.passwordHash)
      : timingSafeEqual(
        scryptSync(candidate, DUMMY_SALT, PASSWORD_LENGTH),
        DUMMY_PASSWORD_HASH,
      );
    const valid = Boolean(user && user.active && matches);
    if (!valid) {
      const current = loginAttempts.get(email);
      loginAttempts.set(email, {
        count: (current?.count ?? 0) + 1,
        resetAt: current?.resetAt ?? now + LOGIN_WINDOW_MS,
      });
      if (loginAttempts.size > 10_000) {
        for (const [key, attempt] of loginAttempts) {
          if (attempt.resetAt <= now) loginAttempts.delete(key);
        }
        if (loginAttempts.size > 10_000) {
          loginAttempts.delete(loginAttempts.keys().next().value);
        }
      }
      const error = new Error('Correo o contraseña incorrectos.');
      error.status = 401;
      throw error;
    }
    loginAttempts.delete(email);
    return { user: publicUser(user), session: createSession(database, user.id) };
  }

  function setupFirstAdmin(input) {
    const invalid = validateUserInput(input, { creatingFirstAdmin: true });
    if (invalid) {
      const error = new Error(invalid);
      error.status = 400;
      throw error;
    }
    const email = normalizedEmail(input.email);
    const name = input.name.trim();
    const password = createPasswordRecord(input.password);
    const user = { id: crypto.randomUUID(), email, name, role: 'admin_banco' };

    database.exec('BEGIN IMMEDIATE');
    try {
      const count = database.prepare('SELECT COUNT(*) AS count FROM users').get().count;
      if (count !== 0) {
        database.exec('ROLLBACK');
        const error = new Error('La configuración inicial ya se completó. Inicia sesión.');
        error.status = 409;
        throw error;
      }
      database.prepare(`
        INSERT INTO users (id, email, name, role, password_salt, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        user.id,
        user.email,
        user.name,
        user.role,
        password.salt,
        password.passwordHash,
        new Date().toISOString(),
      );
      const session = createSession(database, user.id);
      database.exec('COMMIT');
      return { user, session };
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    }
  }

  function createUser(input) {
    const invalid = validateUserInput(input);
    if (invalid) {
      const error = new Error(invalid);
      error.status = 400;
      throw error;
    }
    const password = createPasswordRecord(input.password);
    const user = {
      id: crypto.randomUUID(),
      email: normalizedEmail(input.email),
      name: input.name.trim(),
      role: input.role,
    };
    try {
      database.prepare(`
        INSERT INTO users (id, email, name, role, password_salt, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        user.id,
        user.email,
        user.name,
        user.role,
        password.salt,
        password.passwordHash,
        new Date().toISOString(),
      );
    } catch (error) {
      if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') {
        const conflict = new Error('Ya existe una cuenta con ese correo.');
        conflict.status = 409;
        throw conflict;
      }
      throw error;
    }
    return publicUser(user);
  }

  function setUserActive({ userId, active, actorId }) {
    if (typeof active !== 'boolean') {
      const error = new Error('Indica si la cuenta debe estar activa.');
      error.status = 400;
      throw error;
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      const user = database.prepare(`
        SELECT id, role, active FROM users WHERE id = ?
      `).get(userId);
      if (!user) {
        const error = new Error('La cuenta no existe.');
        error.status = 404;
        throw error;
      }
      if (!active && userId === actorId) {
        const error = new Error('No puedes desactivar tu propia cuenta.');
        error.status = 409;
        throw error;
      }
      if (!active && user.role === 'admin_banco') {
        const activeAdmins = database.prepare(`
          SELECT COUNT(*) AS count FROM users
          WHERE role = 'admin_banco' AND active = 1
        `).get().count;
        if (activeAdmins <= 1) {
          const error = new Error('Debe permanecer al menos una cuenta administradora activa.');
          error.status = 409;
          throw error;
        }
      }
      database.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, userId);
      if (!active) database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      database.exec('COMMIT');
      return { id: userId, active };
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    setupNeeded() {
      return database.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0;
    },
    authenticate,
    requireCsrf,
    login,
    setupFirstAdmin,
    createUser,
    setUserActive,
    listUsers() {
      return database.prepare(`
        SELECT id, email, name, role, active
        FROM users ORDER BY email
      `).all().map((user) => ({ ...publicUser(user), active: Boolean(user.active) }));
    },
    rotateCsrf(session) {
      const csrfToken = randomBytes(32).toString('hex');
      database.prepare('UPDATE sessions SET csrf_hash = ? WHERE token_hash = ?')
        .run(hash(csrfToken), session.tokenHash);
      return csrfToken;
    },
    revoke(session) {
      database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.tokenHash);
    },
    cookie(token) {
      return `catalog_session=${token}; ${cookieOptions}`;
    },
    clearCookie() {
      return `catalog_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookies ? '; Secure' : ''}`;
    },
  };
}

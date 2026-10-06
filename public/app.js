const elements = {
  authPanel: document.querySelector('#auth-panel'),
  authHelp: document.querySelector('#auth-help'),
  authMessage: document.querySelector('#auth-message'),
  setupForm: document.querySelector('#setup-form'),
  loginForm: document.querySelector('#login-form'),
  workspace: document.querySelector('#workspace'),
  identity: document.querySelector('#identity'),
  logout: document.querySelector('#logout-button'),
  connection: document.querySelector('#connection'),
  offlineNotice: document.querySelector('#offline-notice'),
  search: document.querySelector('#search'),
  searchStatus: document.querySelector('#search-status'),
  results: document.querySelector('#results'),
  products: document.querySelector('#product'),
  presentation: document.querySelector('#presentation'),
  equivalence: document.querySelector('#equivalence'),
  suggestions: document.querySelector('#suggestions'),
  message: document.querySelector('#message'),
  createForm: document.querySelector('#create-form'),
  createButton: document.querySelector('#create-button'),
  queuePanel: document.querySelector('#queue-panel'),
  queueList: document.querySelector('#queue-list'),
  reviewPanel: document.querySelector('#review-panel'),
  reviewList: document.querySelector('#review-list'),
  usersPanel: document.querySelector('#users-panel'),
  userForm: document.querySelector('#user-form'),
  userMessage: document.querySelector('#user-message'),
  userList: document.querySelector('#user-list'),
};

const databaseName = 'catalogo-celular-offline';
const databaseVersion = 1;
const pendingStore = 'pendingCommands';
const roleNames = {
  operario_bodega: 'Operario de bodega',
  coordinacion: 'Coordinación',
  admin_banco: 'Administración',
};
let csrfToken = null;
let currentUser = null;
let searchTimer;
let serverAvailable = navigator.onLine;

function setMessage(element, text, type = '') {
  element.className = `message${type ? ` ${type}` : ''}`;
  element.textContent = text;
}

function setConnection() {
  const online = navigator.onLine && serverAvailable;
  elements.connection.textContent = online ? 'Con conexión' : 'Sin conexión';
  elements.connection.classList.toggle('offline', !online);
  elements.offlineNotice.hidden = online || !currentUser;
  elements.logout.disabled = !online;
}

function makeCommandId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = BigInt(Date.now());
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(time & 255n);
    time >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function openOfflineDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(pendingStore)) {
        request.result.createObjectStore(pendingStore, { keyPath: 'commandId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withPendingStore(mode, action) {
  const database = await openOfflineDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(pendingStore, mode);
    const request = action(transaction.objectStore(pendingStore));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
  });
}

function getPendingCommands() {
  return withPendingStore('readonly', (store) => store.getAll());
}

function savePendingCommand(command) {
  return withPendingStore('readwrite', (store) => store.put(command));
}

function deletePendingCommand(commandId) {
  return withPendingStore('readwrite', (store) => store.delete(commandId));
}

function normalizeText(value) {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

async function api(path, options = {}) {
  const method = options.method ?? 'GET';
  const headers = new Headers(options.headers ?? {});
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (method !== 'GET' && csrfToken) headers.set('X-CSRF-Token', csrfToken);
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    serverAvailable = true;
    setConnection();
  } catch (error) {
    serverAvailable = false;
    setConnection();
    throw error;
  }
  let body = {};
  if (response.status !== 204) {
    try {
      body = await response.json();
    } catch {
      body = {};
    }
  }
  if (!response.ok) {
    const error = new Error(body.message ?? 'No se pudo completar la solicitud.');
    error.status = response.status;
    error.body = body;
    if (response.status === 401 && currentUser &&
        !path.startsWith('/api/auth/')) {
      currentUser = null;
      csrfToken = null;
      sessionStorage.removeItem('offlineUser');
      showLogin(false, 'La sesión expiró. Inicia sesión para continuar.');
    }
    throw error;
  }
  return body;
}

function setAuthenticated(user, token, offline = false) {
  currentUser = user;
  csrfToken = offline ? null : token;
  sessionStorage.setItem('offlineUser', JSON.stringify(user));
  elements.authPanel.hidden = true;
  elements.workspace.hidden = false;
  elements.identity.hidden = false;
  elements.identity.textContent = `${user.name} · ${roleNames[user.role]}`;
  elements.logout.hidden = false;
  elements.reviewPanel.hidden = !['coordinacion', 'admin_banco'].includes(user.role);
  elements.usersPanel.hidden = user.role !== 'admin_banco';
  setConnection();
  void refreshWorkspace();
}

function showLogin(setupRequired = false, helpText = '') {
  currentUser = null;
  csrfToken = null;
  elements.workspace.hidden = true;
  elements.authPanel.hidden = false;
  elements.identity.hidden = true;
  elements.logout.hidden = true;
  elements.setupForm.hidden = !setupRequired;
  elements.loginForm.hidden = setupRequired;
  document.querySelector('#auth-title').textContent = setupRequired
    ? 'Configura el banco'
    : 'Iniciar sesión';
  elements.authHelp.textContent = helpText || (setupRequired
    ? 'No hay cuentas todavía. Crea la cuenta administradora inicial.'
    : 'Usa la cuenta que creó la administración del banco.');
  setMessage(elements.authMessage, '');
  setConnection();
}

async function refreshWorkspace() {
  await Promise.allSettled([
    loadProducts(),
    loadCatalog(),
    loadQueue(),
    ...(elements.reviewPanel.hidden ? [] : [loadReview()]),
    ...(elements.usersPanel.hidden ? [] : [loadUsers()]),
  ]);
  await syncQueue();
}

async function initializeSession() {
  const cachedUser = readOfflineUser();
  try {
    const session = await api('/api/auth/session');
    setAuthenticated(session.user, session.csrfToken);
  } catch (error) {
    if (error.status === 401) {
      sessionStorage.removeItem('offlineUser');
      try {
        const setup = await api('/api/auth/setup');
        showLogin(setup.setupRequired);
      } catch {
        showLogin(false, 'No se pudo conectar con el servidor. Conéctate para iniciar sesión.');
      }
      return;
    }
    if (cachedUser) {
      setAuthenticated(cachedUser, null, true);
      elements.offlineNotice.hidden = false;
      await loadQueue();
      return;
    }
    showLogin(false, 'No se pudo conectar con el servidor. Conéctate para iniciar sesión.');
  }
}

function readOfflineUser() {
  try {
    const user = JSON.parse(sessionStorage.getItem('offlineUser') ?? 'null');
    return user && typeof user.id === 'string' && roleNames[user.role] ? user : null;
  } catch {
    return null;
  }
}

async function loadProducts() {
  try {
    const list = await api('/api/products');
    localStorage.setItem('products', JSON.stringify(list));
    renderProducts(list);
  } catch (error) {
    const saved = JSON.parse(localStorage.getItem('products') ?? '[]');
    renderProducts(saved);
    if (!saved.length && error.status !== 401) {
      elements.products.replaceChildren(new Option('Conéctate para cargar productos', ''));
    }
  }
}

function renderProducts(list) {
  elements.products.replaceChildren();
  for (const item of list) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${item.name} · ${item.category}`;
    elements.products.append(option);
  }
}

async function loadCatalog() {
  try {
    const data = await api('/api/catalog');
    localStorage.setItem('catalog', JSON.stringify(data));
    await renderCatalog(data);
  } catch {
    const cached = JSON.parse(localStorage.getItem('catalog') ?? '[]');
    await renderCatalog(cached);
    if (!cached.length) elements.searchStatus.textContent = 'Conéctate para cargar el catálogo.';
  }
}

async function renderCatalog(items, query = '') {
  const commands = currentUser ? await getPendingCommands() : [];
  const ownPending = commands
    .filter((command) => command.ownerId === currentUser?.id)
    .map((command) => command.reference);
  const all = [...ownPending, ...items];
  const key = normalizeText(query);
  const filtered = key
    ? all.filter((item) => normalizeText(
      `${item.product} ${item.presentation} ${item.category ?? ''} ${item.bankCode ?? ''}`,
    ).includes(key))
    : all;
  const unique = [...new Map(filtered.map((item) => [item.id, item])).values()];
  renderResults(unique);
}

function renderResults(items) {
  elements.results.replaceChildren();
  elements.searchStatus.textContent = items.length
    ? (items.length === 1 ? '1 presentación' : `${items.length} presentaciones`)
    : 'No hay presentaciones que coincidan.';
  for (const item of items) {
    const row = document.createElement('li');
    row.className = 'result';
    const info = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = `${item.product} · ${item.presentation}`;
    const detail = document.createElement('small');
    detail.textContent = `${item.equivalenceKg} kg${item.category ? ` · ${item.category}` : ''}${item.bankCode ? ` · ${item.bankCode}` : ''}`;
    info.append(name, detail);
    if (item.pendingSync) {
      const pending = document.createElement('small');
      pending.className = 'review';
      pending.textContent = 'Pendiente de sincronizar';
      info.append(pending);
    } else if (item.reviewStatus === 'pending') {
      const review = document.createElement('small');
      review.className = 'review';
      review.textContent = 'Pendiente de revisión';
      info.append(review);
    }
    row.append(info);
    elements.results.append(row);
  }
}

async function searchCatalog(query) {
  try {
    const items = await api(`/api/search?q=${encodeURIComponent(query)}`);
    await renderCatalog(items, query);
  } catch {
    const cached = JSON.parse(localStorage.getItem('catalog') ?? '[]');
    await renderCatalog(cached, query);
    if (!cached.length) elements.searchStatus.textContent = 'No hay catálogo guardado en este dispositivo.';
    else elements.searchStatus.textContent += ' · Catálogo guardado en este dispositivo';
  }
}

function renderSuggestions(items) {
  elements.suggestions.replaceChildren();
  if (!items.length) {
    elements.suggestions.textContent = 'No encontramos presentaciones con ese nombre o equivalencia.';
    return;
  }
  for (const item of items) {
    const row = document.createElement('li');
    row.className = 'suggestion';
    row.textContent = `${item.presentation} · ${item.equivalenceKg} kg`;
    elements.suggestions.append(row);
  }
  const note = document.createElement('li');
  note.className = 'hint';
  note.textContent = 'Revisa estas opciones antes de crear para evitar duplicados.';
  elements.suggestions.append(note);
}

async function suggestSimilar() {
  const params = new URLSearchParams({
    productId: elements.products.value,
    presentation: elements.presentation.value,
    equivalenceKg: elements.equivalence.value,
  });
  try {
    renderSuggestions(await api(`/api/references/suggestions?${params}`));
  } catch (error) {
    elements.suggestions.textContent = error.message;
  }
}

async function saveForSync(payload) {
  const product = JSON.parse(localStorage.getItem('products') ?? '[]')
    .find((item) => item.id === payload.productId);
  if (!product) throw new Error('No encontramos el producto guardado para esta alta.');
  const reference = {
    id: payload.commandId,
    productId: product.id,
    product: product.name,
    category: product.category,
    bankCode: product.bankCode,
    presentation: payload.presentation,
    equivalenceKg: payload.equivalenceKg,
    createdFromMobile: true,
    reviewStatus: 'pending',
    active: true,
    pendingSync: true,
  };
  const command = {
    commandId: payload.commandId,
    ownerId: currentUser.id,
    payload,
    reference,
    state: 'pending',
    createdAt: new Date().toISOString(),
  };
  await savePendingCommand(command);
  await renderCatalog(JSON.parse(localStorage.getItem('catalog') ?? '[]'), elements.search.value);
  await loadQueue();
  return command;
}

async function syncCommand(command, retrying = false) {
  if (!currentUser || command.ownerId !== currentUser.id || command.state === 'blocked') return;
  try {
    await api('/api/references/from-mobile', { method: 'POST', body: command.payload });
    await deletePendingCommand(command.commandId);
    setMessage(elements.message, 'Presentación sincronizada y disponible en el catálogo.', 'success');
    await loadCatalog();
    await loadQueue();
  } catch (error) {
    if (error.status === 409 && error.body?.reference) {
      await deletePendingCommand(command.commandId);
      renderSuggestions([error.body.reference]);
      setMessage(elements.message, error.message, 'error');
      await loadQueue();
      await loadCatalog();
      return;
    }
    if (error.status === 403 && !retrying) {
      try {
        const session = await api('/api/auth/session');
        if (session.user.id === currentUser?.id) {
          csrfToken = session.csrfToken;
          await syncCommand(command, true);
          return;
        }
      } catch (refreshError) {
        if (!refreshError.status) {
          setMessage(
            elements.message,
            'No se pudo renovar la sesión. La presentación sigue guardada en la cola para reintentar.',
            'error',
          );
        }
        return;
      }
    }
    if (error.status === 403) {
      setMessage(elements.message, error.message, 'error');
      await loadQueue();
      return;
    }
    if (!error.status) {
      setMessage(
        elements.message,
        'Sin conexión con el servidor. La presentación sigue guardada y se reintentará automáticamente.',
        'success',
      );
      await loadQueue();
      return;
    }
    if (error.status && error.status !== 401 && error.status !== 403) {
      await savePendingCommand({ ...command, state: 'blocked', error: error.message });
      setMessage(elements.message, `${error.message} Puedes quitarla de la cola para descartarla.`, 'error');
      await loadQueue();
    }
  }
}

async function syncQueue() {
  if (!navigator.onLine || !serverAvailable || !currentUser || !csrfToken) return;
  const commands = await getPendingCommands();
  for (const command of commands) {
    if (command.ownerId === currentUser.id && command.state === 'pending') {
      await syncCommand(command);
    }
  }
}

async function loadQueue() {
  if (!currentUser) return;
  try {
    const commands = (await getPendingCommands())
      .filter((command) => command.ownerId === currentUser.id);
    elements.queuePanel.hidden = commands.length === 0;
    elements.queueList.replaceChildren();
    for (const command of commands) {
      const row = document.createElement('li');
      row.className = 'result';
      const info = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = `${command.reference.product} · ${command.reference.presentation}`;
      const detail = document.createElement('small');
      detail.textContent = command.state === 'blocked'
        ? command.error
        : (navigator.onLine && serverAvailable ? 'Esperando sincronización' : 'Pendiente de sincronizar');
      info.append(title, detail);
      row.append(info);
      if (command.state === 'blocked') {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'button small secondary';
        remove.textContent = 'Quitar de la cola';
        remove.addEventListener('click', async () => {
          await deletePendingCommand(command.commandId);
          await renderCatalog(JSON.parse(localStorage.getItem('catalog') ?? '[]'), elements.search.value);
          await loadQueue();
        });
        row.append(remove);
      }
      elements.queueList.append(row);
    }
  } catch (error) {
    elements.queuePanel.hidden = false;
    elements.queueList.textContent = `No se pudo leer la cola local: ${error.message}`;
  }
}

async function loadReview() {
  try {
    const references = await api('/api/references/review');
    elements.reviewList.replaceChildren();
    if (!references.length) {
      elements.reviewList.textContent = 'No hay presentaciones pendientes.';
      return;
    }
    for (const reference of references) {
      const row = document.createElement('li');
      row.className = 'review-card';
      const title = document.createElement('strong');
      title.textContent = `${reference.product} · ${reference.presentation}`;
      const detail = document.createElement('small');
      detail.textContent = `${reference.equivalenceKg} kg · Creada ${new Date(reference.createdAt).toLocaleString()}${reference.createdBy ? ` · Por ${reference.createdBy}` : ''}`;
      const note = document.createElement('input');
      note.maxLength = 500;
      note.placeholder = 'Nota opcional (máximo 500 caracteres)';
      note.setAttribute('aria-label', `Nota para ${reference.presentation}`);
      const actions = document.createElement('div');
      actions.className = 'review-actions';
      for (const [decision, label] of [['approve', 'Aprobar'], ['reject', 'Rechazar']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = decision === 'approve' ? 'button small' : 'button small danger';
        button.textContent = label;
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await api(`/api/references/${encodeURIComponent(reference.id)}/review`, {
              method: 'POST',
              body: { decision, note: note.value },
            });
            await Promise.all([loadReview(), loadCatalog()]);
          } catch (error) {
            setMessage(elements.message, error.message, 'error');
          } finally {
            button.disabled = false;
          }
        });
        actions.append(button);
      }
      row.append(title, detail, note, actions);
      elements.reviewList.append(row);
    }
  } catch (error) {
    elements.reviewList.textContent = error.message;
  }
}

async function loadUsers() {
  try {
    const users = await api('/api/admin/users');
    elements.userList.replaceChildren();
    for (const user of users) {
      const row = document.createElement('li');
      row.className = 'result';
      const details = document.createElement('span');
      details.textContent = `${user.name} · ${user.email} · ${roleNames[user.role]}${user.active ? '' : ' · Inactiva'}`;
      row.append(details);
      if (user.id !== currentUser.id) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'button small secondary';
        toggle.textContent = user.active ? 'Desactivar' : 'Activar';
        toggle.addEventListener('click', async () => {
          toggle.disabled = true;
          try {
            await api(`/api/admin/users/${encodeURIComponent(user.id)}`, {
              method: 'PATCH',
              body: { active: !user.active },
            });
            await loadUsers();
          } catch (error) {
            setMessage(elements.userMessage, error.message, 'error');
          } finally {
            toggle.disabled = false;
          }
        });
        row.append(toggle);
      }
      elements.userList.append(row);
    }
  } catch (error) {
    elements.userList.textContent = error.message;
  }
}

function formData(form) {
  return Object.fromEntries(new FormData(form));
}

elements.setupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/auth/setup', {
      method: 'POST',
      body: formData(elements.setupForm),
    });
    elements.setupForm.reset();
    setAuthenticated(result.user, result.csrfToken);
  } catch (error) {
    setMessage(elements.authMessage, error.message, 'error');
  }
});

elements.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: formData(elements.loginForm),
    });
    elements.loginForm.reset();
    setAuthenticated(result.user, result.csrfToken);
  } catch (error) {
    setMessage(elements.authMessage, error.message, 'error');
  }
});

elements.logout.addEventListener('click', async () => {
  if (!navigator.onLine || !serverAvailable) return;
  elements.logout.disabled = true;
  try {
    await api('/api/auth/logout', { method: 'POST' });
    sessionStorage.removeItem('offlineUser');
    showLogin(false, 'Sesión cerrada.');
  } catch (error) {
    setMessage(elements.message, error.message, 'error');
  } finally {
    elements.logout.disabled = !navigator.onLine;
  }
});

elements.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchCatalog(elements.search.value.trim()), 160);
});

document.querySelector('#suggest-button').addEventListener('click', suggestSimilar);
document.querySelector('#review-refresh').addEventListener('click', loadReview);

elements.createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage(elements.message, '');
  elements.createButton.disabled = true;
  const payload = {
    commandId: makeCommandId(),
    productId: elements.products.value,
    presentation: elements.presentation.value.trim(),
    equivalenceKg: Number(elements.equivalence.value),
  };
  try {
    const command = await saveForSync(payload);
    if (navigator.onLine && csrfToken) await syncCommand(command);
    else setMessage(elements.message, 'Guardada en este dispositivo. Se sincronizará al recuperar la conexión.', 'success');
    elements.createForm.reset();
    elements.suggestions.replaceChildren();
  } catch (error) {
    setMessage(elements.message, error.message, 'error');
  } finally {
    elements.createButton.disabled = false;
  }
});

elements.userForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/admin/users', { method: 'POST', body: formData(elements.userForm) });
    elements.userForm.reset();
    setMessage(elements.userMessage, 'Cuenta creada. Comparte la contraseña temporal por un canal seguro.', 'success');
    await loadUsers();
  } catch (error) {
    setMessage(elements.userMessage, error.message, 'error');
  }
});

window.addEventListener('online', async () => {
  serverAvailable = true;
  setConnection();
  if (!currentUser) return;
  try {
    const session = await api('/api/auth/session');
    setAuthenticated(session.user, session.csrfToken);
  } catch (error) {
    if (!error.status) {
      setAuthenticated(currentUser, null, true);
      return;
    }
    sessionStorage.removeItem('offlineUser');
    showLogin(false, 'La sesión expiró. Inicia sesión para sincronizar los cambios guardados.');
  }
});
window.addEventListener('offline', setConnection);
setInterval(async () => {
  if (!currentUser || !navigator.onLine || serverAvailable) return;
  try {
    const session = await api('/api/auth/session');
    setAuthenticated(session.user, session.csrfToken);
  } catch (error) {
    if (error.status === 401) {
      sessionStorage.removeItem('offlineUser');
      showLogin(false, 'La sesión expiró. Inicia sesión para sincronizar los cambios guardados.');
    }
  }
}, 15_000);

setConnection();
await initializeSession();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').catch((error) => {
    console.error('No se pudo activar el caché de la aplicación:', error);
  });
}

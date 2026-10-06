const searchInput = document.querySelector('#search');
const results = document.querySelector('#results');
const searchStatus = document.querySelector('#search-status');
const products = document.querySelector('#product');
const presentation = document.querySelector('#presentation');
const equivalence = document.querySelector('#equivalence');
const suggestions = document.querySelector('#suggestions');
const message = document.querySelector('#message');
const form = document.querySelector('#create-form');
const createButton = document.querySelector('#create-button');
const connection = document.querySelector('#connection');
let searchTimer;
let catalogTag;

function setConnection() {
  const online = navigator.onLine;
  connection.textContent = online ? 'Con conexión' : 'Sin conexión';
  connection.classList.toggle('offline', !online);
}

function makeCommandId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const milliseconds = Date.now();
  let time = BigInt(milliseconds);
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(time & 255n);
    time >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function loadCatalog() {
  const headers = catalogTag ? { 'If-None-Match': catalogTag } : {};
  const response = await fetch('/api/catalog', { headers });
  if (response.status === 304) return;
  if (!response.ok) throw new Error('No se pudo actualizar el catálogo.');
  const data = await response.json();
  catalogTag = response.headers.get('ETag');
  localStorage.setItem('catalog', JSON.stringify(data));
  renderResults(data);
}

function renderResults(items) {
  results.replaceChildren();
  searchStatus.textContent = items.length
    ? `${items.length} presentación${items.length === 1 ? '' : 'es'}`
    : 'No hay presentaciones que coincidan.';
  for (const item of items) {
    const row = document.createElement('li');
    row.className = 'result';
    const info = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = `${item.product} · ${item.presentation}`;
    const detail = document.createElement('small');
    detail.textContent = `${item.equivalenceKg} kg · ${item.category} · ${item.bankCode}`;
    info.append(name, detail);
    if (item.createdFromMobile) {
      const review = document.createElement('small');
      review.className = 'review';
      review.textContent = 'Pendiente de revisión';
      info.append(review);
    }
    row.append(info);
    results.append(row);
  }
}

async function searchCatalog(query) {
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error('No se pudo realizar la búsqueda.');
    renderResults(await response.json());
  } catch (error) {
    if (!navigator.onLine) {
      const cached = JSON.parse(localStorage.getItem('catalog') ?? '[]');
      const normalized = query.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
      renderResults(cached.filter((item) =>
        `${item.product} ${item.presentation} ${item.category} ${item.bankCode}`
          .normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().includes(normalized)));
      searchStatus.textContent += ' · Datos guardados en este dispositivo';
      return;
    }
    searchStatus.textContent = error.message;
  }
}

async function loadProducts() {
  const response = await fetch('/api/products');
  if (!response.ok) throw new Error('No se pudieron cargar los productos.');
  const list = await response.json();
  products.replaceChildren();
  for (const item of list) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${item.name} · ${item.category}`;
    products.append(option);
  }
}

function showSuggestions(items) {
  suggestions.replaceChildren();
  for (const item of items) {
    const row = document.createElement('li');
    row.className = 'suggestion';
    const info = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = item.presentation;
    const detail = document.createElement('small');
    detail.textContent = `${item.equivalenceKg} kg`;
    info.append(title, detail);
    row.append(info);
    suggestions.append(row);
  }
  if (items.length) {
    const note = document.createElement('li');
    note.className = 'hint';
    note.textContent = 'Revisa estas opciones antes de crear para evitar duplicados.';
    suggestions.append(note);
  } else {
    suggestions.textContent = 'No encontramos presentaciones con ese nombre o equivalencia.';
  }
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchCatalog(searchInput.value.trim()), 160);
});

document.querySelector('#suggest-button').addEventListener('click', async () => {
  const params = new URLSearchParams({
    productId: products.value,
    presentation: presentation.value,
    equivalenceKg: equivalence.value,
  });
  try {
    const response = await fetch(`/api/references/suggestions?${params}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? 'No se pudieron revisar las presentaciones.');
    showSuggestions(body);
  } catch (error) {
    suggestions.textContent = error.message;
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.className = 'message';
  message.textContent = '';
  createButton.disabled = true;
  try {
    const response = await fetch('/api/references/from-mobile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId: makeCommandId(),
        productId: products.value,
        presentation: presentation.value,
        equivalenceKg: Number(equivalence.value),
      }),
    });
    const body = await response.json();
    if (response.status === 409 && body.reference) {
      showSuggestions([body.reference]);
      throw new Error(body.message);
    }
    if (!response.ok) throw new Error(body.message ?? 'No se pudo crear la presentación.');
    message.className = 'message success';
    message.textContent = 'Presentación creada y disponible. Quedó marcada para revisión.';
    form.reset();
    suggestions.replaceChildren();
    await loadCatalog();
  } catch (error) {
    message.className = 'message error';
    message.textContent = navigator.onLine
      ? error.message
      : 'Necesitas conexión para crearla. El guardado y la reconciliación sin señal corresponden a otra iteración.';
  } finally {
    createButton.disabled = false;
  }
});

window.addEventListener('online', setConnection);
window.addEventListener('offline', setConnection);
setConnection();

try {
  const saved = JSON.parse(localStorage.getItem('catalog') ?? '[]');
  if (saved.length) renderResults(saved);
  await Promise.all([loadProducts(), loadCatalog()]);
} catch (error) {
  if (!navigator.onLine) {
    const saved = JSON.parse(localStorage.getItem('catalog') ?? '[]');
    renderResults(saved);
    searchStatus.textContent = 'Catálogo guardado · Conéctate para crear presentaciones.';
  } else {
    message.className = 'message error';
    message.textContent = error.message;
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').catch((error) => {
    console.error('No se pudo activar el caché de la aplicación:', error);
  });
}

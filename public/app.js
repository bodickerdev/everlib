import * as db from './db.js';

const $ = (sel, el = document) => el.querySelector(sel);
const main = $('#main');

const state = {
  carts: [],
  byId: new Map(),
  games: [], // juegos agrupados por título (un juego puede estar en varios cartuchos)
  gameIndex: new Map(),
  owned: new Set(),
  completed: new Set(), // claves "<cartucho>::<título normalizado>" de los juegos pasados
  expanded: new Set(),
  view: 'carts',
  q: '',
  fOwned: 'all',
  fLegacy: 'all',
  fCat: '',
  sort: 'new',
};

const PREFS = ['view', 'fOwned', 'fLegacy', 'fCat', 'sort'];

// ---------- utilidades ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Normaliza para buscar: minúsculas, sin acentos ni signos
const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function highlight(text, q) {
  if (!q) return esc(text);
  // Construye la versión normalizada del texto recordando de qué carácter original viene cada letra
  const chars = [...text];
  let flat = '';
  const map = [];
  chars.forEach((ch, i) => {
    const n = norm(ch) || (/[’'`´]/.test(ch) ? '' : ' ');
    for (const c of n) {
      if (c === ' ' && (!flat || flat.endsWith(' '))) continue;
      flat += c;
      map.push(i);
    }
  });
  const at = flat.indexOf(q);
  if (at < 0) return esc(text);
  const start = map[at];
  const end = map[at + q.length - 1] + 1;
  return esc(chars.slice(0, start).join('')) + '<mark>' + esc(chars.slice(start, end).join('')) + '</mark>' + esc(chars.slice(end).join(''));
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('evercade-prefs') || '{}');
    PREFS.forEach((k) => p[k] != null && (state[k] = p[k]));
  } catch {}
}

function savePrefs() {
  try {
    localStorage.setItem('evercade-prefs', JSON.stringify(Object.fromEntries(PREFS.map((k) => [k, state[k]]))));
  } catch {}
}

// ---------- datos ----------

async function loadCatalog() {
  let remote;
  try {
    const res = await fetch('data/catalog.json', { cache: 'no-cache' });
    if (res.ok) remote = await res.json();
  } catch {}
  if (remote && remote.updatedAt !== (await db.getMeta('catalogUpdatedAt'))) {
    await db.replaceCatalog(remote);
  }
  const carts = await db.getCartridges();
  if (!carts.length) throw new Error('No hay catálogo. Ejecuta "npm run scrape".');
  state.catalogUpdatedAt = remote?.updatedAt ?? (await db.getMeta('catalogUpdatedAt'));
  state.carts = carts;
  state.byId = new Map(carts.map((c) => [c.id, c]));

  const games = new Map();
  for (const c of carts) {
    c._n = norm(c.title);
    for (const g of c.games) {
      const key = norm(g.title);
      const entry = games.get(key) ?? { ...g, key, carts: [] };
      entry.image ??= g.image;
      entry.carts.push(c.id);
      games.set(key, entry);
    }
  }
  state.gameIndex = games;
  state.games = [...games.values()];
}

async function loadOwned() {
  state.owned = new Set((await db.getOwned()).map((o) => o.id).filter((id) => state.byId.has(id)));
  state.completed = new Set((await db.getCompleted()).map((o) => o.id));
}

const gameKey = (cartId, title) => `${cartId}::${norm(title)}`;

// Compleción del cartucho: media de la compleción de sus juegos (cada juego pasado = 100%)
function cartProgress(c) {
  const done = c.games.filter((g) => state.completed.has(gameKey(c.id, g.title))).length;
  const total = c.games.length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

// ---------- filtros ----------

function cartPassesFilters(c) {
  const own = state.owned.has(c.id);
  if (state.fOwned === 'owned' && !own) return false;
  if (state.fOwned === 'missing' && own) return false;
  if (state.fLegacy === 'legacy' && !c.legacy) return false;
  if (state.fLegacy === 'current' && c.legacy) return false;
  if (state.fCat && !c.categories.includes(state.fCat)) return false;
  return true;
}

function cartComparator() {
  return {
    new: (a, b) => b.order - a.order,
    old: (a, b) => a.order - b.order,
    az: (a, b) => a.title.localeCompare(b.title),
    games: (a, b) => b.games.length - a.games.length || a.title.localeCompare(b.title),
  }[state.sort];
}

function visibleCarts() {
  const q = norm(state.q);
  const out = [];
  for (const c of state.carts) {
    if (!cartPassesFilters(c)) continue;
    if (!q) {
      out.push({ c, matches: [] });
      continue;
    }
    const matches = c.games.filter((g) => norm(g.title).includes(q));
    if (c._n.includes(q) || matches.length) out.push({ c, matches });
  }
  const by = cartComparator();
  return out.sort((a, b) => by(a.c, b.c));
}

function visibleGames() {
  const q = norm(state.q);
  const list = [];
  for (const g of state.games) {
    const carts = g.carts.map((id) => state.byId.get(id));
    const ownedAny = carts.some((c) => state.owned.has(c.id));
    if (state.fOwned === 'owned' && !ownedAny) continue;
    if (state.fOwned === 'missing' && ownedAny) continue;
    // Legacy / categoría se aplican a los cartuchos que contienen el juego
    const ok = carts.some(
      (c) =>
        (state.fLegacy === 'all' || (state.fLegacy === 'legacy') === c.legacy) &&
        (!state.fCat || c.categories.includes(state.fCat)),
    );
    if (!ok) continue;
    if (q && !g.key.includes(q) && !carts.some((c) => c._n.includes(q))) continue;
    list.push(g);
  }
  const newest = (g) => Math.max(...g.carts.map((id) => state.byId.get(id).order));
  const by = {
    new: (a, b) => newest(b) - newest(a) || a.title.localeCompare(b.title),
    old: (a, b) => newest(a) - newest(b) || a.title.localeCompare(b.title),
    az: (a, b) => a.title.localeCompare(b.title),
    games: (a, b) => b.carts.length - a.carts.length || a.title.localeCompare(b.title),
  }[state.sort];
  return list.sort(by);
}

// ---------- render ----------

function renderStats() {
  const total = state.carts.length;
  const owned = state.owned.size;
  const ownedGames = state.games.filter((g) => g.carts.some((id) => state.owned.has(id))).length;
  $('#stats').innerHTML =
    `<span><b>${owned}</b>/${total} cartuchos</span>` +
    `<span><b>${ownedGames}</b>/${state.games.length} juegos</span>` +
    `<span><b>${state.completed.size}</b> pasados</span>` +
    `<span class="pct">${total ? Math.round((owned / total) * 100) : 0}%</span>`;
  $('#progress-bar').style.width = `${total ? (owned / total) * 100 : 0}%`;
}

function badges(c) {
  return [
    c.legacy ? '<span class="badge legacy">Legacy</span>' : '',
    c.tag ? `<span class="badge tag">${esc(c.tag)}</span>` : '',
    ...c.categories.map((k) => `<span class="badge cat">${esc(k)}</span>`),
    `<span class="badge plain">${plural(c.games.length, 'juego', 'juegos')}</span>`,
  ].join('');
}

function ownButton(c) {
  const own = state.owned.has(c.id);
  return `<button class="own-btn" type="button" data-own="${esc(c.id)}" aria-pressed="${own}" aria-label="${own ? 'Quitar de' : 'Añadir a'} mi colección: ${esc(c.title)}">
    <span class="own-check" aria-hidden="true"></span><span class="own-label">${own ? 'Lo tengo' : 'No lo tengo'}</span></button>`;
}

function progressBlock(c) {
  const { done, total, pct } = cartProgress(c);
  return `<span class="cart-progress${pct === 100 ? ' full' : ''}" data-progress="${esc(c.id)}">
    <span class="mini-bar" aria-hidden="true"><span style="width:${pct}%"></span></span>
    <span class="mini-text"><b>${pct}%</b> · ${done}/${total} pasados</span>
  </span>`;
}

function doneButton(key, title) {
  const done = state.completed.has(key);
  return `<button class="done-btn" type="button" data-done="${esc(key)}" aria-pressed="${done}" aria-label="${esc(title)}: ${done ? 'pasado' : 'por pasar'}">
    <span class="done-check" aria-hidden="true"></span>${done ? 'Pasado' : 'Por pasar'}</button>`;
}

function gameCard(g, q, cartId) {
  const meta = [g.genre, g.players && `${g.players} jug.`].filter(Boolean).map(esc).join(' · ');
  const key = gameKey(cartId, g.title);
  return `<li class="game${q && norm(g.title).includes(q) ? ' hit' : ''}${state.completed.has(key) ? ' done' : ''}">
    ${
      g.image
        ? `<button class="shot" type="button" data-img="${esc(g.image)}" data-caption="${esc(g.title)}" aria-label="Ampliar captura de ${esc(g.title)}"><img src="${esc(g.image)}" alt="" loading="lazy" decoding="async"></button>`
        : '<div class="shot empty" aria-hidden="true">Sin captura</div>'
    }
    <div class="game-text">
      <h3>${highlight(g.title, q)}</h3>
      ${meta ? `<p class="meta">${meta}</p>` : ''}
      ${g.description ? `<p class="desc">${esc(g.description)}</p>` : ''}
      ${otherCarts(g, cartId)}
      ${doneButton(key, g.title)}
    </div>
  </li>`;
}

// Indica si el juego también viene en otros cartuchos
function otherCarts(g, cartId) {
  const entry = state.gameIndex.get(norm(g.title));
  const others = entry ? entry.carts.filter((id) => id !== cartId) : [];
  if (!others.length) return '';
  return `<p class="also">También en: ${others.map((id) => cartChip(state.byId.get(id))).join(' ')}</p>`;
}

function cartChip(c) {
  const own = state.owned.has(c.id);
  return `<button type="button" class="chip${own ? ' owned' : ''}" data-goto="${esc(c.id)}">${own ? '✓ ' : ''}${esc(c.title)}</button>`;
}

function cartBody(c, q) {
  return `
    ${c.description ? `<p class="cart-desc">${esc(c.description)}</p>` : ''}
    ${c.note ? `<p class="cart-note">${esc(c.note)}</p>` : ''}
    <p class="cart-links"><a href="${esc(c.url)}" target="_blank" rel="noopener">Ficha oficial ↗</a>${
      c.video ? ` <a href="https://www.youtube.com/watch?v=${esc(c.video)}" target="_blank" rel="noopener">Vídeo ↗</a>` : ''
    }</p>
    <ul class="games-grid">${c.games.map((g) => gameCard(g, q, c.id)).join('')}</ul>`;
}

function cartRow({ c, matches }, q) {
  const own = state.owned.has(c.id);
  const open = state.expanded.has(c.id);
  const matchText =
    q && matches.length
      ? `<p class="match">Contiene: ${matches.map((g) => highlight(g.title, q)).join(', ')}</p>`
      : '';
  return `<article class="cart${own ? ' owned' : ''}${c.legacy ? ' is-legacy' : ''}" id="cart-${esc(c.id)}" data-id="${esc(c.id)}">
    <div class="cart-head">
      <button class="cart-toggle" type="button" aria-expanded="${open}" aria-controls="body-${esc(c.id)}">
        <img class="cover" src="${esc(c.cover)}" alt="" loading="lazy" decoding="async">
        <span class="cart-info">
          <span class="cart-title">${highlight(c.title, q)}</span>
          <span class="badges">${badges(c)}</span>
          ${progressBlock(c)}
          ${matchText}
        </span>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      ${ownButton(c)}
    </div>
    <div class="cart-body" id="body-${esc(c.id)}"${open ? '' : ' hidden'}>${open ? cartBody(c, q) : ''}</div>
  </article>`;
}

function gameRow(g, q) {
  const carts = g.carts.map((id) => state.byId.get(id));
  const ownedAny = carts.some((c) => state.owned.has(c.id));
  const doneAny = carts.some((c) => state.completed.has(gameKey(c.id, g.title)));
  const meta = [g.genre, g.players && `${g.players} jug.`].filter(Boolean).map(esc).join(' · ');
  return `<article class="grow${ownedAny ? ' owned' : ''}">
    ${
      g.image
        ? `<button class="shot" type="button" data-img="${esc(g.image)}" data-caption="${esc(g.title)}" aria-label="Ampliar captura de ${esc(g.title)}"><img src="${esc(g.image)}" alt="" loading="lazy" decoding="async"></button>`
        : '<div class="shot empty" aria-hidden="true">Sin captura</div>'
    }
    <div class="grow-text">
      <h3>${highlight(g.title, q)}${ownedAny ? ' <span class="badge have">Lo tienes</span>' : ''}${doneAny ? ' <span class="badge done">Pasado</span>' : ''}</h3>
      ${meta ? `<p class="meta">${meta}</p>` : ''}
      <p class="in-carts"><span>${carts.length > 1 ? 'En los cartuchos:' : 'En el cartucho:'}</span> ${carts.map(cartChip).join(' ')}</p>
    </div>
  </article>`;
}

function render() {
  const q = norm(state.q);
  const carts = visibleCarts();
  const games = visibleGames();
  $('#count-carts').textContent = carts.length;
  $('#count-games').textContent = games.length;
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.view === state.view));
  for (const [id, key] of [['#f-owned', 'fOwned'], ['#f-legacy', 'fLegacy']]) {
    document.querySelectorAll(`${id} button`).forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === state[key]));
  }
  $('#f-cat').value = state.fCat;
  $('#f-sort').value = state.sort;
  $('#q-clear').hidden = !state.q;

  if (state.view === 'carts') {
    main.innerHTML = carts.length
      ? `<div class="cart-list">${carts.map((o) => cartRow(o, q)).join('')}</div>`
      : empty();
  } else {
    main.innerHTML = games.length ? `<div class="game-list">${games.map((g) => gameRow(g, q)).join('')}</div>` : empty();
  }
  renderStats();
}

function empty() {
  return `<div class="empty-state"><p>No hay resultados${state.q ? ` para «${esc(state.q)}»` : ''}.</p>
    <button type="button" data-reset>Quitar filtros</button></div>`;
}

// ---------- acciones ----------

async function toggleOwned(id) {
  const own = !state.owned.has(id);
  own ? state.owned.add(id) : state.owned.delete(id);
  await db.setOwned(id, own);
  const c = state.byId.get(id);
  if (state.view === 'carts' && state.fOwned === 'all') {
    // Actualiza solo la fila para no perder la posición de scroll
    const row = document.getElementById(`cart-${id}`);
    row.classList.toggle('owned', own);
    row.querySelector('.own-btn').outerHTML = ownButton(c);
    document.querySelectorAll(`.chip[data-goto="${CSS.escape(id)}"]`).forEach((el) => (el.outerHTML = cartChip(c)));
    renderStats();
  } else {
    render();
  }
  toast(own ? `Añadido: ${c.title}` : `Quitado: ${c.title}`);
}

async function toggleDone(key) {
  const done = !state.completed.has(key);
  done ? state.completed.add(key) : state.completed.delete(key);
  await db.setCompleted(key, done);
  // Actualiza en el sitio el botón, la tarjeta y el progreso del cartucho
  const btn = main.querySelector(`[data-done="${CSS.escape(key)}"]`);
  if (btn) {
    btn.closest('.game').classList.toggle('done', done);
    btn.outerHTML = doneButton(key, btn.closest('.game').querySelector('h3').textContent);
  }
  const c = state.byId.get(key.split('::')[0]);
  const prog = main.querySelector(`[data-progress="${CSS.escape(c.id)}"]`);
  if (prog) prog.outerHTML = progressBlock(c);
  renderStats();
}

function toggleExpand(id) {
  const row = document.getElementById(`cart-${id}`);
  const body = row.querySelector('.cart-body');
  const open = !state.expanded.has(id);
  open ? state.expanded.add(id) : state.expanded.delete(id);
  row.querySelector('.cart-toggle').setAttribute('aria-expanded', open);
  if (open && !body.innerHTML) body.innerHTML = cartBody(state.byId.get(id), norm(state.q));
  body.hidden = !open;
}

function gotoCart(id) {
  state.view = 'carts';
  state.expanded.add(id);
  render();
  if (!document.getElementById(`cart-${id}`)) {
    Object.assign(state, { q: '', fOwned: 'all', fLegacy: 'all', fCat: '' });
    $('#q').value = '';
    render();
  }
  savePrefs();
  const row = document.getElementById(`cart-${id}`);
  row.scrollIntoView({ behavior: 'smooth', block: 'start' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1600);
}

function openLightbox(src, caption) {
  const dlg = $('#lightbox');
  $('#lb-img').src = src;
  $('#lb-caption').textContent = caption;
  dlg.showModal();
}

function exportOwned() {
  const data = {
    app: 'evercade-library',
    exportedAt: new Date().toISOString(),
    owned: [...state.owned].map((id) => ({ id, title: state.byId.get(id)?.title })),
    completed: [...state.completed],
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `evercade-coleccion-${data.exportedAt.slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importOwned(file) {
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.owned;
    const ids = list.map((e) => (typeof e === 'string' ? e : e.id)).filter((id) => state.byId.has(id));
    if (!confirm(`Se importarán ${plural(ids.length, 'cartucho', 'cartuchos')} y se reemplazará tu colección actual (${state.owned.size}). ¿Continuar?`)) return;
    const now = new Date().toISOString();
    await db.replaceOwned(ids.map((id) => ({ id, addedAt: now })));
    state.owned = new Set(ids);
    if (Array.isArray(data.completed)) {
      await db.replaceCompleted(data.completed.map((id) => ({ id, completedAt: now })));
      state.completed = new Set(data.completed);
    }
    render();
    toast('Colección importada');
  } catch (err) {
    console.error(err);
    alert('No se pudo leer el archivo de colección.');
  }
}

// ---------- eventos ----------

function bind() {
  let t;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.q = e.target.value;
      render();
    }, 120);
  });
  $('#q-clear').addEventListener('click', () => {
    $('#q').value = state.q = '';
    render();
    $('#q').focus();
  });

  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    state.view = b.dataset.view;
    savePrefs();
    render();
  });
  for (const [id, key] of [['#f-owned', 'fOwned'], ['#f-legacy', 'fLegacy']]) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      state[key] = b.dataset.v;
      savePrefs();
      render();
    });
  }
  $('#f-cat').addEventListener('change', (e) => {
    state.fCat = e.target.value;
    savePrefs();
    render();
  });
  $('#f-sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    savePrefs();
    render();
  });

  main.addEventListener('click', (e) => {
    const own = e.target.closest('[data-own]');
    if (own) return toggleOwned(own.dataset.own);
    const done = e.target.closest('[data-done]');
    if (done) return toggleDone(done.dataset.done);
    const desc = e.target.closest('.desc');
    if (desc) return desc.classList.toggle('open');
    const shot = e.target.closest('[data-img]');
    if (shot) return openLightbox(shot.dataset.img, shot.dataset.caption);
    const go = e.target.closest('[data-goto]');
    if (go) return gotoCart(go.dataset.goto);
    const toggle = e.target.closest('.cart-toggle');
    if (toggle) return toggleExpand(toggle.closest('.cart').dataset.id);
    if (e.target.closest('[data-reset]')) {
      Object.assign(state, { q: '', fOwned: 'all', fLegacy: 'all', fCat: '' });
      $('#q').value = '';
      savePrefs();
      render();
    }
  });

  const dlg = $('#lightbox');
  dlg.addEventListener('click', (e) => e.target === dlg || e.target.id === 'lb-img' ? dlg.close() : null);

  $('#export').addEventListener('click', exportOwned);
  $('#import-btn').addEventListener('click', () => $('#import').click());
  $('#import').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) importOwned(f);
    e.target.value = '';
  });
}

// ---------- inicio ----------

async function init() {
  loadPrefs();
  bind();
  try {
    await loadCatalog();
    await loadOwned();
  } catch (err) {
    console.error(err);
    main.innerHTML = `<p class="loading">${esc(err.message)}</p>`;
    return;
  }
  if (state.catalogUpdatedAt) {
    $('#catalog-info').textContent = `Catálogo de evercade.co.uk actualizado el ${new Date(state.catalogUpdatedAt).toLocaleDateString('es-ES', { dateStyle: 'long' })} · Datos guardados en este navegador (IndexedDB).`;
  }
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();

import * as db from './db.js';
import { t, tr, getLang, setLang, detectLang, applyStatic } from './i18n.js';

const $ = (sel, el = document) => el.querySelector(sel);
const main = $('#main');

const state = {
  carts: [],
  byId: new Map(),
  games: [], // juegos agrupados por título (un juego puede estar en varios cartuchos)
  gameIndex: new Map(),
  owned: new Set(),
  ratings: new Map(), // id de cartucho en posesión -> estrellas (1-5)
  gameRatings: new Map(), // título normalizado del juego -> estrellas (1-5)
  completed: new Set(), // claves "<cartucho>::<título normalizado>" de los juegos pasados
  expanded: new Set(),
  view: 'carts',
  q: '',
  fOwned: 'all',
  fLegacy: 'all',
  fCat: '',
  sort: 'new',
  unlockables: null,
  unlockTab: 'code', // 'code' | 'two'
  hardware: null,
  hwKind: 'all', // 'all' | 'handheld' | 'home' | 'arcade'
  showVideo: true,
  lang: null,
};

const PREFS = ['view', 'fOwned', 'fLegacy', 'fCat', 'sort', 'unlockTab', 'hwKind', 'showVideo', 'lang'];

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

// Etiquetas de datos del catálogo que vienen en inglés desde evercade.co.uk
const catLabel = (k) => t(`cat.${k}`);

function tagLabel(tag) {
  const m = tag.match(/^([A-Z][a-z]{2}) (\d{4})$/); // fecha de lanzamiento, p. ej. "Dec 2026"
  if (m) {
    const d = new Date(`${m[1]} 1, ${m[2]}`);
    if (!isNaN(d)) return d.toLocaleDateString(t('locale'), { month: 'short', year: 'numeric' });
  }
  const label = t(`tag.${tag}`);
  return label === `tag.${tag}` ? tag : label;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2600);
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
  if (!carts.length) throw new Error(t('noCatalog'));
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

// Juegos desbloqueables: datos mantenidos a mano en data/unlockables.json (copia en IndexedDB para uso sin conexión)
async function loadUnlockables() {
  try {
    const res = await fetch('data/unlockables.json', { cache: 'no-cache' });
    if (res.ok) {
      state.unlockables = await res.json();
      await db.setMeta('unlockables', state.unlockables);
      return;
    }
  } catch {}
  state.unlockables = (await db.getMeta('unlockables')) ?? null;
}

// Fichas de hardware: datos mantenidos a mano en data/hardware.json (copia en IndexedDB para uso sin conexión)
async function loadHardware() {
  try {
    const res = await fetch('data/hardware.json', { cache: 'no-cache' });
    if (res.ok) {
      state.hardware = await res.json();
      await db.setMeta('hardware', state.hardware);
      return;
    }
  } catch {}
  state.hardware = (await db.getMeta('hardware')) ?? null;
}

async function loadOwned() {
  const owned = (await db.getOwned()).filter((o) => state.byId.has(o.id));
  state.owned = new Set(owned.map((o) => o.id));
  state.ratings = new Map(owned.filter((o) => o.rating).map((o) => [o.id, o.rating]));
  // Ignora juegos pasados que ya no existen en el catálogo (p. ej. si se corrige un cartucho)
  const valid = new Set(state.carts.flatMap((c) => c.games.map((g) => gameKey(c.id, g.title))));
  state.completed = new Set((await db.getCompleted()).map((o) => o.id).filter((id) => valid.has(id)));
  state.gameRatings = new Map((await db.getGameRatings()).filter((o) => state.gameIndex.has(o.id)).map((o) => [o.id, o.rating]));
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

// Número oficial como valor ordenable: consola (01…), después arcade (A01…) y ordenador (C01…)
const NUMBER_RANK = { console: 0, arcade: 1, computer: 2 };
const cartNumber = (c) => (c?.number ? NUMBER_RANK[c.number.type] * 1000 + c.number.n : null);

const cartStars = (c) => state.ratings.get(c.id) ?? null;

// Compara números en el sentido indicado; los valores nulos (sin número, sin valorar) siempre al final
function byNumber(na, nb, dir) {
  if (na == null || nb == null) return (na == null) - (nb == null);
  return (na - nb) * dir;
}

function cartComparator() {
  return {
    new: (a, b) => b.order - a.order,
    old: (a, b) => a.order - b.order,
    'num-asc': (a, b) => byNumber(cartNumber(a), cartNumber(b), 1),
    'num-desc': (a, b) => byNumber(cartNumber(a), cartNumber(b), -1),
    'stars-desc': (a, b) => byNumber(cartStars(a), cartStars(b), -1) || byNumber(cartNumber(a), cartNumber(b), 1),
    'stars-asc': (a, b) => byNumber(cartStars(a), cartStars(b), 1) || byNumber(cartNumber(a), cartNumber(b), 1),
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
  // Un juego en varios cartuchos se ordena por el de número más bajo
  const lowest = (g) => {
    const ns = g.carts.map((id) => cartNumber(state.byId.get(id))).filter((n) => n != null);
    return ns.length ? Math.min(...ns) : null;
  };
  const stars = (g) => state.gameRatings.get(g.key) ?? null;
  const by = {
    new: (a, b) => newest(b) - newest(a) || a.title.localeCompare(b.title),
    old: (a, b) => newest(a) - newest(b) || a.title.localeCompare(b.title),
    'num-asc': (a, b) => byNumber(lowest(a), lowest(b), 1) || a.title.localeCompare(b.title),
    'num-desc': (a, b) => byNumber(lowest(a), lowest(b), -1) || a.title.localeCompare(b.title),
    'stars-desc': (a, b) => byNumber(stars(a), stars(b), -1) || a.title.localeCompare(b.title),
    'stars-asc': (a, b) => byNumber(stars(a), stars(b), 1) || a.title.localeCompare(b.title),
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
    `<span>${t('stats.carts', owned, total)}</span>` +
    `<span>${t('stats.games', ownedGames, state.games.length)}</span>` +
    `<span>${t('stats.completed', state.completed.size)}</span>` +
    `<span class="pct">${total ? Math.round((owned / total) * 100) : 0}%</span>`;
  $('#progress-bar').style.width = `${total ? (owned / total) * 100 : 0}%`;
}

function badges(c) {
  return [
    c.legacy ? '<span class="badge legacy">Legacy</span>' : '',
    c.tag ? `<span class="badge tag">${esc(tagLabel(c.tag))}</span>` : '',
    ...c.categories.map((k) => `<span class="badge cat">${esc(catLabel(k))}</span>`),
    `<span class="badge plain">${t('games.count', c.games.length)}</span>`,
  ].join('');
}

function ownButton(c) {
  const own = state.owned.has(c.id);
  return `<button class="own-btn" type="button" data-own="${esc(c.id)}" aria-pressed="${own}" aria-label="${esc(t(own ? 'own.remove' : 'own.add', c.title))}">
    <span class="own-check" aria-hidden="true"></span><span class="own-label">${t(own ? 'own.yes' : 'own.no')}</span></button>`;
}

function progressBlock(c) {
  const { done, total, pct } = cartProgress(c);
  return `<span class="cart-progress${pct === 100 ? ' full' : ''}" data-progress="${esc(c.id)}">
    <span class="mini-bar" aria-hidden="true"><span style="width:${pct}%"></span></span>
    <span class="mini-text"><b>${pct}%</b> · ${t('progress.text', done, total)}</span>
  </span>`;
}

function doneButton(key, title) {
  const done = state.completed.has(key);
  return `<button class="done-btn" type="button" data-done="${esc(key)}" aria-pressed="${done}" aria-label="${esc(t('done.aria', title, done))}">
    <span class="done-check" aria-hidden="true"></span>${t(done ? 'done.yes' : 'done.no')}</button>`;
}

function shot(g) {
  return g.image
    ? `<button class="shot" type="button" data-img="${esc(g.image)}" data-caption="${esc(g.title)}" aria-label="${esc(t('shot.zoom', g.title))}"><img src="${esc(g.image)}" alt="" loading="lazy" decoding="async"></button>`
    : `<div class="shot empty" aria-hidden="true">${t('shot.none')}</div>`;
}

const gameMeta = (g) => [g.genre, g.players && t('players', g.players)].filter(Boolean).map(esc).join(' · ');

function gameCard(g, q, cartId) {
  const meta = gameMeta(g);
  const key = gameKey(cartId, g.title);
  return `<li class="game${q && norm(g.title).includes(q) ? ' hit' : ''}${state.completed.has(key) ? ' done' : ''}">
    ${shot(g)}
    <div class="game-text">
      <h3>${highlight(g.title, q)}</h3>
      ${meta ? `<p class="meta">${meta}</p>` : ''}
      ${g.description ? `<p class="desc">${esc(g.description)}</p>` : ''}
      ${otherCarts(g, cartId)}
      ${gameRatingBar(g.title)}
      ${doneButton(key, g.title)}
    </div>
  </li>`;
}

// Indica si el juego también viene en otros cartuchos
function otherCarts(g, cartId) {
  const entry = state.gameIndex.get(norm(g.title));
  const others = entry ? entry.carts.filter((id) => id !== cartId) : [];
  if (!others.length) return '';
  return `<p class="also">${t('also')} ${others.map((id) => cartChip(state.byId.get(id))).join(' ')}</p>`;
}

function cartChip(c) {
  const own = state.owned.has(c.id);
  return `<button type="button" class="chip${own ? ' owned' : ''}" data-goto="${esc(c.id)}">${own ? '✓ ' : ''}${esc(c.title)}</button>`;
}

function cartBody(c, q) {
  return `
    ${c.description ? `<p class="cart-desc">${esc(c.description)}</p>` : ''}
    ${c.note ? `<p class="cart-note">${esc(c.note)}</p>` : ''}
    ${(c.editions ?? [])
      .map((e) => `<p class="cart-edition"><span class="badge">${t('edition')}</span> <b>${esc(e.title)}</b>${e.description ? ` — ${esc(e.description)}` : ''}</p>`)
      .join('')}
    <p class="cart-links"><a href="${esc(c.url)}" target="_blank" rel="noopener">${t('link.official')}</a>${
      c.video ? ` <a href="https://www.youtube.com/watch?v=${esc(c.video)}" target="_blank" rel="noopener">${t('link.video')}</a>` : ''
    }</p>
    <ul class="games-grid">${c.games.map((g) => gameCard(g, q, c.id)).join('')}</ul>`;
}

const starButtons = (r) =>
  [1, 2, 3, 4, 5]
    .map(
      (n) =>
        `<button type="button" class="star${n <= r ? ' on' : ''}" data-rate="${n}" aria-pressed="${n === r}" aria-label="${t('rating.star', n)}">★</button>`,
    )
    .join('');

// Estrellas de calidad: solo para cartuchos en posesión
function ratingBar(c) {
  if (!state.owned.has(c.id)) return `<div class="cart-rating" data-rating-for="${esc(c.id)}" hidden></div>`;
  const r = state.ratings.get(c.id) ?? 0;
  return `<div class="cart-rating" data-rating-for="${esc(c.id)}" role="group" aria-label="${esc(t('rating.group', c.title))}">
    <span class="rating-label">${t('rating.label')}</span>
    <span class="stars">${starButtons(r)}</span>
    <span class="rating-text">${r ? `${r}/5` : t('rating.none')}</span>
  </div>`;
}

// Estrellas del juego: una valoración por título, compartida por todos los cartuchos que lo incluyen
function gameRatingBar(title) {
  const key = norm(title);
  const r = state.gameRatings.get(key) ?? 0;
  return `<span class="stars game-stars" data-game-rating-for="${esc(key)}" role="group" aria-label="${esc(t('gameRating.group', title))}">${starButtons(r)}</span>`;
}

function cartRow({ c, matches }, q) {
  const own = state.owned.has(c.id);
  const open = state.expanded.has(c.id);
  const matchText =
    q && matches.length
      ? `<p class="match">${t('contains')} ${matches.map((g) => highlight(g.title, q)).join(', ')}</p>`
      : '';
  return `<article class="cart${own ? ' owned' : ''}${c.legacy ? ' is-legacy' : ''}" id="cart-${esc(c.id)}" data-id="${esc(c.id)}">
    <div class="cart-head">
      <button class="cart-toggle" type="button" aria-expanded="${open}" aria-controls="body-${esc(c.id)}">
        <img class="cover" src="${esc(c.cover)}" alt="" loading="lazy" decoding="async">
        <span class="cart-info">
          <span class="cart-title">${c.number ? `<span class="cart-num" title="${t('cartNum.title')}">${esc(c.number.label)}</span>` : ''}${highlight(c.title, q)}</span>
          <span class="badges">${badges(c)}</span>
          ${progressBlock(c)}
          ${matchText}
        </span>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      ${ownButton(c)}
    </div>
    ${ratingBar(c)}
    <div class="cart-body" id="body-${esc(c.id)}"${open ? '' : ' hidden'}>${open ? cartBody(c, q) : ''}</div>
  </article>`;
}

function gameRow(g, q) {
  const carts = g.carts.map((id) => state.byId.get(id));
  const ownedAny = carts.some((c) => state.owned.has(c.id));
  const doneAny = carts.some((c) => state.completed.has(gameKey(c.id, g.title)));
  const meta = gameMeta(g);
  return `<article class="grow${ownedAny ? ' owned' : ''}">
    <div class="grow-media">
      ${shot(g)}
      ${gameRatingBar(g.title)}
    </div>
    <div class="grow-text">
      <h3>${highlight(g.title, q)}${ownedAny ? ` <span class="badge have">${t('have')}</span>` : ''}${doneAny ? ` <span class="badge done">${t('done.yes')}</span>` : ''}</h3>
      ${meta ? `<p class="meta">${meta}</p>` : ''}
      <p class="in-carts"><span>${t('inCarts', carts.length)}</span> ${carts.map(cartChip).join(' ')}</p>
    </div>
  </article>`;
}

function render() {
  const q = norm(state.q);
  const carts = visibleCarts();
  const games = visibleGames();
  const unlock = visibleUnlockables();
  const hw = visibleHardware();
  $('#count-carts').textContent = carts.length;
  $('#count-games').textContent = games.length;
  $('#count-unlock').textContent = unlock.text.length + unlock.buttons.length + unlock.ingame.length + unlock.two.length;
  $('#count-hardware').textContent = variantCount(ofKind(hw, state.hwKind));
  $('.filters').hidden = state.view === 'unlock' || state.view === 'hardware';
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
  } else if (state.view === 'games') {
    main.innerHTML = games.length ? `<div class="game-list">${games.map((g) => gameRow(g, q)).join('')}</div>` : empty();
  } else if (state.view === 'hardware') {
    main.innerHTML = hardwareView(hw, q);
  } else {
    main.innerHTML = unlockView(unlock, q);
  }
  renderStats();
}

// ---------- desbloqueables ----------

const hits = (q, ...fields) => !q || fields.some((f) => norm(f).includes(q));

function visibleUnlockables() {
  const u = state.unlockables;
  if (!u) return { text: [], buttons: [], ingame: [], extras: [], two: [] };
  const q = norm(state.q);
  const cartTitles = (ids = []) => ids.map((id) => state.byId.get(id)?.title ?? '');
  return {
    text: u.codes.text.items.filter((i) => hits(q, tr(i.title), tr(i.platform), i.code)),
    buttons: u.codes.buttons.items.filter((i) => hits(q, tr(i.title), tr(i.platform), ...cartTitles(i.requires))),
    ingame: (u.codes.ingame?.items ?? []).filter((i) => hits(q, tr(i.title), tr(i.platform), i.code, ...cartTitles(i.requires))),
    extras: u.codes.extras.items.filter((i) => hits(q, i.code, tr(i.combo), tr(i.description), ...cartTitles(i.requires))),
    two: u.twoCarts.items.filter((i) => hits(q, tr(i.title), tr(i.platform), ...cartTitles(i.carts))),
  };
}

// Resalta los botones de la consola dentro de una combinación
// (no toca el texto entre «» o “” —nombres de menú— ni letras tras un guion, como en VS-R)
const keys = (s) =>
  esc(s)
    .split(/(«[^»]*»|“[^”]*”)/)
    .map((part, i) =>
      i % 2 ? part : part.replace(/(?<!-)\b(L1|L2|R1|R2|L|R|A|B|X|Y|Select|Start|Menu|Arriba|Abajo|Up|Down)\b/g, '<kbd>$1</kbd>'),
    )
    .join('');

function secretCard(i, q) {
  const reqs = (i.requires ?? []).map((id) => state.byId.get(id)).filter(Boolean);
  const [title, platform, combo, how, description, note] = [i.title, i.platform, i.combo, i.how, i.description, i.note].map(tr);
  return `<article class="ucard">
    <div class="ucard-head">
      <h3>${highlight(title || description, q)}</h3>
      ${platform ? `<span class="badge">${esc(platform)}</span>` : ''}
    </div>
    ${i.code ? `<p class="secret"><span class="secret-label">${t('secret.code')}</span><code>${highlight(i.code, q)}</code></p>` : ''}
    ${combo ? `<p class="secret"><span class="secret-label">${t('secret.buttons')}</span><span class="combo">${keys(combo)}</span></p>` : ''}
    ${how ? `<p class="secret"><span class="secret-label">${t('secret.how')}</span><span class="how">${keys(how)}</span></p>` : ''}
    ${title && description ? `<p class="unote">${esc(description)}</p>` : ''}
    ${note ? `<p class="unote">${esc(note)}</p>` : ''}
    ${reqs.length ? `<p class="also">${t('secret.needs')} ${reqs.map(cartChip).join(' ')}</p>` : ''}
  </article>`;
}

function cartMini(c) {
  const own = state.owned.has(c.id);
  return `<button type="button" class="cart-mini${own ? ' owned' : ''}" data-goto="${esc(c.id)}">
    <img src="${esc(c.cover)}" alt="" loading="lazy" decoding="async">
    <span class="cart-mini-title">${esc(c.title)}</span>
    <span class="cart-mini-own">${own ? `✓ ${t('own.yes')}` : t('own.no')}</span>
  </button>`;
}

function twoCartCard(i, q) {
  const carts = i.carts.map((id) => state.byId.get(id)).filter(Boolean);
  const missing = carts.filter((c) => !state.owned.has(c.id));
  const status = !missing.length
    ? `<p class="ustatus ok">${t('two.ready')}</p>`
    : `<p class="ustatus">${missing.length === carts.length ? t('two.missingBoth') : esc(t('two.missing', missing[0].title))}</p>`;
  return `<article class="ucard${missing.length ? '' : ' ready'}">
    <div class="ucard-head">
      <h3>${highlight(tr(i.title), q)}</h3>
      <span class="badge">${esc(tr(i.platform))}</span>
    </div>
    <div class="pair">${carts.map(cartMini).join('<span class="plus" aria-hidden="true">+</span>')}</div>
    ${status}
  </article>`;
}

function unlockView(v, q) {
  const u = state.unlockables;
  if (!u) return `<p class="loading">${t('unlock.error')}</p>`;
  const nCode = v.text.length + v.buttons.length + v.ingame.length; // los extras no son juegos y no cuentan
  const tabs = `<div class="subtabs" role="tablist" aria-label="${t('unlock.aria')}">
    <button role="tab" data-unlock-tab="code" aria-selected="${state.unlockTab === 'code'}">${t('unlock.code')} <span>${nCode}</span></button>
    <button role="tab" data-unlock-tab="two" aria-selected="${state.unlockTab === 'two'}">${t('unlock.two')} <span>${v.two.length}</span></button>
  </div>`;
  const section = (group, items, card) =>
    items.length
      ? `<section class="usection"><h2>${esc(tr(group.title))}</h2>${group.help ? `<p class="uhelp">${esc(tr(group.help))}</p>` : ''}
        <div class="ugrid">${items.map((i) => card(i, q)).join('')}</div></section>`
      : '';

  let body;
  if (state.unlockTab === 'two') {
    const ready = u.twoCarts.items.filter((i) => i.carts.every((id) => state.owned.has(id))).length;
    body = v.two.length
      ? `<section class="usection"><p class="uhelp">${esc(tr(u.twoCarts.help))}</p>
        <p class="usummary">${t('two.summary', ready, u.twoCarts.items.length)}</p>
        <div class="ugrid">${v.two.map((i) => twoCartCard(i, q)).join('')}</div></section>`
      : empty();
  } else {
    body = nCode + v.extras.length
      ? section(u.codes.text, v.text, secretCard) +
        section(u.codes.buttons, v.buttons, secretCard) +
        (u.codes.ingame ? section(u.codes.ingame, v.ingame, secretCard) : '') +
        section(u.codes.extras, v.extras, secretCard)
      : empty();
  }
  return tabs + body;
}

// ---------- hardware ----------

// Juegos integrados de una versión (las ediciones limitadas reutilizan los de su edición normal)
function variantGames(item, v) {
  if (v.games) return v.games;
  return item.variants.find((o) => o.name === v.gamesFrom)?.games ?? [];
}

// Busca en todo el hardware; el filtro por tipo se aplica después para poder contar cada tipo
function visibleHardware() {
  const h = state.hardware;
  if (!h) return [];
  const q = norm(state.q);
  const cartTitles = (ids = []) => ids.map((id) => state.byId.get(id)?.title ?? '');
  return h.items
    .map((item) => ({
      item,
      // Si la búsqueda coincide con el producto se muestran todas sus versiones
      variants: hits(q, item.name, item.maker, tr(item.type))
        ? item.variants
        : item.variants.filter((v) => hits(q, v.name, ...variantGames(item, v), ...cartTitles(v.includes))),
    }))
    .filter((o) => o.variants.length);
}

function hwImage(src, caption) {
  return `<button class="hw-img" type="button" data-img="${esc(src)}" data-photo data-caption="${esc(caption)}" aria-label="${esc(t('shot.zoom', caption))}"><img src="${esc(src)}" alt="" loading="lazy" decoding="async"></button>`;
}

function variantCard(item, v, q) {
  const games = variantGames(item, v);
  const incl = (v.includes ?? []).map((id) => state.byId.get(id)).filter(Boolean);
  const gameHit = q && games.some((g) => norm(g).includes(q));
  return `<article class="ucard hw-card">
    ${v.image ? hwImage(v.image, v.name) : ''}
    <div class="ucard-head">
      <h3>${highlight(v.name, q)}</h3>
      ${v.limited ? `<span class="badge legacy">${t('hw.limited')}</span>` : ''}
    </div>
    ${v.price ? `<p class="hw-price">${esc(tr(v.price))}</p>` : ''}
    ${v.note ? `<p class="hw-note">${esc(tr(v.note))}</p>` : ''}
    ${incl.length ? `<p class="also">${t('hw.includes')} ${incl.map(cartChip).join(' ')}</p>` : ''}
    ${
      v.gamesFrom && !gameHit
        ? ''
        : games.length
          ? `<details class="hw-games"${gameHit ? ' open' : ''}><summary>${t('hw.builtIn', games.length)}</summary>
        <ol>${games.map((g) => `<li>${highlight(g, q)}</li>`).join('')}</ol></details>`
          : ''
    }
    ${v.url && v.url !== item.url ? `<p class="cart-links"><a href="${esc(v.url)}" target="_blank" rel="noopener">${t('link.official')}</a></p>` : ''}
  </article>`;
}

const HW_KINDS = ['all', 'handheld', 'home', 'arcade'];
const variantCount = (list) => list.reduce((n, h) => n + h.variants.length, 0);
const ofKind = (list, kind) => (kind === 'all' ? list : list.filter((h) => h.item.kind === kind));

function hardwareView(all, q) {
  if (!state.hardware) return `<p class="loading">${t('hw.error')}</p>`;
  const tabs = `<div class="subtabs" role="tablist" aria-label="${t('hw.kind.aria')}">${HW_KINDS.map(
    (k) => `<button role="tab" data-hw-kind="${k}" aria-selected="${state.hwKind === k}">${t(`hw.kind.${k}`)} <span>${variantCount(ofKind(all, k))}</span></button>`,
  ).join('')}</div>`;
  const list = ofKind(all, state.hwKind);
  if (!list.length) return tabs + empty();
  return tabs + list
    .map(
      ({ item, variants }) => `<section class="usection hw">
      <div class="hw-head">
        ${
          item.image
            ? `<figure class="hw-figure">${hwImage(item.image, item.name)}${
                item.imageCredit
                  ? `<figcaption><a href="${esc(item.imageCredit.url)}" target="_blank" rel="noopener">${t('hw.photo')}: ${esc(item.imageCredit.text)}</a></figcaption>`
                  : ''
              }</figure>`
            : ''
        }
        <div class="hw-info">
          <h2>${highlight(item.name, q)}</h2>
          <p class="badges">${item.legacy ? `<span class="badge legacy">${t('hw.legacy')}</span>` : ''}<span class="badge cat">${esc(tr(item.type))}</span><span class="badge plain">${esc(item.maker)}</span><span class="badge plain">${t('hw.variants', item.variants.length)}</span>${
            item.status ? `<span class="badge tag">${esc(tr(item.status))}</span>` : ''
          }${item.noCarts ? `<span class="badge plain">${t('hw.noCarts')}</span>` : ''}</p>
          ${item.price ? `<p class="hw-price">${esc(tr(item.price))}</p>` : ''}
          <p class="uhelp">${esc(tr(item.description))}</p>
          <details class="hw-specs"><summary>${t('hw.specs')}</summary>
            <ul>${item.specs.map((s) => `<li>${esc(tr(s))}</li>`).join('')}</ul></details>
          <p class="cart-links"><a href="${esc(item.url)}" target="_blank" rel="noopener">${t('link.official')}</a></p>
        </div>
      </div>
      <div class="ugrid">${variants.map((v) => variantCard(item, v, q)).join('')}</div>
    </section>`,
    )
    .join('');
}

function empty() {
  return `<div class="empty-state"><p>${t('empty.text', esc(state.q))}</p>
    <button type="button" data-reset>${t('empty.reset')}</button></div>`;
}

// ---------- acciones ----------

async function toggleOwned(id) {
  const own = !state.owned.has(id);
  own ? state.owned.add(id) : state.owned.delete(id);
  if (!own) state.ratings.delete(id); // al quitarlo se borra su registro, valoración incluida
  await db.setOwned(id, own);
  const c = state.byId.get(id);
  if (state.view === 'carts' && state.fOwned === 'all') {
    // Actualiza solo la fila para no perder la posición de scroll
    const row = document.getElementById(`cart-${id}`);
    row.classList.toggle('owned', own);
    row.querySelector('.own-btn').outerHTML = ownButton(c);
    row.querySelector('.cart-rating').outerHTML = ratingBar(c);
    document.querySelectorAll(`.chip[data-goto="${CSS.escape(id)}"]`).forEach((el) => (el.outerHTML = cartChip(c)));
    renderStats();
  } else {
    render();
  }
  toast(t(own ? 'toast.added' : 'toast.removed', c.title));
}

async function setRating(id, n) {
  const r = state.ratings.get(id) === n ? 0 : n; // pulsar la estrella actual quita la valoración
  r ? state.ratings.set(id, r) : state.ratings.delete(id);
  await db.setRating(id, r);
  const bar = main.querySelector(`[data-rating-for="${CSS.escape(id)}"]`);
  if (bar) bar.outerHTML = ratingBar(state.byId.get(id));
}

async function setGameRating(key, n) {
  const r = state.gameRatings.get(key) === n ? 0 : n;
  r ? state.gameRatings.set(key, r) : state.gameRatings.delete(key);
  await db.setGameRating(key, r);
  const title = state.gameIndex.get(key).title;
  main.querySelectorAll(`[data-game-rating-for="${CSS.escape(key)}"]`).forEach((el) => (el.outerHTML = gameRatingBar(title)));
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

// Las fotos de producto no se escalan como pixel art
function openLightbox(src, caption, photo = false) {
  const dlg = $('#lightbox');
  $('#lb-img').src = src;
  $('#lb-img').classList.toggle('photo', photo);
  $('#lb-caption').textContent = caption;
  dlg.showModal();
}

function exportOwned() {
  const data = {
    app: 'evercade-library',
    exportedAt: new Date().toISOString(),
    owned: [...state.owned].map((id) => ({ id, title: state.byId.get(id)?.title, rating: state.ratings.get(id) ?? 0 })),
    completed: [...state.completed],
    gameRatings: Object.fromEntries(state.gameRatings),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${t('export.filename')}-${data.exportedAt.slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importOwned(file) {
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.owned;
    const entries = list.map((e) => (typeof e === 'string' ? { id: e } : e)).filter((e) => state.byId.has(e.id));
    const ids = entries.map((e) => e.id);
    if (!confirm(t('import.confirm', ids.length, state.owned.size))) return;
    const now = new Date().toISOString();
    const rating = (e) => (Number.isInteger(e.rating) && e.rating >= 1 && e.rating <= 5 ? e.rating : 0);
    await db.replaceOwned(entries.map((e) => ({ id: e.id, addedAt: now, rating: rating(e) })));
    state.owned = new Set(ids);
    state.ratings = new Map(entries.filter(rating).map((e) => [e.id, rating(e)]));
    if (Array.isArray(data.completed)) {
      await db.replaceCompleted(data.completed.map((id) => ({ id, completedAt: now })));
      state.completed = new Set(data.completed);
    }
    if (data.gameRatings && typeof data.gameRatings === 'object') {
      const games = Object.entries(data.gameRatings).filter(([k, n]) => state.gameIndex.has(k) && rating({ rating: n }));
      await db.replaceGameRatings(games.map(([id, n]) => ({ id, rating: n })));
      state.gameRatings = new Map(games);
    }
    render();
    toast(t('toast.imported'));
  } catch (err) {
    console.error(err);
    alert(t('import.error'));
  }
}

// ---------- eventos ----------

function bind() {
  let timer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
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
    const star = e.target.closest('[data-rate]');
    if (star) {
      const game = star.closest('[data-game-rating-for]');
      if (game) return setGameRating(game.dataset.gameRatingFor, +star.dataset.rate);
      return setRating(star.closest('[data-rating-for]').dataset.ratingFor, +star.dataset.rate);
    }
    const done = e.target.closest('[data-done]');
    if (done) return toggleDone(done.dataset.done);
    const desc = e.target.closest('.desc');
    if (desc) return desc.classList.toggle('open');
    const shotBtn = e.target.closest('[data-img]');
    if (shotBtn) return openLightbox(shotBtn.dataset.img, shotBtn.dataset.caption, 'photo' in shotBtn.dataset);
    const sub = e.target.closest('[data-unlock-tab]');
    if (sub) {
      state.unlockTab = sub.dataset.unlockTab;
      savePrefs();
      return render();
    }
    const kind = e.target.closest('[data-hw-kind]');
    if (kind) {
      state.hwKind = kind.dataset.hwKind;
      savePrefs();
      return render();
    }
    const go = e.target.closest('[data-goto]');
    if (go) return gotoCart(go.dataset.goto);
    const toggle = e.target.closest('.cart-toggle');
    if (toggle) return toggleExpand(toggle.closest('.cart').dataset.id);
    if (e.target.closest('[data-reset]')) {
      Object.assign(state, { q: '', fOwned: 'all', fLegacy: 'all', fCat: '', hwKind: 'all' });
      $('#q').value = '';
      savePrefs();
      render();
    }
  });

  const dlg = $('#lightbox');
  dlg.addEventListener('click', (e) => (e.target === dlg || e.target.id === 'lb-img' ? dlg.close() : null));

  $('#lang-switch').addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (!b || b.dataset.lang === getLang()) return;
    applyLang(b.dataset.lang);
    savePrefs();
    if (state.carts.length) render();
  });

  $('#export').addEventListener('click', exportOwned);
  $('#import-btn').addEventListener('click', () => $('#import').click());
  $('#import').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) importOwned(f);
    e.target.value = '';
  });
}

// ---------- vídeo destacado ----------

// Uno de los últimos vídeos de la lista de YouTube, al azar en cada carga (si falla o no hay conexión, no se muestra)
async function loadFeaturedVideo() {
  if (!state.showVideo || !navigator.onLine) return;
  try {
    const res = await fetch('api/videos', { cache: 'no-cache' });
    if (!res.ok) return;
    const { videos } = await res.json();
    if (!videos?.length) return;
    const v = videos[Math.floor(Math.random() * videos.length)];
    const box = $('#featured-video');
    box.innerHTML = `<div class="video-frame"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.id)}" title="${esc(v.title)}" loading="lazy" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>`;
    box.hidden = !state.showVideo; // por si se desactivó mientras cargaba
  } catch {}
}

// Al desactivarlo se quita el reproductor (para que deje de sonar); al activarlo se carga otro
function setShowVideo(on) {
  state.showVideo = on;
  savePrefs();
  const box = $('#featured-video');
  if (on) return loadFeaturedVideo();
  box.hidden = true;
  box.innerHTML = '';
}

function bindSettings() {
  const btn = $('#settings-btn');
  const panel = $('#settings-panel');
  const toggle = (open) => {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', open);
  };
  $('#opt-video').checked = state.showVideo;
  btn.addEventListener('click', () => toggle(panel.hidden));
  $('#opt-video').addEventListener('change', (e) => setShowVideo(e.target.checked));
  // Se cierra al pulsar fuera o con Escape
  document.addEventListener('click', (e) => !panel.hidden && !e.target.closest('.settings') && toggle(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) {
      toggle(false);
      btn.focus();
    }
  });
}

// ---------- idioma ----------

function applyLang(lang) {
  setLang(lang);
  state.lang = getLang();
  applyStatic();
  document.querySelectorAll('#lang-switch [data-lang]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.lang === state.lang));
  renderCatalogInfo();
}

function renderCatalogInfo() {
  if (!state.catalogUpdatedAt) return;
  const date = new Date(state.catalogUpdatedAt).toLocaleDateString(t('locale'), { dateStyle: 'long' });
  $('#catalog-info').textContent = t('catalogInfo', date);
}

// ---------- inicio ----------

async function init() {
  loadPrefs();
  applyLang(detectLang(state.lang));
  bind();
  bindSettings();
  loadFeaturedVideo();
  try {
    await loadCatalog();
    await loadOwned();
    await loadUnlockables();
    await loadHardware();
  } catch (err) {
    console.error(err);
    main.innerHTML = `<p class="loading">${esc(err.message)}</p>`;
    return;
  }
  renderCatalogInfo();
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();

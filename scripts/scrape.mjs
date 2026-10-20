// Descarga el catálogo de cartuchos de evercade.co.uk y genera public/data/catalog.json
// Uso: node scripts/scrape.mjs [--images]   (--images descarga portadas y capturas a public/img)
import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://evercade.co.uk';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'data', 'catalog.json');
const IMG_DIR = join(ROOT, 'public', 'img');
const DOWNLOAD_IMAGES = process.argv.includes('--images');
const UA = { 'User-Agent': 'Mozilla/5.0 (EvercadeLibrary scraper)' };
const CATEGORIES = { 294: 'Arcade', 292: 'Console', 293: 'Home Computer' };
// La numeración oficial no está en evercade.co.uk; se toma de la Wikipedia
const WIKI_URL = 'https://en.wikipedia.org/w/index.php?title=List_of_Evercade_games&action=raw';
const WIKI_SECTIONS = [
  ['console', '===Console===', '===Arcade==='],
  ['arcade', '===Arcade===', '===Home computer==='],
  ['computer', '===Home computer===', '=== Other ==='],
];
const NUMBER_PREFIX = { console: '', arcade: 'A', computer: 'C' };
// La web lista algunas ediciones especiales como si fueran juegos: slug -> títulos que no son juegos
const EDITIONS = { 'full-void': ['Full Void Special Edition'] };
// Títulos que no coinciden ni normalizados: slug -> título en la Wikipedia
const WIKI_ALIASES = { 'alwas-awakening-8-bit-edition-cathedral': "Alwa's Awakening & Cathedral" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, opts = {}, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { ...opts, headers: { ...UA, ...opts.headers } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return res;
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(1000 * i);
    }
  }
}

const decode = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function parseGrid(html) {
  const items = [];
  const re = /<a href="https:\/\/evercade\.co\.uk\/cartridges\/([^/"]+)\/" id="[^"]*" class="cartridge-item">([\s\S]*?)<\/a>/g;
  for (const [, slug, body] of html.matchAll(re)) {
    items.push({
      slug,
      title: decode(body.match(/class="cartridge-title">([\s\S]*?)<\/span>/)?.[1] ?? slug),
      cover: body.match(/background-image:\s*url\(([^)]+)\)/)?.[1] ?? null,
      tag: decode(body.match(/class="cartridge-tag">([\s\S]*?)<\/span>/)?.[1] ?? '') || null,
    });
  }
  return items;
}

function parseCartridgePage(html) {
  const games = [];
  // Limita al contenedor de juegos para que el último bloque no incluya el resto de la página (logo del pie, etc.)
  const container = html.split('<div class="games-content-container">')[1]?.split('</section>')[0] ?? '';
  for (const block of container.split('<div class="game-block">').slice(1)) {
    const title = block.match(/class="game-title">([\s\S]*?)<\/span>/)?.[1];
    if (!title) continue;
    games.push({
      title: decode(title),
      image: block.match(/<img[^>]*\ssrc="([^"]+)"/)?.[1] ?? null,
      genre: decode(block.match(/class="genre[^"]*"><strong>[^<]*<\/strong>([\s\S]*?)<\/span>/)?.[1] ?? '') || null,
      players: decode(block.match(/class="players[^"]*"><strong>[^<]*<\/strong>([\s\S]*?)<\/span>/)?.[1] ?? '') || null,
      description: decode(block.match(/<p>([\s\S]*?)<\/p>/)?.[1] ?? '') || null,
    });
  }
  const contentCol = html.match(/class="column content-column">([\s\S]*?)<\/div>/)?.[1] ?? '';
  const paragraphs = [...contentCol.matchAll(/<p(?: class="([^"]*)")?>([\s\S]*?)<\/p>/g)];
  const description = paragraphs.filter((p) => p[1] !== 'bottom').map((p) => decode(p[2])).filter(Boolean).join('\n') || null;
  const note = decode(paragraphs.find((p) => p[1] === 'bottom')?.[2] ?? '') || null;
  return {
    banner: html.match(/class="banner-wrap"[^>]*background-image:\s*url\(([^)]+)\)/)?.[1] ?? null,
    video: html.match(/youtube\.com\/embed\/([\w-]+)/)?.[1] ?? null,
    description,
    note,
    legacyText: /legacy collection/i.test(note ?? '') || /no longer in production/i.test(html),
    games,
  };
}

async function fetchCategories() {
  const bySlug = {};
  for (const [id, name] of Object.entries(CATEGORIES)) {
    const body = new URLSearchParams({ action: 'ajax_load_cartridges', post_type: 'cartridges', sortby: 'title', orderby: 'ASC', category: id });
    const html = await (await get(`${BASE}/wp-admin/admin-ajax.php`, { method: 'POST', body })).text();
    for (const { slug } of parseGrid(html)) (bySlug[slug] ??= []).push(name);
  }
  return bySlug;
}

// Clave para emparejar títulos: sin acentos, signos, "the" inicial, "and"/"&" ni espacios
const titleKey = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/&|\band\b/g, ' ')
    .replace(/^\s*the\s+/, '')
    .replace(/[^a-z0-9]/g, '');

const wikiText = (s) =>
  s
    .replace(/<ref[\s\S]*?(<\/ref>|\/>)/g, '')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/''+/g, '')
    .trim();

// Devuelve slug -> { type, n, label } con el número oficial de cada cartucho
async function fetchNumbers(grid) {
  const txt = await (await get(WIKI_URL)).text();
  const keys = new Map(grid.map((c) => [titleKey(WIKI_ALIASES[c.slug] ?? c.title), c.slug]));
  const numbers = {};
  for (const [type, start, end] of WIKI_SECTIONS) {
    const body = txt.split(start)[1]?.split(end)[0] ?? '';
    for (const row of body.split(/\n\|-\s*\n/)) {
      const m = row.match(/^\|\s*\{\{center\|(\d+)\}\}\s*(?:\|\|([^\n]*)|\s*\n\|([^\n]*))/);
      if (!m) continue;
      const title = wikiText(m[2] ?? m[3]);
      const slug = keys.get(titleKey(title));
      if (!slug) {
        console.warn(`  Sin emparejar en la Wikipedia: ${type} ${m[1]} "${title}"`);
        continue;
      }
      numbers[slug] = { type, n: +m[1], label: NUMBER_PREFIX[type] + m[1].padStart(2, '0') };
    }
  }
  return numbers;
}

async function localImage(url) {
  if (!DOWNLOAD_IMAGES || !url) return url;
  const path = new URL(url).pathname.replace(/^\/wp-content\/uploads\//, '');
  const file = join(IMG_DIR, path);
  try {
    await access(file);
  } catch {
    const buf = Buffer.from(await (await get(url)).arrayBuffer());
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, buf);
  }
  return `img/${path}`;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

async function main() {
  console.log('Descargando listado…');
  const grid = parseGrid(await (await get(`${BASE}/cartridges/`)).text());
  console.log(`${grid.length} cartuchos encontrados`);
  const categories = await fetchCategories();
  let numbers = {};
  try {
    numbers = await fetchNumbers(grid);
  } catch (err) {
    console.warn(`No se pudo obtener la numeración de la Wikipedia: ${err.message}`);
  }

  const cartridges = await mapLimit(grid, 4, async (item, i) => {
    const page = parseCartridgePage(await (await get(`${BASE}/cartridges/${item.slug}/`)).text());
    const legacy = item.tag === 'Legacy' || page.legacyText;
    const tag = item.tag === 'Legacy' ? null : item.tag;
    const isEdition = (g) => (EDITIONS[item.slug] ?? []).includes(g.title);
    const editions = page.games.filter(isEdition).map(({ title, description }) => ({ title, description }));
    const games = await mapLimit(page.games.filter((g) => !isEdition(g)), 4, async (g) => ({ ...g, image: await localImage(g.image) }));
    console.log(`  ${String(i + 1).padStart(3)}. ${item.title} (${games.length} juegos)${legacy ? ' [Legacy]' : ''}`);
    return {
      id: item.slug,
      title: item.title,
      number: numbers[item.slug] ?? null,
      url: `${BASE}/cartridges/${item.slug}/`,
      cover: await localImage(item.cover),
      banner: page.banner,
      video: page.video,
      description: page.description,
      note: page.note,
      legacy,
      tag,
      categories: categories[item.slug] ?? [],
      order: grid.length - i, // el listado oficial está ordenado por lanzamiento, más reciente primero
      editions,
      games,
    };
  });

  const catalog = { source: `${BASE}/cartridges/`, updatedAt: new Date().toISOString(), cartridges };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(catalog, null, 1));
  const totalGames = cartridges.reduce((n, c) => n + c.games.length, 0);
  console.log(`\nGuardado ${OUT}\n${cartridges.length} cartuchos, ${totalGames} juegos, ${cartridges.filter((c) => c.legacy).length} legacy`);
  const unnumbered = cartridges.filter((c) => !c.number);
  if (unnumbered.length) console.warn(`Sin número de cartucho: ${unnumbered.map((c) => c.title).join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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
  const blocks = html.split('<div class="game-block">').slice(1);
  for (const raw of blocks) {
    const block = raw.split('<div class="game-block">')[0];
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

  const cartridges = await mapLimit(grid, 4, async (item, i) => {
    const page = parseCartridgePage(await (await get(`${BASE}/cartridges/${item.slug}/`)).text());
    const legacy = item.tag === 'Legacy' || page.legacyText;
    const tag = item.tag === 'Legacy' ? null : item.tag;
    const games = await mapLimit(page.games, 4, async (g) => ({ ...g, image: await localImage(g.image) }));
    console.log(`  ${String(i + 1).padStart(3)}. ${item.title} (${games.length} juegos)${legacy ? ' [Legacy]' : ''}`);
    return {
      id: item.slug,
      title: item.title,
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
      games,
    };
  });

  const catalog = { source: `${BASE}/cartridges/`, updatedAt: new Date().toISOString(), cartridges };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(catalog, null, 1));
  const totalGames = cartridges.reduce((n, c) => n + c.games.length, 0);
  console.log(`\nGuardado ${OUT}\n${cartridges.length} cartuchos, ${totalGames} juegos, ${cartridges.filter((c) => c.legacy).length} legacy`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Inštalácia OpenAI (ChatGPT) ads measurement pixelu.
 *
 * Pixel má dve časti — dôvod delenia je v `docs/openai-ads-pixel.md`:
 *
 *   1. snippet v téme (`pixel/openai-pixel.liquid`) — tento skript ho vie
 *      zapísať do témy a zavolať z <head> v layout/theme.liquid,
 *   2. custom pixel (`pixel/openai-custom-pixel.js`) — Shopify preň nemá
 *      Admin API, vkladá sa ručne v Settings → Customer events. Skript ho
 *      vypíše s doplneným pixel ID.
 *
 *   node scripts/openai-pixel.mjs cz                  # dry run
 *   node scripts/openai-pixel.mjs cz --apply          # zapíše snippet do témy
 *   node scripts/openai-pixel.mjs cz --print-pixel    # JS na vloženie do admina
 *   node scripts/openai-pixel.mjs cz --remove --apply # odinštaluje snippet
 *
 * Pixel ID sa berie z `--pixel-id <id>`, inak z premennej
 * OPENAI_PIXEL_ID_<KEY> (napr. OPENAI_PIXEL_ID_CZ), inak z OPENAI_PIXEL_ID.
 * V repe žiadne ID nie je — v súboroch je zástupný `__OPENAI_PIXEL_ID__`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { graphql } from '../lib/shopify.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDER = '__OPENAI_PIXEL_ID__';
const SNIPPET_FILE = 'snippets/openai-pixel.liquid';
const LAYOUT_FILE = 'layout/theme.liquid';
const RENDER_TAG = "{%- render 'openai-pixel' -%}";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

const apply = flag('--apply');
const remove = flag('--remove');
const printPixel = flag('--print-pixel');
const themeArg = value('--theme');
const keys = argv.filter((a) => !a.startsWith('--') && a !== themeArg && a !== value('--pixel-id'));
const shops = keys.length ? keys : ['cz'];

function pixelId(key) {
  const id =
    value('--pixel-id') ??
    process.env[`OPENAI_PIXEL_ID_${key.toUpperCase()}`] ??
    process.env.OPENAI_PIXEL_ID;
  if (!id) {
    throw new Error(
      `chýba pixel ID pre "${key}" — nastav OPENAI_PIXEL_ID_${key.toUpperCase()} alebo použi --pixel-id`,
    );
  }
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) throw new Error(`pixel ID "${id}" nevyzerá ako platné ID`);
  return id;
}

const source = (name) => readFileSync(join(ROOT, 'pixel', name), 'utf8');

/** Vloží volanie snippetu čo najvyššie do <head> — pixel má bežať skoro. */
function withRenderTag(layout) {
  if (layout.includes(RENDER_TAG)) return null;

  const viewport = layout.match(/^[ \t]*<meta name="viewport"[^>]*>[ \t]*\r?\n/m);
  const anchor = viewport ? viewport[0] : layout.match(/<head>[ \t]*\r?\n/)?.[0];
  if (!anchor) throw new Error(`v ${LAYOUT_FILE} sa nenašlo, kam vložiť render tag`);

  const indent = (anchor.match(/^[ \t]*/) ?? [''])[0];
  return layout.replace(anchor, `${anchor}\n${indent}${RENDER_TAG}\n`);
}

function withoutRenderTag(layout) {
  const stripped = layout.replace(new RegExp(`\\n?[ \\t]*${RENDER_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*\\r?\\n`), '\n');
  return stripped === layout ? null : stripped;
}

async function mainTheme(key) {
  if (themeArg) return themeArg.startsWith('gid://') ? themeArg : `gid://shopify/OnlineStoreTheme/${themeArg}`;
  const data = await graphql(key, '{ themes(first: 50) { nodes { id name role } } }');
  const main = data.themes.nodes.find((t) => t.role === 'MAIN');
  if (!main) throw new Error(`[${key}] žiadna publikovaná téma`);
  console.log(`  téma: ${main.name} (${main.id.split('/').pop()})`);
  return main.id;
}

const READ = `query($id: ID!, $files: [String!]!) {
  theme(id: $id) {
    files(filenames: $files, first: 10) {
      nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } }
    }
  }
}`;

const UPSERT = `mutation($id: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
  themeFilesUpsert(themeId: $id, files: $files) {
    upsertedThemeFiles { filename }
    userErrors { field message }
  }
}`;

const DELETE = `mutation($id: ID!, $files: [String!]!) {
  themeFilesDelete(themeId: $id, files: $files) {
    deletedThemeFiles { filename }
    userErrors { field message }
  }
}`;

async function run(key) {
  console.log(`\n=== ${key} ===`);
  const id = pixelId(key);
  const themeId = await mainTheme(key);

  const read = await graphql(key, READ, { id: themeId, files: [LAYOUT_FILE, SNIPPET_FILE] });
  const files = new Map(read.theme.files.nodes.map((n) => [n.filename, n.body.content]));
  const layout = files.get(LAYOUT_FILE);
  if (!layout) throw new Error(`[${key}] ${LAYOUT_FILE} sa nedá prečítať`);

  const updates = [];
  const deletes = [];

  if (remove) {
    if (files.has(SNIPPET_FILE)) {
      deletes.push(SNIPPET_FILE);
      console.log(`  − ${SNIPPET_FILE}`);
    } else {
      console.log(`  ${SNIPPET_FILE} v téme nie je`);
    }
    const cleaned = withoutRenderTag(layout);
    if (cleaned) {
      updates.push({ filename: LAYOUT_FILE, body: cleaned });
      console.log(`  − render tag z ${LAYOUT_FILE}`);
    } else {
      console.log(`  render tag v ${LAYOUT_FILE} nie je`);
    }
  } else {
    const wanted = source('openai-pixel.liquid').replaceAll(PLACEHOLDER, id);
    if (files.get(SNIPPET_FILE) === wanted) {
      console.log(`  ${SNIPPET_FILE} je aktuálny`);
    } else {
      updates.push({ filename: SNIPPET_FILE, body: wanted });
      console.log(`  ${files.has(SNIPPET_FILE) ? '~' : '+'} ${SNIPPET_FILE} (pixel ID …${id.slice(-4)})`);
    }

    const patched = withRenderTag(layout);
    if (patched) {
      updates.push({ filename: LAYOUT_FILE, body: patched });
      console.log(`  + ${RENDER_TAG} do <head> v ${LAYOUT_FILE}`);
    } else {
      console.log(`  render tag v ${LAYOUT_FILE} už je`);
    }
  }

  if (printPixel) {
    console.log(`\n--- custom pixel pre Settings → Customer events (${key}) ---`);
    console.log(source('openai-custom-pixel.js').replaceAll(PLACEHOLDER, id));
    console.log('--- koniec ---');
  }

  if (!updates.length && !deletes.length) return;
  if (!apply) return;

  if (updates.length) {
    const res = await graphql(key, UPSERT, {
      id: themeId,
      files: updates.map((u) => ({ filename: u.filename, body: { type: 'TEXT', value: u.body } })),
    });
    const errs = res.themeFilesUpsert.userErrors;
    if (errs.length) throw new Error(`[${key}] upsert: ${JSON.stringify(errs)}`);
    console.log(`  ✓ zapísané: ${res.themeFilesUpsert.upsertedThemeFiles.map((f) => f.filename).join(', ')}`);
  }
  if (deletes.length) {
    const res = await graphql(key, DELETE, { id: themeId, files: deletes });
    const errs = res.themeFilesDelete.userErrors;
    if (errs.length) throw new Error(`[${key}] delete: ${JSON.stringify(errs)}`);
    console.log(`  ✓ zmazané: ${res.themeFilesDelete.deletedThemeFiles.map((f) => f.filename).join(', ')}`);
  }
}

console.log(apply ? '*** APPLY — zapisuje sa do témy ***' : 'dry run — nič sa nezapíše');

let failed = false;
for (const key of shops) {
  try {
    await run(key);
  } catch (err) {
    failed = true;
    console.log(`\n=== ${key} ===\n  ✗ ${err.message}`);
  }
}

if (!apply) console.log('\nDry run hotový. Spusti znova s --apply.');
console.log(
  '\nCustom pixel (košík + checkout) sa cez API nedá vytvoriť — vlož ho ručne:\n' +
    '  Shopify admin → Settings → Customer events → Add custom pixel,\n' +
    '  Permission: „Marketing", Data sale: podľa nastavenia obchodu,\n' +
    '  telo z `node scripts/openai-pixel.mjs <key> --print-pixel`.',
);
process.exit(failed ? 1 : 0);

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
 *   node scripts/openai-pixel.mjs cz                   # dry run
 *   node scripts/openai-pixel.mjs cz --apply           # zapíše snippet do živej témy
 *   node scripts/openai-pixel.mjs cz --all-themes --apply   # do všetkých tém obchodu
 *   node scripts/openai-pixel.mjs cz --check           # je snippet v živej téme?
 *   node scripts/openai-pixel.mjs cz --print-pixel     # JS na vloženie do admina
 *   node scripts/openai-pixel.mjs cz --remove --apply  # odinštaluje snippet
 *
 * Snippet žije v téme, takže **publikovanie inej témy meranie vypne**. Preto
 * `--all-themes` (zapíše ho do všetkých tém obchodu, aby prežil aj rollback)
 * a `--check`, ktorý sa dá púšťať pravidelne — končí s kódom 1, keď v živej
 * téme niečo chýba.
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
const check = flag('--check');
const allThemes = flag('--all-themes');
const printPixel = flag('--print-pixel');
const themeArg = value('--theme');
const idArg = value('--pixel-id');
const mode = check ? 'check' : remove ? 'remove' : 'install';

const keys = argv.filter((a) => !a.startsWith('--') && a !== themeArg && a !== idArg);
const shops = keys.length ? keys : ['cz'];

function pixelId(key, { required = true } = {}) {
  const id = idArg ?? process.env[`OPENAI_PIXEL_ID_${key.toUpperCase()}`] ?? process.env.OPENAI_PIXEL_ID;
  if (!id) {
    if (!required) return null;
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
  const escaped = RENDER_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = layout.replace(new RegExp(`\\n?[ \\t]*${escaped}[ \\t]*\\r?\\n`), '\n');
  return stripped === layout ? null : stripped;
}

async function targetThemes(key) {
  if (themeArg) {
    const id = themeArg.startsWith('gid://') ? themeArg : `gid://shopify/OnlineStoreTheme/${themeArg}`;
    return [{ id, name: themeArg, role: 'ZADANÁ' }];
  }
  const data = await graphql(key, '{ themes(first: 50) { nodes { id name role } } }');
  const themes = data.themes.nodes;
  if (allThemes) return themes;
  const main = themes.find((t) => t.role === 'MAIN');
  if (!main) throw new Error(`[${key}] žiadna publikovaná téma`);
  return [main];
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

/** Vráti true, keď je v tejto téme všetko tak, ako má byť (pre --check). */
async function processTheme(key, theme, wanted) {
  const label = `${theme.name}${theme.role === 'MAIN' ? ' [ŽIVÁ]' : ''}`;
  const read = await graphql(key, READ, { id: theme.id, files: [LAYOUT_FILE, SNIPPET_FILE] });
  const files = new Map(read.theme.files.nodes.map((n) => [n.filename, n.body.content]));
  const layout = files.get(LAYOUT_FILE);
  if (!layout) throw new Error(`[${key}] ${LAYOUT_FILE} sa v téme "${theme.name}" nedá prečítať`);

  const hasSnippet = files.has(SNIPPET_FILE);
  const hasTag = layout.includes(RENDER_TAG);

  if (mode === 'check') {
    const state = !hasSnippet
      ? 'snippet chýba'
      : !hasTag
        ? 'snippet je, ale <head> ho nevolá'
        : wanted && files.get(SNIPPET_FILE) !== wanted
          ? 'snippet je, ale líši sa od repa (iné ID alebo staršia verzia)'
          : 'v poriadku';
    console.log(`  ${state === 'v poriadku' ? '✓' : '✗'} ${label}: ${state}`);
    return state === 'v poriadku';
  }

  const updates = [];
  const deletes = [];

  if (mode === 'remove') {
    if (hasSnippet) deletes.push(SNIPPET_FILE);
    const cleaned = withoutRenderTag(layout);
    if (cleaned) updates.push({ filename: LAYOUT_FILE, body: cleaned });
    console.log(
      `  ${label}: ${[hasSnippet && `− ${SNIPPET_FILE}`, cleaned && '− render tag'].filter(Boolean).join(', ') || 'nič na odstránenie'}`,
    );
  } else {
    if (files.get(SNIPPET_FILE) !== wanted) updates.push({ filename: SNIPPET_FILE, body: wanted });
    const patched = withRenderTag(layout);
    if (patched) updates.push({ filename: LAYOUT_FILE, body: patched });
    console.log(
      `  ${label}: ${
        [
          files.get(SNIPPET_FILE) !== wanted && `${hasSnippet ? '~' : '+'} ${SNIPPET_FILE}`,
          patched && '+ render tag do <head>',
        ]
          .filter(Boolean)
          .join(', ') || 'už je aktuálny'
      }`,
    );
  }

  if (!apply || (!updates.length && !deletes.length)) return true;

  if (updates.length) {
    const res = await graphql(key, UPSERT, {
      id: theme.id,
      files: updates.map((u) => ({ filename: u.filename, body: { type: 'TEXT', value: u.body } })),
    });
    const errs = res.themeFilesUpsert.userErrors;
    if (errs.length) throw new Error(`[${key}] upsert: ${JSON.stringify(errs)}`);
    console.log(`    ✓ zapísané: ${res.themeFilesUpsert.upsertedThemeFiles.map((f) => f.filename).join(', ')}`);
  }
  if (deletes.length) {
    const res = await graphql(key, DELETE, { id: theme.id, files: deletes });
    const errs = res.themeFilesDelete.userErrors;
    if (errs.length) throw new Error(`[${key}] delete: ${JSON.stringify(errs)}`);
    console.log(`    ✓ zmazané: ${res.themeFilesDelete.deletedThemeFiles.map((f) => f.filename).join(', ')}`);
  }
  return true;
}

async function run(key) {
  console.log(`\n=== ${key} ===`);
  const id = pixelId(key, { required: mode === 'install' || printPixel });
  const wanted = id ? source('openai-pixel.liquid').replaceAll(PLACEHOLDER, id) : null;
  const themes = await targetThemes(key);

  let ok = true;
  for (const theme of themes) ok = (await processTheme(key, theme, wanted)) && ok;

  if (printPixel) {
    console.log(`\n--- custom pixel pre Settings → Customer events (${key}) ---`);
    console.log(source('openai-custom-pixel.js').replaceAll(PLACEHOLDER, id));
    console.log('--- koniec ---');
  }
  return ok;
}

console.log(
  mode === 'check'
    ? 'kontrola — nič sa nezapíše'
    : apply
      ? '*** APPLY — zapisuje sa do témy ***'
      : 'dry run — nič sa nezapíše',
);

let failed = false;
for (const key of shops) {
  try {
    if (!(await run(key))) failed = true;
  } catch (err) {
    failed = true;
    console.log(`\n=== ${key} ===\n  ✗ ${err.message}`);
  }
}

if (mode !== 'check' && !apply) console.log('\nDry run hotový. Spusti znova s --apply.');
if (mode === 'install') {
  console.log(
    '\nCustom pixel (košík + checkout) sa cez API nedá vytvoriť — vlož ho ručne:\n' +
      '  Shopify admin → Settings → Customer events → Add custom pixel,\n' +
      '  Permission: „Marketing", Data sale: podľa nastavenia obchodu,\n' +
      '  telo z `node scripts/openai-pixel.mjs <key> --print-pixel`.\n' +
      '\nPo publikovaní novej témy spusti `node scripts/openai-pixel.mjs <key> --check`.',
  );
}
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
/**
 * Opravuje natvrdo zapísaný slovenský text "TY" v sections/main-cart.liquid
 * (ukazovateľ "si tu" nad indikátorom v lište dopravy zdarma). Bol to
 * literálny reťazec mimo prekladového systému, takže sa zobrazoval rovnako
 * vo všetkých jazykoch.
 *
 *   node scripts/fix-cart-you-marker.mjs           # dry run
 *   node scripts/fix-cart-you-marker.mjs --apply
 */

import { graphql } from '../lib/shopify.mjs';

const STORE = 'sk';
const THEME_ID = 'gid://shopify/OnlineStoreTheme/200041136455';
const KEY = 'you_marker';

const WORDS = {
  'sk.json': 'Ty',
  'en.default.json': 'You',
  'fr.json': 'Toi',
  'it.json': 'Tu',
  'es.json': 'Tú',
  'hr.json': 'Ti',
  'de.json': 'Du',
  'bg.json': 'Ти',
  'sl.json': 'Ti',
};

function stripComment(text) {
  let prev;
  do { prev = text; text = text.replace(/^\/\*[\s\S]*?\*\/\s*/, ''); } while (text !== prev);
  return text;
}

const apply = process.argv.includes('--apply');
console.log(apply ? '*** APPLY — zapisuje sa do témy ***\n' : 'dry run — nič sa nezapíše\n');

const filenames = Object.keys(WORDS).map((f) => `locales/${f}`);
filenames.push('sections/main-cart.liquid');

const READ = `query($f: [String!]!) { theme(id: "${THEME_ID}") {
  files(filenames: $f, first: 20) { nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } } } } }`;
const d = await graphql(STORE, READ, { f: filenames });
const byName = new Map(d.theme.files.nodes.map((n) => [n.filename, n.body.content]));

const updates = [];
for (const [file, word] of Object.entries(WORDS)) {
  const raw = byName.get(`locales/${file}`);
  const json = JSON.parse(stripComment(raw));
  if (json.sections?.cart_custom?.[KEY] === word) {
    console.log(`${file}: "${KEY}" už je "${word}" — preskakujem`);
    continue;
  }
  json.sections = json.sections ?? {};
  json.sections.cart_custom = json.sections.cart_custom ?? {};
  json.sections.cart_custom[KEY] = word;
  updates.push({ filename: `locales/${file}`, body: JSON.stringify(json, null, 1) });
  console.log(`${file}: sections.cart_custom.${KEY} = "${word}"`);
}

const liquid = byName.get('sections/main-cart.liquid');
const marker = '<span class="pc-top-ship__ty" id="pc-bar-ty">TY</span>';
const replacement = `<span class="pc-top-ship__ty" id="pc-bar-ty">{{ 'sections.cart_custom.${KEY}' | t }}</span>`;
if (!liquid.includes(marker)) {
  console.log('\n! main-cart.liquid: pôvodný marker sa nenašiel — možno už je opravený');
} else {
  updates.push({ filename: 'sections/main-cart.liquid', body: liquid.replace(marker, replacement) });
  console.log(`\nmain-cart.liquid: natvrdo zapísané "TY" → {{ '...you_marker' | t }}`);
}

if (!apply) { console.log('\nDry run hotový. Spusti znova s --apply.'); process.exit(0); }
if (!updates.length) { console.log('\nNič na zápis.'); process.exit(0); }

const UPSERT = `mutation U($id: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
  themeFilesUpsert(themeId: $id, files: $files) {
    upsertedThemeFiles { filename }
    userErrors { field message }
  }
}`;
const res = await graphql(STORE, UPSERT, {
  id: THEME_ID,
  files: updates.map((u) => ({ filename: u.filename, body: { type: 'TEXT', value: u.body } })),
});
const errs = res.themeFilesUpsert.userErrors;
if (errs.length) { console.log(`✗ ${JSON.stringify(errs)}`); process.exit(1); }
console.log(`\n✓ zapísaných ${res.themeFilesUpsert.upsertedThemeFiles.length} súborov`);

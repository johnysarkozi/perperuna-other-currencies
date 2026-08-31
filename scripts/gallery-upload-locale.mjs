#!/usr/bin/env node
/**
 * Uploads a locale's translated gallery images and points that locale's
 * gallery metafield at them.
 *
 *   node scripts/gallery-upload-locale.mjs sl plan/sl-cubes.json          # dry run
 *   node scripts/gallery-upload-locale.mjs sl plan/sl-cubes.json --apply
 *
 * The plan file says, per product, which file belongs at which gallery
 * position. Anything a position has no file for keeps the Slovak image, which
 * is how the hand-built galleries already treat artwork carrying no text.
 *
 * Each distinct source is uploaded once, however many products show it, so a
 * graphic shared across the range costs one file rather than one per product.
 *
 * Plan format:
 *   {
 *     "locale": "sl",
 *     "products": [
 *       { "handle": "…", "positions": { "2": { "path": "…", "filename": "…" } } }
 *     ]
 *   }
 */

import { graphql } from '../lib/shopify.mjs';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const STORE = 'sk';

const STAGED = `mutation S($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

const FILE_CREATE = `mutation F($files: [FileCreateInput!]!) {
  fileCreate(files: $files) {
    files { id fileStatus alt ... on MediaImage { image { url } } }
    userErrors { field message }
  }
}`;

const FILE_STATUS = `query S($ids: [ID!]!) {
  nodes(ids: $ids) { ... on MediaImage { id fileStatus image { url } } }
}`;

const SET = `mutation M($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } }
}`;

const DEFINITION = `mutation D($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id key }
    userErrors { field message code }
  }
}`;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const [locale, planPath] = args.filter((a) => !a.startsWith('--'));

if (!locale || !planPath) {
  console.error('Usage: gallery-upload-locale.mjs <locale> <plan.json> [--apply]');
  process.exit(1);
}

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
if (plan.locale !== locale) {
  console.error(`Plán je pre jazyk ${plan.locale}, nie ${locale}.`);
  process.exit(1);
}

console.log(apply ? '*** APPLY — writing to Shopify ***\n' : 'dry run — nothing will be written\n');

/** One upload per distinct source, so a shared graphic lands in Files once. */
const sources = new Map();
for (const p of plan.products) {
  for (const slot of Object.values(p.positions)) {
    if (!sources.has(slot.path)) sources.set(slot.path, slot.filename ?? basename(slot.path));
  }
}
console.log(`súborov na nahratie: ${sources.size}`);
for (const p of plan.products) {
  console.log(`   ${p.handle}: ${Object.keys(p.positions).length} pozícií`);
}
console.log();

if (!apply) {
  console.log('Dry run complete. Re-run with --apply.');
  process.exit(0);
}

// The theme reads custom.<locale>_images, so the definition has to exist for
// the metafield to be visible and editable in the admin.
const def = await graphql(STORE, DEFINITION, {
  definition: {
    name: `${locale.toUpperCase()} Images`,
    namespace: 'custom',
    key: `${locale}_images`,
    type: 'list.file_reference',
    ownerType: 'PRODUCT',
    description: `Galéria pre jazyk ${locale}, v rovnakom poradí ako médiá produktu.`,
  },
});
const defErrs = def.metafieldDefinitionCreate.userErrors;
if (defErrs.length && !defErrs.some((e) => e.code === 'TAKEN')) {
  console.log(`! definícia metafieldu: ${JSON.stringify(defErrs)}`);
} else {
  console.log(`definícia custom.${locale}_images: ${defErrs.length ? 'už existuje' : 'vytvorená'}\n`);
}

// ---- upload ---------------------------------------------------------------

const uploaded = new Map();
const entries = [...sources];
const CHUNK = 5;

for (let i = 0; i < entries.length; i += CHUNK) {
  const slice = entries.slice(i, i + CHUNK);

  // Shopify hands out a one-shot upload target per file; the bytes go there,
  // and fileCreate then refers to the target rather than to a public URL.
  const staged = await graphql(STORE, STAGED, {
    input: slice.map(([path, filename]) => ({
      resource: 'FILE',
      filename,
      mimeType: 'image/png',
      httpMethod: 'POST',
      fileSize: String(statSync(path).size),
    })),
  });
  const stagedErrs = staged.stagedUploadsCreate.userErrors;
  if (stagedErrs.length) { console.log(`✗ staged: ${JSON.stringify(stagedErrs)}`); continue; }

  const targets = staged.stagedUploadsCreate.stagedTargets;
  for (const [j, target] of targets.entries()) {
    const [path, filename] = slice[j];
    const form = new FormData();
    for (const { name, value } of target.parameters) form.append(name, value);
    form.append('file', new Blob([readFileSync(path)], { type: 'image/png' }), filename);
    const put = await fetch(target.url, { method: 'POST', body: form });
    if (!put.ok) { console.log(`✗ upload ${filename}: HTTP ${put.status}`); continue; }
  }

  const res = await graphql(STORE, FILE_CREATE, {
    files: targets.map((t, j) => ({
      originalSource: t.resourceUrl,
      contentType: 'IMAGE',
      filename: slice[j][1],
      alt: slice[j][1].replace(/\.[a-z]+$/i, '').replace(/[_-]+/g, ' '),
    })),
  });
  const errs = res.fileCreate.userErrors;
  if (errs.length) { console.log(`✗ fileCreate: ${JSON.stringify(errs)}`); continue; }
  res.fileCreate.files.forEach((f, j) => uploaded.set(slice[j][0], f.id));
  console.log(`nahraté ${Math.min(i + CHUNK, entries.length)}/${entries.length}`);
}

// Shopify processes uploads asynchronously; a file referenced before it is
// READY shows up as a broken image on the storefront.
process.stdout.write('čakám na spracovanie');
const ids = [...uploaded.values()];
for (let attempt = 0; attempt < 40; attempt++) {
  const pending = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await graphql(STORE, FILE_STATUS, { ids: ids.slice(i, i + 50) });
    for (const n of d.nodes) if (n && n.fileStatus !== 'READY') pending.push(n.id);
  }
  if (!pending.length) { console.log(' — hotovo\n'); break; }
  process.stdout.write(`.${pending.length}`);
  await new Promise((r) => setTimeout(r, 3000));
}

// ---- point the galleries at them -------------------------------------------

let writes = 0;
for (const p of plan.products) {
  const d = await graphql(STORE, `query($h: String!) {
    productByHandle(handle: $h) {
      id title
      media(first: 40) { nodes { ... on MediaImage { id } ... on Video { id } } }
    }
  }`, { h: p.handle });
  if (!d.productByHandle) { console.log(`! ${p.handle} neexistuje`); continue; }

  const skIds = d.productByHandle.media.nodes.map((m) => m.id);
  const list = skIds.map((id, i) => {
    const slot = p.positions[String(i + 1)];
    return slot ? uploaded.get(slot.path) ?? id : id;
  });

  const translated = list.filter((id, i) => id !== skIds[i]).length;
  const res = await graphql(STORE, SET, {
    metafields: [{
      ownerId: d.productByHandle.id,
      namespace: 'custom',
      key: `${locale}_images`,
      type: 'list.file_reference',
      value: JSON.stringify(list),
    }],
  });
  const errs = res.metafieldsSet.userErrors;
  if (errs.length) console.log(`✗ ${p.handle}: ${JSON.stringify(errs)}`);
  else { writes++; console.log(`✓ ${d.productByHandle.title} — ${translated}/${list.length} preložených`); }
}

console.log(`\nDone. ${uploaded.size} súborov, ${writes} galérií.`);

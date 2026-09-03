#!/usr/bin/env node
/**
 * Preloží názvy spôsobov dopravy tak, ako sa tie služby v danej krajine
 * reálne volajú — nie doslovným prevodom zo slovenčiny.
 *
 *   node scripts/delivery-names.mjs           # dry run
 *   node scripts/delivery-names.mjs --apply
 *
 * Zákazník vidí názov v jazyku svojho trhu. Angličtina je záloha pre prípad,
 * že si niekto prezerá obchod v inom jazyku, než je jazyk krajiny doručenia.
 *
 * Základný (slovenský) názov sa nemení — je to len to, čo vidno v administrácii.
 */

import { graphql } from '../lib/shopify.mjs';

const STORE = 'sk';

/** Základný názov sadzby → preklady. Kľúč musí sedieť s názvom v Shopify. */
const NAMES = {
  // Rakúsko
  'DPD kuriér': {
    de: 'DPD – Lieferung nach Hause',
    en: 'DPD – home delivery',
  },
  // Slovinsko
  'Pošta PP': {
    sl: 'Pošta Slovenije – prevzem na pošti',
    en: 'Pošta Slovenije – pickup at post office',
  },
  'Kuriér Express One HD': {
    sl: 'Express One – dostava na dom',
    en: 'Express One – home delivery',
  },
  // Chorvátsko — BOX NOW aj Overseas Express Shop sú tam zavedené značky
  'Box Now': {
    hr: 'BOX NOW – paketomat',
    en: 'BOX NOW – parcel locker',
  },
  'Overseas Express PP': {
    hr: 'Overseas Express Shop – preuzimanje',
    en: 'Overseas Express Shop – pickup point',
  },
  'Kuriér overseas express': {
    hr: 'Overseas Express – dostava na kućnu adresu',
    en: 'Overseas Express – home delivery',
  },
  // Taliansko — Punto Poste je názov siete výdajných miest Poste Italiane
  'Pošta': {
    it: 'Poste Italiane – Punto Poste',
    en: 'Poste Italiane – Punto Poste pickup',
  },
  'Pošta kuriér': {
    it: 'Poste Italiane – consegna a domicilio',
    en: 'Poste Italiane – home delivery',
  },
  // Francúzsko — Point Relais je vžitý pojem, nie preklad
  'Mondial Relay': {
    fr: 'Mondial Relay – Point Relais',
    en: 'Mondial Relay – pickup point',
  },
  'Colis Prive kuriér': {
    fr: 'Colis Privé – livraison à domicile',
    en: 'Colis Privé – home delivery',
  },
  // Španielsko
  'MRW PP': {
    es: 'MRW – punto de recogida',
    en: 'MRW – pickup point',
  },
  'MRW HD': {
    es: 'MRW – entrega a domicilio',
    en: 'MRW – home delivery',
  },
};

const apply = process.argv.includes('--apply');
console.log(apply ? '*** APPLY — zapisuje sa do obchodu ***\n' : 'dry run — nič sa nezapíše\n');

const LIST = `query($first:Int!,$after:String){
  translatableResources(resourceType: DELIVERY_METHOD_DEFINITION, first:$first, after:$after){
    pageInfo{ hasNextPage endCursor }
    nodes{ resourceId translatableContent{ key value digest locale } }
  } }`;

const REGISTER = `mutation R($id: ID!, $translations: [TranslationInput!]!) {
  translationsRegister(resourceId: $id, translations: $translations) {
    translations { key locale value }
    userErrors { field message }
  }
}`;

let nodes = [], cursor = null;
do {
  const d = await graphql(STORE, LIST, { first: 50, after: cursor });
  nodes.push(...d.translatableResources.nodes);
  cursor = d.translatableResources.pageInfo.hasNextPage ? d.translatableResources.pageInfo.endCursor : null;
} while (cursor);

console.log(`sadzieb v obchode: ${nodes.length}\n`);

let planned = 0, done = 0, skipped = [];
for (const n of nodes) {
  const nameField = n.translatableContent.find((c) => c.key === 'name');
  if (!nameField) continue;
  const map = NAMES[nameField.value];
  if (!map) { skipped.push(nameField.value); continue; }

  const translations = Object.entries(map).map(([locale, value]) => ({
    key: 'name', locale, value, translatableContentDigest: nameField.digest,
  }));
  planned += translations.length;
  console.log(`${nameField.value}`);
  for (const t of translations) console.log(`   ${t.locale}  ${t.value}`);

  if (!apply) continue;
  const res = await graphql(STORE, REGISTER, { id: n.resourceId, translations });
  const errs = res.translationsRegister.userErrors;
  if (errs.length) console.log(`   ✗ ${JSON.stringify(errs)}`);
  else done += res.translationsRegister.translations.length;
}

console.log(`\n${apply ? `zapísaných ${done}` : `pripravených ${planned}`} prekladov`);
if (skipped.length) {
  console.log(`\nbez prekladu (nie sú v tabuľke): ${[...new Set(skipped)].join(' · ')}`);
}

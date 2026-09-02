#!/usr/bin/env node
/**
 * Založí dopravné zóny a sadzby na eurovom backende.
 *
 *   node scripts/delivery-zones.mjs           # dry run — vypíše, čo by spravil
 *   node scripts/delivery-zones.mjs --apply
 *
 * Vzor je slovenská zóna: výdajné miesto má dve sadzby — platenú do 59,99 €
 * a nulovú od 60 € — kým kuriér je za jednu cenu vždy. Prah 60 € sa preto
 * drží rovnaký vo všetkých krajinách.
 *
 * Slovenské sadzby majú horný strop 299,99 €, čo znamená, že objednávka nad
 * 300 € nedostane žiadnu dopravu. Nové zóny sa robia bez horného stropu.
 */

import { graphql } from '../lib/shopify.mjs';

const STORE = 'sk';
const FREE_FROM = 60.0;          // rovnako ako na Slovensku
const CURRENCY = 'EUR';

/** Zóny na založenie: krajina → sadzby. `pp: true` = dostane aj nulovú sadzbu od 60 €. */
const ZONES = [
  { name: 'Slovenia', country: 'SI', rates: [
    { name: 'Pošta PP', price: 3.90, pp: true },
    { name: 'Kuriér Express One HD', price: 4.90 },
  ] },
  { name: 'Croatia', country: 'HR', rates: [
    { name: 'Box Now', price: 2.90, pp: true },
    { name: 'Overseas Express PP', price: 3.90 },
    { name: 'Kuriér overseas express', price: 4.90 },
  ] },
  { name: 'Italy', country: 'IT', rates: [
    { name: 'Pošta', price: 5.90, pp: true },
    { name: 'Pošta kuriér', price: 6.90 },
  ] },
  { name: 'France', country: 'FR', rates: [
    { name: 'Mondial Relay', price: 4.90, pp: true },
    { name: 'Colis Prive kuriér', price: 9.90 },
  ] },
  { name: 'Spain', country: 'ES', rates: [
    { name: 'MRW PP', price: 5.90, pp: true },
    { name: 'MRW HD', price: 7.90 },
  ] },
];

/** Rakúsko zónu už má — mení sa len názov a cena existujúcej sadzby. */
const AT_ZONE = 'gid://shopify/DeliveryZone/683487002951';
const AT_RENAME = { from: 'Kurier', to: 'DPD kuriér', price: 4.90 };

const money = (amount) => ({ amount, currencyCode: CURRENCY });

/** Sadzba pre výdajné miesto sa delí na platenú do 59,99 € a nulovú od 60 €. */
function methodsFor(rate) {
  const base = {
    name: rate.name,
    active: true,
    rateDefinition: { price: money(rate.price) },
  };
  if (!rate.pp) return [base];
  return [
    { ...base, priceConditionsToCreate: [{ operator: 'LESS_THAN_OR_EQUAL_TO', criteria: money(FREE_FROM - 0.01) }] },
    { name: rate.name, active: true, rateDefinition: { price: money(0) },
      priceConditionsToCreate: [{ operator: 'GREATER_THAN_OR_EQUAL_TO', criteria: money(FREE_FROM) }] },
  ];
}

const apply = process.argv.includes('--apply');
console.log(apply ? '*** APPLY — zapisuje sa do obchodu ***\n' : 'dry run — nič sa nezapíše\n');

const PROFILE = `{ deliveryProfiles(first:5){ nodes { id default
  profileLocationGroups { locationGroup { id }
    locationGroupZones(first:50){ nodes { zone { id name countries { code { countryCode } } }
      methodDefinitions(first:20){ nodes { id name } } } } } } } }`;

const d = await graphql(STORE, PROFILE);
const profile = d.deliveryProfiles.nodes.find((p) => p.default) ?? d.deliveryProfiles.nodes[0];
const group = profile.profileLocationGroups[0];
const existing = new Set(
  group.locationGroupZones.nodes.flatMap((z) => z.zone.countries.map((c) => c.code.countryCode)),
);
console.log(`profil ${profile.id}`);
console.log(`už pokryté krajiny: ${[...existing].sort().join(', ')}\n`);

const zonesToCreate = [];
for (const z of ZONES) {
  if (existing.has(z.country)) { console.log(`! ${z.country} už zónu má — preskakujem`); continue; }
  const methods = z.rates.flatMap(methodsFor);
  zonesToCreate.push({
    name: z.name,
    countries: [{ code: z.country, includeAllProvinces: true }],
    methodDefinitionsToCreate: methods,
  });
  console.log(`${z.country} — ${z.name}`);
  for (const m of methods) {
    const c = m.priceConditionsToCreate?.[0];
    const cond = c ? ` [${c.operator === 'LESS_THAN_OR_EQUAL_TO' ? 'do' : 'od'} ${c.criteria.amount} €]` : '';
    console.log(`   ${String(m.rateDefinition.price.amount).padStart(5)} €  ${m.name}${cond}`);
  }
}

// Rakúsko
const atZone = group.locationGroupZones.nodes.find((z) => z.zone.id === AT_ZONE);
const atMethod = atZone?.methodDefinitions.nodes.find((m) => m.name === AT_RENAME.from);
if (atMethod) {
  console.log(`\nAT — premenovanie sadzby "${AT_RENAME.from}" → "${AT_RENAME.to}" a cena ${AT_RENAME.price} €`);
} else {
  console.log(`\n! AT: sadzba "${AT_RENAME.from}" sa nenašla, Rakúsko nechávam tak`);
}

if (!apply) { console.log('\nDry run hotový. Spusti znova s --apply.'); process.exit(0); }

const UPDATE = `mutation U($id: ID!, $profile: DeliveryProfileInput!) {
  deliveryProfileUpdate(id: $id, profile: $profile) {
    profile { id }
    userErrors { field message }
  }
}`;

if (zonesToCreate.length) {
  const res = await graphql(STORE, UPDATE, {
    id: profile.id,
    profile: { locationGroupsToUpdate: [{ id: group.locationGroup.id, zonesToCreate }] },
  });
  const errs = res.deliveryProfileUpdate.userErrors;
  if (errs.length) { console.log(`✗ zóny: ${JSON.stringify(errs)}`); process.exit(1); }
  console.log(`✓ založených ${zonesToCreate.length} zón`);
}

if (atMethod) {
  const res = await graphql(STORE, UPDATE, {
    id: profile.id,
    profile: { locationGroupsToUpdate: [{ id: group.locationGroup.id, zonesToUpdate: [{
      id: AT_ZONE,
      methodDefinitionsToUpdate: [{
        id: atMethod.id, name: AT_RENAME.to,
        rateDefinition: { price: money(AT_RENAME.price) },
      }],
    }] }] },
  });
  const errs = res.deliveryProfileUpdate.userErrors;
  if (errs.length) console.log(`✗ AT: ${JSON.stringify(errs)}`);
  else console.log(`✓ AT upravené`);
}

console.log('\nHotovo.');

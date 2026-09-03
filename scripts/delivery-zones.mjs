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

/**
 * Zóny, ktoré vznikli skôr a nulovú sadzbu od 60 € nemajú. Doplní sa
 * existujúcej sadzbe strop 59,99 € a vytvorí sa k nej nulová sadzba.
 * Kuriér zostáva za jednu cenu vždy, rovnako ako na Slovensku.
 *
 * DE a BG majú náklad na najlacnejšiu službu (5,77 € / 3,98–4,75 €) blízko
 * SI (5,14 €), preto rovnaký prah 60 € ako lacná skupina.
 */
const FREE_TIER_FOR = {
  DE: ['Hermes PaketShop'],
  BG: ['Офис на Еконт', 'Офис на Спиди', 'Еконтомат'],
};

/**
 * IT/FR/ES majú náklad na najlacnejšiu službu 6,58–7,05 € — draho na to,
 * aby sa dávala zdarma už od 60 €. Prah sa tam zdvíha na 90 €.
 */
const RAISE_THRESHOLD_FOR = { IT: 90.0, FR: 90.0, ES: 90.0 };

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
      methodDefinitions(first:20){ nodes { id name
        rateProvider { ... on DeliveryRateDefinition { price { amount } } }
        methodConditions { id operator conditionCriteria { ... on MoneyV2 { amount } } } } } } } } } } }`;

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

const isFree = (m) => +(m.rateProvider?.price?.amount ?? -1) === 0;

// Doplnenie nulovej sadzby do zón, ktoré vznikli skôr (DE, BG). Pôvodná
// platená sadzba nemá žiadny strop, takže ju treba zároveň obmedziť na
// do 59,99 € — inak by sa pri objednávke nad prahom ukázali obe naraz.
const freeTierWork = [];
for (const [country, methodNames] of Object.entries(FREE_TIER_FOR)) {
  const z = group.locationGroupZones.nodes.find((x) => x.zone.countries.some((c) => c.code.countryCode === country));
  if (!z) { console.log(`\n! ${country}: zóna sa nenašla`); continue; }
  const freeNames = new Set(z.methodDefinitions.nodes.filter(isFree).map((m) => m.name));
  const toCap = [], toCreate = [];
  for (const name of methodNames) {
    const paid = z.methodDefinitions.nodes.find((m) => m.name === name && !isFree(m));
    if (!paid) { console.log(`\n! ${country}: sadzba "${name}" sa nenašla`); continue; }
    if (freeNames.has(name)) { console.log(`\n! ${country}: "${name}" už nulovú sadzbu má — preskakujem`); continue; }
    if (paid.methodConditions.length === 0) {
      toCap.push({ id: paid.id, priceConditionsToCreate: [{ operator: 'LESS_THAN_OR_EQUAL_TO', criteria: money(FREE_FROM - 0.01) }] });
    }
    toCreate.push({ name, active: true, rateDefinition: { price: money(0) },
      priceConditionsToCreate: [{ operator: 'GREATER_THAN_OR_EQUAL_TO', criteria: money(FREE_FROM) }] });
  }
  if (!toCreate.length) continue;
  freeTierWork.push({ zoneId: z.zone.id, toCap, toCreate });
  console.log(`\n${country} — doprava zdarma od ${FREE_FROM} €`);
  for (const name of methodNames) console.log(`   ${name}: do 59.99 € platená, potom 0 €`);
}

// Zdvihnutie prahu 60 € → 90 € na existujúcich zónach (IT, FR, ES)
const raiseWork = [];
for (const [country, newThreshold] of Object.entries(RAISE_THRESHOLD_FOR)) {
  const z = group.locationGroupZones.nodes.find((x) => x.zone.countries.some((c) => c.code.countryCode === country));
  if (!z) { console.log(`\n! ${country}: zóna sa nenašla`); continue; }
  const methodsToUpdate = [];
  for (const m of z.methodDefinitions.nodes) {
    const conditionsToUpdate = [];
    for (const c of m.methodConditions) {
      const at60 = Math.abs(+c.conditionCriteria.amount - (c.operator === 'LESS_THAN_OR_EQUAL_TO' ? FREE_FROM - 0.01 : FREE_FROM)) < 0.02;
      if (!at60) continue;
      const newAmount = c.operator === 'LESS_THAN_OR_EQUAL_TO' ? newThreshold - 0.01 : newThreshold;
      conditionsToUpdate.push({ id: c.id, criteria: newAmount, criteriaUnit: CURRENCY, field: 'TOTAL_PRICE', operator: c.operator });
    }
    if (conditionsToUpdate.length) methodsToUpdate.push({ id: m.id, name: m.name, conditionsToUpdate });
  }
  if (!methodsToUpdate.length) { console.log(`\n! ${country}: podmienky pri 60 € sa nenašli`); continue; }
  raiseWork.push({ zoneId: z.zone.id, methodsToUpdate });
  console.log(`\n${country} — prah 60 € → ${newThreshold} €`);
  for (const m of methodsToUpdate) for (const c of m.conditionsToUpdate)
    console.log(`   ${m.name}: ${c.operator === 'LESS_THAN_OR_EQUAL_TO' ? 'do' : 'od'} ${c.criteria} €`);
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

for (const w of freeTierWork) {
  const res = await graphql(STORE, UPDATE, {
    id: profile.id,
    profile: { locationGroupsToUpdate: [{ id: group.locationGroup.id, zonesToUpdate: [{
      id: w.zoneId,
      methodDefinitionsToUpdate: w.toCap,
      methodDefinitionsToCreate: w.toCreate,
    }] }] },
  });
  const errs = res.deliveryProfileUpdate.userErrors;
  if (errs.length) console.log(`✗ ${w.zoneId}: ${JSON.stringify(errs)}`);
  else console.log(`✓ doprava zdarma pridaná (${w.zoneId})`);
}

for (const w of raiseWork) {
  const res = await graphql(STORE, UPDATE, {
    id: profile.id,
    profile: { locationGroupsToUpdate: [{ id: group.locationGroup.id, zonesToUpdate: [{
      id: w.zoneId,
      methodDefinitionsToUpdate: w.methodsToUpdate.map(({ id, conditionsToUpdate }) => ({ id, conditionsToUpdate })),
    }] }] },
  });
  const errs = res.deliveryProfileUpdate.userErrors;
  if (errs.length) console.log(`✗ ${w.zoneId}: ${JSON.stringify(errs)}`);
  else console.log(`✓ prah zdvihnutý (${w.zoneId})`);
}

console.log('\nHotovo.');

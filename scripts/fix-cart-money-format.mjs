#!/usr/bin/env node
/**
 * Opraví natvrdo zapísanú menu vo košíkovom JS témy (`sections/main-cart.liquid`).
 *
 * Košík vykreslí ceny Liquidom (`| money`, správna mena), ale hneď po načítaní
 * ich JS prepočíta a prepíše vlastným formátovačom `mon()`. Ten mal menu
 * napísanú natvrdo, takže po skopírovaní témy zo SK zostalo v PL/RO/HU
 * v súhrne košíka, na progress baroch a v riadkoch € namiesto lokálnej meny.
 *
 * Skript nahradí `mon()` verziou, ktorá si formát vezme zo `shop.money_format`,
 * čím sa mena už nikdy nerozíde s nastavením obchodu.
 *
 *   node scripts/fix-cart-money-format.mjs            # dry-run, všetky backendy
 *   node scripts/fix-cart-money-format.mjs pl         # dry-run, len PL
 *   node scripts/fix-cart-money-format.mjs pl --apply # zapíše do živej témy
 *
 * Bez `--apply` sa nič nezapisuje. Pri `--apply` sa najprv urobí záložná kópia
 * témy (`ROLLBACK …`), pokiaľ nie je zadané `--no-backup`.
 */

import { graphql, shopKeys } from '../lib/shopify.mjs';

const FILENAME = 'sections/main-cart.liquid';

const SHOP_AND_THEME = `{
  shop { name currencyCode currencyFormats { moneyFormat } }
  themes(first: 20, roles: [MAIN]) { nodes { id name } }
}`;

const THEME_FILE = `query F($id: ID!, $filenames: [String!]) {
  theme(id: $id) {
    files(first: 1, filenames: $filenames) {
      nodes {
        filename
        body {
          ... on OnlineStoreThemeFileBodyText { content }
          ... on OnlineStoreThemeFileBodyUrl { url }
        }
      }
    }
  }
}`;

const UPSERT = `mutation U($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
  themeFilesUpsert(themeId: $themeId, files: $files) {
    upsertedThemeFiles { filename }
    userErrors { filename code message }
  }
}`;

const DUPLICATE = `mutation D($id: ID!, $name: String!) {
  themeDuplicate(id: $id, name: $name) {
    newTheme { id name }
    userErrors { code field message }
  }
}`;

/** Jednoriadkový `function mon(c){ … }` v košíkovom skripte. */
const MON_ONE_LINER = /^([ \t]*)function mon\(c\)\{.*\}[ \t]*$/m;

/** Blok, ktorý tam chceme mať — mena sa berie z nastavení obchodu. */
const FIXED_MON = `/* Formát ceny berieme z nastavení obchodu, nie natvrdo — téma sa kopíruje
   medzi backendmi a natvrdo zapísaná mena tam potom prepíše ceny vykreslené
   Liquidom (PL/RO/HU košík zobrazoval € namiesto lokálnej meny). */
var MONEY_FORMAT = {{ shop.money_format | json }};
function mon(c){
  var amount = c/100;
  return MONEY_FORMAT.replace(/\\{\\{\\s*(\\w+)\\s*\\}\\}/g, function(_match, placeholder){
    var thousands = ',', decimal = '.';
    if (placeholder.indexOf('comma_separator') > -1)                 { thousands = '.';      decimal = ','; }
    else if (placeholder.indexOf('apostrophe_separator') > -1)        { thousands = '\\u0027'; decimal = '.'; }
    else if (placeholder.indexOf('period_and_space_separator') > -1)  { thousands = '\\u00a0'; decimal = '.'; }
    else if (placeholder.indexOf('space_separator') > -1)             { thousands = '\\u00a0'; decimal = ','; }
    var fixed = placeholder.indexOf('no_decimals') > -1 ? String(Math.round(amount)) : amount.toFixed(2);
    var parts = fixed.split('.');
    var whole = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, thousands);
    return parts[1] ? whole + decimal + parts[1] : whole;
  });
}`;

const decodeEscapes = (s) =>
  s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

/** Vytiahne z pôvodného `mon()` menu zapísanú natvrdo, kvôli výpisu. */
function hardcodedCurrency(line) {
  const literals = line.match(/'((?:[^'\\]|\\.)*)'/g) ?? [];
  return literals
    .map((l) => decodeEscapes(l.slice(1, -1)))
    .filter((l) => /[^\d\s.,' ]/.test(l))
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
}

async function readFile(key, themeId) {
  const data = await graphql(key, THEME_FILE, { id: themeId, filenames: [FILENAME] });
  const node = data.theme?.files?.nodes?.[0];
  if (!node) return null;
  if (node.body.content != null) return node.body.content;
  return (await fetch(node.body.url)).text();
}

async function inspect(key) {
  const meta = await graphql(key, SHOP_AND_THEME);
  const theme = meta.themes.nodes[0];
  if (!theme) return { key, status: 'no-theme' };

  const moneyFormat = meta.shop.currencyFormats.moneyFormat;
  const source = await readFile(key, theme.id);
  if (source == null) return { key, theme, moneyFormat, status: 'no-file' };

  if (source.includes('var MONEY_FORMAT')) return { key, theme, moneyFormat, status: 'already-fixed' };

  const match = source.match(MON_ONE_LINER);
  if (!match) return { key, theme, moneyFormat, status: 'mon-not-found' };

  const indent = match[1];
  const patched = source.replace(
    MON_ONE_LINER,
    FIXED_MON.split('\n')
      .map((l) => (l ? indent + l : l))
      .join('\n'),
  );

  return {
    key,
    theme,
    moneyFormat,
    status: 'needs-fix',
    currency: meta.shop.currencyCode,
    oldLine: match[0].trim(),
    hardcoded: hardcodedCurrency(match[0]),
    patched,
  };
}

async function apply(result, { backup }) {
  if (backup) {
    const stamp = new Date().toISOString().slice(0, 10);
    const name = `ROLLBACK ${stamp} – pred opravou meny v košíku`;
    const data = await graphql(result.key, DUPLICATE, { id: result.theme.id, name });
    const errors = data.themeDuplicate.userErrors;
    if (errors.length) throw new Error(`záloha témy zlyhala: ${JSON.stringify(errors)}`);
    console.log(`  záloha: ${data.themeDuplicate.newTheme.name}`);
  }

  const data = await graphql(result.key, UPSERT, {
    themeId: result.theme.id,
    files: [{ filename: FILENAME, body: { type: 'TEXT', value: result.patched } }],
  });
  const errors = data.themeFilesUpsert.userErrors;
  if (errors.length) throw new Error(`zápis zlyhal: ${JSON.stringify(errors)}`);
  console.log(`  zapísané: ${FILENAME}`);
}

const args = process.argv.slice(2);
const applyChanges = args.includes('--apply');
const backup = !args.includes('--no-backup');
const keys = args.filter((a) => !a.startsWith('--'));
const targets = keys.length ? keys : shopKeys();

console.log(applyChanges ? 'REŽIM: --apply (zapisuje do živej témy)' : 'REŽIM: dry-run (nič sa nezapisuje)');

let failed = false;
for (const key of targets) {
  try {
    const result = await inspect(key);
    switch (result.status) {
      case 'no-theme':
        console.log(`\n[${key}] žiadna publikovaná téma`);
        break;
      case 'no-file':
        console.log(`\n[${key}] ${result.theme.name}: ${FILENAME} v téme nie je`);
        break;
      case 'already-fixed':
        console.log(`\n[${key}] ${result.theme.name}: mena sa už berie zo shop.money_format — netreba nič`);
        break;
      case 'mon-not-found':
        console.log(`\n[${key}] ${result.theme.name}: funkcia mon() sa nenašla — skontroluj ručne`);
        failed = true;
        break;
      case 'needs-fix': {
        const mismatch = result.hardcoded && !result.moneyFormat.includes(result.hardcoded);
        console.log(`\n[${key}] ${result.theme.name}`);
        console.log(`  mena obchodu:    ${result.currency}  (${result.moneyFormat})`);
        console.log(`  natvrdo v mon(): ${result.hardcoded || '—'}${mismatch ? '   ← NESÚHLASÍ' : ''}`);
        console.log(`  pôvodne: ${result.oldLine}`);
        if (applyChanges) await apply(result, { backup });
        else console.log('  dry-run: mon() by sa nahradilo formátovačom zo shop.money_format');
        break;
      }
    }
  } catch (error) {
    failed = true;
    console.log(`\n[${key}] CHYBA: ${error.message}`);
  }
}

process.exit(failed ? 1 : 0);

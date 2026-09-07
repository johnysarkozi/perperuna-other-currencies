/**
 * OpenAI (ChatGPT) ads — measurement pixel, checkoutová časť.
 *
 * Vlož do Shopify: Settings → Customer events → Add custom pixel.
 * Zdroj je `pixel/openai-custom-pixel.js` v repe perperuna-other-currencies;
 * `node scripts/openai-pixel.mjs cz --print-pixel` ho vypíše s doplneným
 * pixel ID, pripravený na vloženie.
 *
 * Doplnok k snippetu v téme (`pixel/openai-pixel.liquid`). Delenie eventov je
 * podľa toho, kde sa dajú zachytiť, a nikde sa neprekrýva:
 *
 *   téma          page_viewed, contents_viewed
 *   tu            items_added, checkout_started, order_created
 *
 * Custom pixel beží v „lax" sandboxe (iframe), takže nevidí URL vrchného rámca
 * ani jeho cookies. `oppref` z pristávacej URL preto zbiera snippet v téme;
 * priradenie objednávky sa tu opiera hlavne o advanced matching z checkoutu.
 *
 * Sumy: web pixel API dáva ceny v hlavných jednotkách ("349.00"), OpenAI chce
 * `amount` ako celé číslo v minor units — preto ×100 a zaokrúhlenie.
 */

var PIXEL_ID = '__OPENAI_PIXEL_ID__';

(function (w, d, s, u) {
  if (w.oaiq) return;
  var q = function () { q.q.push(arguments); };
  q.q = [];
  w.oaiq = q;
  var js = d.createElement(s);
  js.async = true;
  js.src = u;
  var f = d.getElementsByTagName(s)[0];
  f.parentNode.insertBefore(js, f);
})(window, document, 'script', 'https://bzrcdn.openai.com/sdk/oaiq.min.js');

oaiq('consent', false);
oaiq('init', { pixelId: PIXEL_ID });

/* ---- súhlas ------------------------------------------------------------- */

var privacy = init.customerPrivacy;
var consented = false;
var pending = [];

function marketingAllowed() {
  return !!(privacy && privacy.marketingAllowed);
}

function flush() {
  if (!consented) return;
  var queued = pending;
  pending = [];
  queued.forEach(function (fn) { fn(); });
}

function applyConsent() {
  if (consented || !marketingAllowed()) return;
  consented = true;
  oaiq('consent', true);
  flush();
}

/* Eventy, ktoré prídu pred udelením súhlasu, si podržíme — pixel zablokované
   eventy neprehráva, takže by inak zmizli (napr. objednávka dokončená skôr,
   ako návštevník klikne v lište). */
function measure(fn) {
  if (consented) fn();
  else pending.push(fn);
}

api.customerPrivacy.subscribe('visitorConsentCollected', function (event) {
  privacy = event.customerPrivacy;
  applyConsent();
});

applyConsent();

/* ---- pomocné ------------------------------------------------------------ */

var PUNCT = /[\s!-\/:-@[-`{-~]/g;

function minor(money) {
  var amount = money && money.amount;
  if (amount === null || amount === undefined || amount === '') return undefined;
  return Math.round(Number(amount) * 100);
}

function sha256(value) {
  if (!value || !window.crypto || !window.crypto.subtle) return Promise.resolve(null);
  return window.crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(value))
    .then(function (buf) {
      return Array.prototype.map
        .call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); })
        .join('');
    })
    .catch(function () { return null; });
}

function itemsFrom(lineItems) {
  return (lineItems || []).map(function (line) {
    var variant = line.variant || {};
    var product = variant.product || {};
    return {
      id: String(variant.sku || variant.id || product.id || ''),
      name: product.title || variant.title || '',
      content_type: 'product',
      quantity: line.quantity || 1
    };
  });
}

/* Advanced matching z checkoutu. Normalizácia podľa
   https://developers.openai.com/ads/measurement-pixel — hashuje sa v
   prehliadači, OpenAI nikdy nedostane čitateľnú hodnotu. */
function identify(checkout) {
  var address = checkout.shippingAddress || checkout.billingAddress || {};
  var email = String(checkout.email || '').trim().toLowerCase();
  var phone = String(checkout.phone || address.phone || '')
    .replace(/[\s().-]/g, '')
    .replace(/^\+/, '')
    .replace(/^0+/, '');
  if (!/^\d{8,15}$/.test(phone)) phone = '';
  var first = String(address.firstName || '').toLowerCase().replace(PUNCT, '');
  var last = String(address.lastName || '').toLowerCase().replace(PUNCT, '');

  return Promise.all([sha256(email), sha256(phone), sha256(first), sha256(last)]).then(function (h) {
    var user = {
      country: address.countryCode || '',
      city: address.city || '',
      region: address.province || '',
      postal_code: address.zip || ''
    };
    if (h[0]) user.email_sha256 = h[0];
    if (h[1]) user.phone_number_sha256 = h[1];
    if (h[2]) user.first_name_sha256 = h[2];
    if (h[3]) user.last_name_sha256 = h[3];
    Object.keys(user).forEach(function (k) { if (!user[k]) delete user[k]; });
    if (Object.keys(user).length) oaiq('init', { pixelId: PIXEL_ID, user: user });
  });
}

/* ---- eventy ------------------------------------------------------------- */

analytics.subscribe('product_added_to_cart', function (event) {
  var line = event.data.cartLine;
  if (!line) return;
  var variant = line.merchandise || {};
  var product = variant.product || {};
  var total = line.cost && line.cost.totalAmount;

  measure(function () {
    oaiq('measure', 'items_added', {
      type: 'contents',
      amount: minor(total),
      currency: total && total.currencyCode,
      contents: [{
        id: String(variant.sku || variant.id || product.id || ''),
        name: product.title || variant.title || '',
        content_type: 'product',
        quantity: line.quantity || 1,
        amount: minor(variant.price),
        currency: (variant.price && variant.price.currencyCode) || (total && total.currencyCode)
      }]
    });
  });
});

analytics.subscribe('checkout_started', function (event) {
  var checkout = event.data.checkout;
  if (!checkout) return;

  measure(function () {
    oaiq(
      'measure',
      'checkout_started',
      {
        type: 'contents',
        amount: minor(checkout.totalPrice),
        currency: checkout.currencyCode,
        contents: itemsFrom(checkout.lineItems)
      },
      checkout.token ? { event_id: 'checkout_' + checkout.token } : undefined
    );
  });
});

analytics.subscribe('checkout_completed', function (event) {
  var checkout = event.data.checkout;
  if (!checkout) return;
  var orderId = (checkout.order && checkout.order.id) || checkout.token;

  measure(function () {
    /* `user` je request-scoped, takže identitu treba poslať initom pred
       samotným eventom. `event_id` = ID objednávky, aby sa event zdedupoval
       s prípadným neskorším server-side (Conversions API) odoslaním. */
    identify(checkout).then(function () {
      oaiq(
        'measure',
        'order_created',
        {
          type: 'contents',
          amount: minor(checkout.totalPrice),
          currency: checkout.currencyCode,
          contents: itemsFrom(checkout.lineItems)
        },
        orderId ? { event_id: 'order_' + orderId } : undefined
      );
    });
  });
});

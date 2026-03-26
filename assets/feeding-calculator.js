/**
 * Pawcredible Feeding Calculator — vanilla JS, config-driven + Shopify product Ajax.
 */
(function () {
  'use strict';

  function getRoot() {
    if (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) {
      return window.Shopify.routes.root;
    }
    return '/';
  }

  function formatMoney(cents, moneyFormat) {
    if (typeof cents !== 'number' || isNaN(cents)) return '';
    var amount = (cents / 100).toFixed(2);
    if (moneyFormat && moneyFormat.indexOf('amount') !== -1) {
      return moneyFormat.replace(/\{\{\s*amount\s*\}\}/, amount).replace(/\{\{\s*amount_no_decimals\s*\}\}/, String(Math.round(cents / 100)));
    }
    return amount;
  }

  function findBracket(rows, weight) {
    if (!rows || !rows.length) return null;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (weight >= r.from && weight < r.to) return r;
    }
    var last = rows[rows.length - 1];
    if (weight >= last.from) return last;
    return rows[0];
  }

  function feedingRowsForWeight(weight, cfg) {
    if (weight < 1) return findBracket(cfg.feedingMini, 1);
    if (weight < 10) return findBracket(cfg.feedingMini, weight);
    if (weight < 30) return findBracket(cfg.feedingMedium, weight);
    return findBracket(cfg.feedingLarge, weight);
  }

  function dailyGrams(row, position) {
    if (!row) return null;
    if (position === 'low') return row.low;
    if (position === 'high') return row.high;
    return Math.round((row.low + row.high) / 2);
  }

  function recommendPack(needKg, cfg) {
    var threshold = cfg.shortfallKgThreshold != null ? cfg.shortfallKgThreshold : 1;
    var kgPer = cfg.kgPerBag;
    var packDefs = cfg.packs;
    var lastIndex = packDefs.length - 1;

    for (var i = 0; i < packDefs.length; i++) {
      var def = packDefs[i];
      var bags = def.bags;
      var foodKg = bags * kgPer;
      var gap = needKg - foodKg;

      if (i === lastIndex && gap > threshold) {
        bags = Math.max(bags, Math.ceil(needKg / kgPer));
        foodKg = bags * kgPer;
        gap = needKg - foodKg;
        var extraOpt = gap > 0 && gap <= threshold;
        return {
          packDef: def,
          bags: bags,
          foodKg: foodKg,
          optionalExtraBag: extraOpt,
          shortfallKg: gap > 0 ? gap : 0,
          bumpedBags: bags > def.bags,
        };
      }

      if (gap <= 0) {
        return {
          packDef: def,
          bags: bags,
          foodKg: foodKg,
          optionalExtraBag: false,
          shortfallKg: 0,
          bumpedBags: false,
        };
      }
      if (gap > 0 && gap <= threshold) {
        return {
          packDef: def,
          bags: bags,
          foodKg: foodKg,
          optionalExtraBag: true,
          shortfallKg: gap,
          bumpedBags: false,
        };
      }
    }

    var fallback = packDefs[lastIndex];
    var b = Math.max(fallback.bags, Math.ceil(needKg / kgPer));
    return {
      packDef: fallback,
      bags: b,
      foodKg: b * kgPer,
      optionalExtraBag: false,
      shortfallKg: 0,
      bumpedBags: b > fallback.bags,
    };
  }

  /** Digits + at most one decimal point (for weight kg field). */
  function filterWeightInputRaw(s) {
    var out = '';
    var dot = false;
    var i;
    for (i = 0; i < String(s || '').length; i++) {
      var c = String(s)[i];
      if (c >= '0' && c <= '9') {
        out += c;
        continue;
      }
      if (c === '.' && !dot) {
        out += '.';
        dot = true;
      }
    }
    return out;
  }

  function mergeConfig(base, componentHandles, sellingPlanIdAttr) {
    var out = JSON.parse(JSON.stringify(base));
    if (!out.componentHandles) out.componentHandles = { food: '', topper: '', treat: '' };
    if (componentHandles.food) out.componentHandles.food = componentHandles.food;
    if (componentHandles.topper) out.componentHandles.topper = componentHandles.topper;
    if (componentHandles.treat) out.componentHandles.treat = componentHandles.treat;
    if (sellingPlanIdAttr && String(sellingPlanIdAttr).trim()) {
      var sp = parseInt(String(sellingPlanIdAttr).trim(), 10);
      if (!isNaN(sp)) out.sellingPlanId = sp;
    }
    return out;
  }

  function firstVariantId(product) {
    if (!product || !product.variants || !product.variants.length) return null;
    var vs = product.variants;
    for (var i = 0; i < vs.length; i++) {
      if (vs[i].available) return vs[i].id;
    }
    return vs[0].id;
  }

  function getVariantById(product, variantId) {
    if (!product || !product.variants || variantId == null) return null;
    var want = Number(variantId);
    for (var i = 0; i < product.variants.length; i++) {
      if (Number(product.variants[i].id) === want) return product.variants[i];
    }
    return null;
  }

  /**
   * Plan IDs from product JSON only — no fallback to theme ID when this variant has no allocations.
   * Used when every line must be a subscription (food + topper + treat).
   */
  function resolveSellingPlanForVariantOrNull(product, variantId, preferredRaw) {
    var preferred = parseSellingPlanId(preferredRaw);
    var v = getVariantById(product, variantId);
    if (!v || !v.selling_plan_allocations || !v.selling_plan_allocations.length) {
      return null;
    }
    var allocs = v.selling_plan_allocations;
    var i;
    if (preferred != null) {
      for (i = 0; i < allocs.length; i++) {
        var sid = allocs[i].selling_plan_id;
        if (sid != null && Number(sid) === Number(preferred)) return preferred;
      }
    }
    var firstId = allocs[0].selling_plan_id;
    return firstId != null ? parseInt(String(firstId), 10) : null;
  }

  /**
   * Theme setting may hold a plan ID from another SKU; Ajax /cart/add.js expects a plan
   * that exists on this variant. Prefer the configured ID when present; otherwise first allocation.
   * If this variant has no selling_plan_allocations, falls back to the theme ID.
   */
  function resolveSellingPlanForVariant(product, variantId, preferredRaw) {
    var fromAlloc = resolveSellingPlanForVariantOrNull(product, variantId, preferredRaw);
    if (fromAlloc != null) return fromAlloc;
    return parseSellingPlanId(preferredRaw);
  }

  /** Three line items: food + topper + treat (quantities from calculator). */
  function buildPackCartItems(rec, packDef, componentMap, sellingPlanId, subscribe) {
    var fid = firstVariantId(componentMap.food);
    var tid = firstVariantId(componentMap.topper);
    var trid = firstVariantId(componentMap.treat);
    if (!fid || !tid || !trid) return null;
    return [
      { id: fid, quantity: rec.bags },
      { id: tid, quantity: packDef.toppers },
      { id: trid, quantity: packDef.treats },
    ];
  }

  function parseSellingPlanId(raw) {
    if (raw == null || raw === '') return null;
    var s = String(raw).trim();
    if (!s) return null;
    var n = parseInt(s, 10);
    return isNaN(n) ? null : n;
  }

  function hasSellingPlanConfigured(cfg) {
    return parseSellingPlanId(cfg.sellingPlanId) != null;
  }

  function cartAddEndpoint() {
    if (window.routes && window.routes.cart_add_url) return window.routes.cart_add_url;
    return '/cart/add.js';
  }

  /** Shopify /cart/add.js returns errors in many shapes; surface them for debugging. */
  function formatCartAddError(data, res) {
    var status = res && res.status ? String(res.status) : '';
    if (data == null) return status ? 'HTTP ' + status : 'Cart request failed';
    if (typeof data === 'string') return data;
    if (typeof data !== 'object') return String(data);
    if (data.description) return String(data.description);
    if (data.message && typeof data.message === 'string' && data.message.trim()) {
      return data.message;
    }
    if (data.error) return String(data.error);
    if (data.errors) {
      var e = data.errors;
      if (typeof e === 'string') return e;
      if (Array.isArray(e)) return e.map(String).join('; ');
      var parts = [];
      Object.keys(e).forEach(function (k) {
        var v = e[k];
        if (Array.isArray(v)) parts.push(k + ': ' + v.join(', '));
        else if (v && typeof v === 'object') parts.push(k + ': ' + JSON.stringify(v));
        else parts.push(k + ': ' + String(v));
      });
      if (parts.length) return parts.join(' ');
    }
    try {
      return JSON.stringify(data);
    } catch (e2) {
      return 'Cart error';
    }
  }

  function isUnhelpfulCartMessage(msg) {
    if (msg == null || typeof msg !== 'string') return true;
    var t = msg.replace(/\s*\(HTTP\s*\d+\)\s*$/i, '').trim().toLowerCase();
    if (t.length < 2) return true;
    if (t === 'cart error' || t === 'error' || t === 'bad request') return true;
    return false;
  }

  function postCartItems(items) {
    return fetch(cartAddEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items: items }),
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (parseErr) {
            throw new Error(
              (text && text.slice(0, 400)) || 'Cart error (invalid response)'
            );
          }
        }
        if (!res.ok) {
          var errMsg = formatCartAddError(data, res);
          if (isUnhelpfulCartMessage(errMsg) && text && String(text).trim()) {
            errMsg =
              (errMsg && errMsg.trim() ? errMsg + ' — ' : '') +
              String(text).slice(0, 600);
          }
          var st = res.status;
          if (
            st &&
            Number(st) >= 400 &&
            errMsg &&
            errMsg.indexOf(String(st)) === -1
          ) {
            errMsg = errMsg + ' (HTTP ' + st + ')';
          }
          throw new Error(errMsg);
        }
        return data;
      });
    });
  }

  function finishCartAdd(data, el, onDone) {
    try {
      if (typeof publish === 'function') {
        var ev =
          typeof PUB_SUB_EVENTS !== 'undefined' && PUB_SUB_EVENTS.cartUpdate
            ? PUB_SUB_EVENTS.cartUpdate
            : 'cart-update';
        publish(ev, { source: 'feeding-calculator', cartData: data });
      }
    } catch (e) {}
    if (onDone) onDone(data);
    else if (window.routes && window.routes.cart_url) {
      window.location.href = window.routes.cart_url;
    } else {
      window.location.href = '/cart';
    }
  }

  /** Single /cart/add.js request (e.g. one-time three lines). */
  function addItemsToCart(items, el, buttonEl, onDone) {
    if (!items || !items.length) return;
    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.setAttribute('aria-busy', 'true');
    }
    postCartItems(items)
      .then(function (data) {
        finishCartAdd(data, el, onDone);
      })
      .catch(function (err) {
        var detail = err && err.message ? String(err.message) : '';
        alert(
          detail ||
            el.getAttribute('data-msg-cart-error') ||
            'Could not add items to cart. Check products and subscription plan.'
        );
      })
      .finally(function () {
        if (buttonEl) {
          buttonEl.disabled = false;
          buttonEl.removeAttribute('aria-busy');
        }
      });
  }

  /**
   * Line-items + subscription: add food, topper, and treat in one request, each with the
   * selling_plan_id that exists on that variant (IDs often differ per product in Shopify).
   * Requires each product to be in the subscription plan in Admin; otherwise we alert.
   */
  function addLineItemsSubscribeThenRest(items, sellingPlanId, el, buttonEl, componentMap) {
    var keys = ['food', 'topper', 'treat'];
    if (!items || items.length < 1) {
      addItemsToCart(items, el, buttonEl, null);
      return;
    }
    var lines = [];
    var missingTitles = [];
    for (var i = 0; i < items.length; i++) {
      var key = keys[i];
      var prod = componentMap && key ? componentMap[key] : null;
      var sid = prod ? resolveSellingPlanForVariantOrNull(prod, items[i].id, sellingPlanId) : null;
      if (sid == null) {
        var title = prod && prod.title ? prod.title : key;
        missingTitles.push(title);
      } else {
        lines.push(Object.assign({}, items[i], { selling_plan: sid }));
      }
    }
    if (missingTitles.length) {
      alert(
        'Subscription is not set up for: ' +
          missingTitles.join(', ') +
          '. In Shopify Admin, add each product to the same subscription selling plan as your main food (Seal / Subscriptions app). You do not need duplicate products — enable subscription on the existing topper and treat SKUs.'
      );
      return;
    }
    addItemsToCart(lines, el, buttonEl, null);
  }

  function fetchProductJson(handle) {
    if (!handle || !String(handle).trim()) return Promise.resolve(null);
    var url = getRoot() + 'products/' + encodeURIComponent(handle.trim()) + '.js';
    return fetch(url)
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .catch(function () {
        return null;
      });
  }

  /** Same variant logic as firstVariantId — variants[0] is not always the purchasable price. */
  function firstVariantForPrice(product) {
    if (!product || !product.variants || !product.variants.length) return null;
    var vs = product.variants;
    for (var i = 0; i < vs.length; i++) {
      if (vs[i].available) return vs[i];
    }
    return vs[0];
  }

  /**
   * Shopify Ajax product JSON: `price` may be a decimal string ("64.99") OR integer minor units (6499).
   * selling_plan_allocations[].price is usually integer pence/cents (e.g. 5849).
   */
  function parseShopifyMoneyToCents(raw) {
    if (raw == null || raw === '') return null;
    var s = String(raw).replace(/,/g, '').trim();
    if (/\./.test(s)) {
      var p = parseFloat(s);
      if (isNaN(p)) return null;
      return Math.round(p * 100);
    }
    var n = parseInt(s, 10);
    if (isNaN(n)) return null;
    return n;
  }

  /** One-time / default variant price (minor units). */
  function variantPriceCents(product) {
    var v = firstVariantForPrice(product);
    if (!v) return null;
    return parseShopifyMoneyToCents(v.price);
  }

  function allocationPriceCentsForPlan(variant, sellingPlanId) {
    if (!variant || !variant.selling_plan_allocations || !variant.selling_plan_allocations.length) {
      return null;
    }
    var want = parseSellingPlanId(sellingPlanId);
    var allocs = variant.selling_plan_allocations;
    var i;
    if (want != null) {
      for (i = 0; i < allocs.length; i++) {
        if (Number(allocs[i].selling_plan_id) === Number(want)) {
          var raw = allocs[i].price != null ? allocs[i].price : allocs[i].per_delivery_price;
          return parseShopifyMoneyToCents(raw);
        }
      }
    }
    var first = allocs[0];
    var raw0 = first.price != null ? first.price : first.per_delivery_price;
    return parseShopifyMoneyToCents(raw0);
  }

  /** Subscription line price for this product’s variant, matching theme selling plan when possible. */
  function variantSubscriptionPriceCents(product, sellingPlanId) {
    var v = firstVariantForPrice(product);
    if (!v) return null;
    return allocationPriceCentsForPlan(v, sellingPlanId);
  }

  /** Sum food × bags + topper × toppers + treat × treats (one-time catalog prices). */
  function computedLineItemsPackCents(rec, packDef, componentMap) {
    if (!componentMap || !packDef) return null;
    var f = variantPriceCents(componentMap.food);
    var t = variantPriceCents(componentMap.topper);
    var tr = variantPriceCents(componentMap.treat);
    if (f == null || t == null || tr == null) return null;
    return f * rec.bags + t * packDef.toppers + tr * packDef.treats;
  }

  /**
   * Same quantities, but each line uses selling_plan allocation price when all three resolve.
   * Matches cart subscription totals; returns null if any line lacks an allocation price.
   */
  function computedLineItemsSubscribePackCents(rec, packDef, componentMap, sellingPlanId) {
    if (!componentMap || !packDef || parseSellingPlanId(sellingPlanId) == null) return null;
    var f = variantSubscriptionPriceCents(componentMap.food, sellingPlanId);
    var t = variantSubscriptionPriceCents(componentMap.topper, sellingPlanId);
    var tr = variantSubscriptionPriceCents(componentMap.treat, sellingPlanId);
    if (f == null || t == null || tr == null) return null;
    return f * rec.bags + t * packDef.toppers + tr * packDef.treats;
  }

  /**
   * @returns {{ cents: number, source: 'components'|'fallback' }}
   * Food + topper + treat × quantities (matches /cart/add.js). Falls back to config prices.
   */
  function resolveBasePackPriceCents(rec, packId, cfg, componentMap) {
    if (rec && rec.packDef) {
      var comp = computedLineItemsPackCents(rec, rec.packDef, componentMap);
      if (comp != null) return { cents: comp, source: 'components' };
    }
    var fb = cfg.fallbackPrices && cfg.fallbackPrices[packId];
    if (fb && fb.cents != null) return { cents: fb.cents, source: 'fallback' };
    return { cents: 0, source: 'fallback' };
  }

  function applySubscribeDiscount(cents, discountPercent) {
    if (!discountPercent) return cents;
    return Math.round(cents * (100 - discountPercent) / 100);
  }

  /** When showing all pack cards, use algorithm recommendation for that tier only; else fixed tier sizes. */
  function makeRecForPackTier(packDef, monthlyKg, cfg) {
    var rec = recommendPack(monthlyKg, cfg);
    if (rec.packDef.id === packDef.id) return rec;
    return {
      packDef: packDef,
      bags: packDef.bags,
      foodKg: packDef.bags * cfg.kgPerBag,
      optionalExtraBag: false,
      shortfallKg: 0,
      bumpedBags: false,
    };
  }

  function computeAllPackOptions(cfg, componentMap, monthlyKg, recommendedPackId) {
    var packs = cfg.packs || [];
    var out = [];
    var days = cfg.daysPerMonth || 30;
    var disc = cfg.subscribeDiscountPercent || 0;
    for (var i = 0; i < packs.length; i++) {
      var p = packs[i];
      var rec = makeRecForPackTier(p, monthlyKg, cfg);
      var r = resolveBasePackPriceCents(rec, p.id, cfg, componentMap);
      var cents = r.cents;
      var subLine = computedLineItemsSubscribePackCents(rec, p, componentMap, cfg.sellingPlanId);
      var subCents = subLine != null ? subLine : applySubscribeDiscount(cents, disc);
      out.push({
        id: p.id,
        name: p.name,
        badge: p.badge,
        bags: rec.bags,
        toppers: p.toppers,
        treats: p.treats,
        totalCents: cents,
        subCents: subCents,
        dailyOTP: (cents / 100 / days).toFixed(2),
        dailySub: (subCents / 100 / days).toFixed(2),
        isRecommended: p.id === recommendedPackId,
      });
    }
    return out;
  }

  function filterPopularBreeds(cfg, q) {
    var breeds = cfg.popularBreeds || [];
    var needle = (q || '').toLowerCase();
    if (!needle) return breeds.slice();
    return breeds.filter(function (b) {
      return b.toLowerCase().indexOf(needle) !== -1;
    });
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function tplReplace(str, map) {
    if (str == null) return '';
    var out = String(str);
    Object.keys(map).forEach(function (k) {
      out = out.split(k).join(map[k] != null ? String(map[k]) : '');
    });
    return out;
  }

  function getProductLabels(cfg) {
    var pl = (cfg && cfg.productLabels) || {};
    return {
      food: pl.food || 'BioBowl Fusion',
      topper: pl.topper || 'Raw Fusion Topper',
      treat: pl.treat || 'Raw Fusion Treat',
      foodUnit: pl.foodUnit || 'bags',
      topperUnit: pl.topperUnit || 'tubes',
      treatUnit: pl.treatUnit || 'pouches',
    };
  }

  function parseBenefitsPipe(raw) {
    if (!raw || !String(raw).trim()) {
      return ['Save 10%', 'Never run out', 'Flexible delivery', 'Priority offers'];
    }
    return String(raw)
      .split('|')
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  }

  function loadingPlanHtml(el, progress, subtext) {
    var p = typeof progress === 'number' ? progress : 0;
    var sub =
      subtext ||
      (p < 30
        ? 'Crunching the numbers...'
        : p < 60
          ? 'Calculating daily portions...'
          : p < 85
            ? 'Finding the perfect pack...'
            : 'Almost there!');
    var cid = (el && el.id) ? el.id.replace(/[^a-zA-Z0-9_-]/g, '') : 'fc';
    var clipId = 'fc-clip-' + cid;
    return (
      '<div class="feeding-calculator__loading" role="status" aria-live="polite">' +
      '<div class="feeding-calculator__dog-wrap" aria-hidden="true">' +
      '<svg class="feeding-calculator__dog-svg" viewBox="0 0 120 160" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="' +
      clipId +
      '-g" x1="0%" y1="100%" x2="0%" y2="0%"><stop offset="0%" stop-color="#2d5a3d"/><stop offset="100%" stop-color="#5a9e6f"/></linearGradient></defs>' +
      '<ellipse cx="62" cy="88" rx="46" ry="56" fill="#e8e4df"/>' +
      '<ellipse cx="62" cy="42" rx="28" ry="24" fill="#e8e4df"/>' +
      '<clipPath id="' +
      clipId +
      '"><ellipse cx="62" cy="88" rx="46" ry="56"/><ellipse cx="62" cy="42" rx="28" ry="24"/></clipPath>' +
      '<g clip-path="url(#' +
      clipId +
      ')">' +
      '<rect class="feeding-calculator__dog-fill" x="0" y="0" width="120" height="160" fill="url(#' +
      clipId +
      '-g)"/></g></svg></div>' +
      '<p class="feeding-calculator__loading-title">' +
      escapeHtml(el.getAttribute('data-label-loading-plan') || 'Building your plan...') +
      '</p>' +
      '<p class="feeding-calculator__loading-sub">' +
      escapeHtml(sub) +
      '</p>' +
      '<div class="feeding-calculator__loading-bar-track"><div class="feeding-calculator__loading-bar-fill" style="width:' +
      Math.min(100, p) +
      '%"></div></div></div>'
    );
  }

  function initRoot(el) {
    if (el.getAttribute('data-fc-init') === '1') return;
    el.setAttribute('data-fc-init', '1');
    var configUrl = el.getAttribute('data-config-url');
    if (!configUrl) return;

    var moneyFormat = el.getAttribute('data-money-format') || '{{amount}}';
    var componentHandleAttrs = {
      food: el.getAttribute('data-handle-food') || '',
      topper: el.getAttribute('data-handle-topper') || '',
      treat: el.getAttribute('data-handle-treat') || '',
    };
    var sellingPlanAttr = el.getAttribute('data-selling-plan-id') || '';

    var layout = el.getAttribute('data-layout') || 'inline';
    var openBtn = el.querySelector('[data-feeding-open]');
    var modal = el.querySelector('[data-feeding-modal]');
    var rootPanel = el.querySelector('[data-feeding-panel]');

    function openModal() {
      if (!modal) return;
      modal.hidden = false;
      document.body.classList.add('feeding-calculator-modal-open');
    }

    function closeModal() {
      if (!modal) return;
      modal.hidden = true;
      document.body.classList.remove('feeding-calculator-modal-open');
    }

    if (layout === 'modal' && openBtn && modal) {
      openBtn.addEventListener('click', function () {
        if (typeof el._fcWizardReset === 'function') el._fcWizardReset();
        openModal();
      });
      el.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('[data-feeding-close]')) closeModal();
      });
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeModal();
      });
    }

    fetch(configUrl)
      .then(function (r) {
        return r.json();
      })
      .then(function (cfg) {
        cfg = mergeConfig(cfg, componentHandleAttrs, sellingPlanAttr);
        var ch = cfg.componentHandles || {};
        return Promise.all([
          cfg,
          fetchProductJson(ch.food),
          fetchProductJson(ch.topper),
          fetchProductJson(ch.treat),
        ]);
      })
      .then(function (results) {
        var cfg = results[0];
        var componentMap = {
          food: results[1],
          topper: results[2],
          treat: results[3],
        };
        mount(el, cfg, componentMap, moneyFormat);
      })
      .catch(function () {
        var err = el.querySelector('[data-feeding-error]');
        if (err) err.hidden = false;
      });
  }

  function mount(el, cfg, componentMap, moneyFormat) {
    var panel = el.querySelector('[data-feeding-panel]');
    if (!panel) return;

    var layout = el.getAttribute('data-layout') || 'inline';
    var days = cfg.daysPerMonth || 30;

    var state = {
      wizard: layout === 'modal' ? 1 : 'intro',
      loadingProgress: 0,
      loadingTimer: null,
      dogName: '',
      dogBreed: '',
      breedSearch: '',
      breedListOpen: false,
      weight: '',
      activity: '',
      purchase: 'subscribe',
      selectedPackId: null,
      resultCtx: null,
    };

    function formatKgDisplay(w) {
      var n = parseFloat(w);
      if (isNaN(n)) return '';
      var r = Math.round(n * 10) / 10;
      return r % 1 === 0 ? String(Math.round(r)) : String(r);
    }

    function resetWizard() {
      state.wizard = layout === 'modal' ? 1 : 'intro';
      state.loadingProgress = 0;
      state.dogName = '';
      state.dogBreed = '';
      state.breedSearch = '';
      state.breedListOpen = false;
      state.weight = '';
      state.activity = '';
      state.purchase = 'subscribe';
      state.selectedPackId = null;
      state.resultCtx = null;
      if (state.loadingTimer) {
        clearInterval(state.loadingTimer);
        state.loadingTimer = null;
      }
    }

    function wizHeader(stepNum, titleRight) {
      var pct = stepNum <= 4 ? (stepNum / 4) * 100 : 100;
      var label =
        stepNum <= 4
          ? tplReplace(el.getAttribute('data-label-step-counter') || 'Step __N__ of 4', { __N__: String(stepNum) })
          : titleRight || '';
      return (
        '<div class="feeding-calculator__wiz-head">' +
        '<div class="feeding-calculator__wiz-head-row">' +
        '<span class="feeding-calculator__wiz-step">' +
        escapeHtml(label) +
        '</span></div>' +
        '<div class="feeding-calculator__wiz-progress-track" style="--fc-p:' +
        Math.min(100, pct) +
        '%" aria-hidden="true"></div></div>'
      );
    }

    function render() {
      var activityLevels = cfg.activityLevels || [];
      var pl = getProductLabels(cfg);

      if (state.wizard === 'loading') {
        var sub =
          state.loadingProgress < 30
            ? el.getAttribute('data-loading-sub-1') || 'Crunching the numbers...'
            : state.loadingProgress < 60
              ? el.getAttribute('data-loading-sub-2') || 'Calculating daily portions...'
              : state.loadingProgress < 85
                ? el.getAttribute('data-loading-sub-3') || 'Finding the perfect pack...'
                : el.getAttribute('data-loading-sub-4') || 'Almost there!';
        panel.innerHTML =
          '<div class="feeding-calculator__wizard">' +
          wizHeader(4, '') +
          '<div class="feeding-calculator__wiz-body feeding-calculator__wiz-body--loading">' +
          loadingPlanHtml(el, state.loadingProgress, sub) +
          '</div></div>';
        return;
      }

      if (state.wizard === 'intro') {
        panel.innerHTML =
          '<div class="feeding-calculator__intro-card">' +
          '<div class="feeding-calculator__intro-emoji" aria-hidden="true">🐕</div>' +
          '<h2 class="feeding-calculator__title-serif">' +
          escapeHtml(el.getAttribute('data-label-intro-title') || "Build Your Dog's Perfect Meal Plan") +
          '</h2>' +
          '<p class="feeding-calculator__intro-copy">' +
          escapeHtml(
            el.getAttribute('data-label-intro-copy') ||
              'Tell us about your dog and we will create a personalised feeding plan with the right pack, portion size, and daily cost.'
          ) +
          '</p>' +
          '<button type="button" class="feeding-calculator__btn feeding-calculator__btn--pill" data-fc-start>' +
          escapeHtml(el.getAttribute('data-label-start-calc') || 'Start Calculator →') +
          '</button></div>';
        var st = panel.querySelector('[data-fc-start]');
        if (st) {
          st.addEventListener('click', function () {
            state.wizard = 1;
            render();
          });
        }
        return;
      }

      if (state.wizard === 5 && state.resultCtx) {
        renderResults(activityLevels, pl);
        return;
      }

      if (typeof state.wizard === 'number' && state.wizard >= 1 && state.wizard <= 4) {
        renderStep(state.wizard, activityLevels, pl);
        return;
      }

      state.wizard = layout === 'modal' ? 1 : 'intro';
      render();
    }

    function renderStep(step, activityLevels, pl) {
      var dn = state.dogName.trim() || el.getAttribute('data-default-dog-call') || 'your dog';
      var head = wizHeader(step, '');
      var body = '';

      if (step === 1) {
        body =
          '<div class="feeding-calculator__step-icon" aria-hidden="true">🐕</div>' +
          '<h2 class="feeding-calculator__title-serif">' +
          escapeHtml(el.getAttribute('data-label-q-name') || "What's your dog's name?") +
          '</h2>' +
          '<p class="feeding-calculator__step-sub">' +
          escapeHtml(el.getAttribute('data-hint-q-name') || 'We will personalise the feeding plan for them.') +
          '</p>' +
          '<input type="text" class="feeding-calculator__input feeding-calculator__input--wiz" data-fc-name value="' +
          escapeHtml(state.dogName) +
          '" placeholder="' +
          escapeHtml(el.getAttribute('data-placeholder-dog-name') || 'e.g. Bella, Max, Charlie') +
          '" autocomplete="nickname" />' +
          '<button type="button" class="feeding-calculator__btn feeding-calculator__btn--primary feeding-calculator__btn--wiz" data-fc-next ' +
          (!state.dogName.trim() ? 'disabled' : '') +
          '>' +
          escapeHtml(el.getAttribute('data-label-continue') || 'Continue') +
          '</button>';
      } else if (step === 2) {
        var breeds = filterPopularBreeds(cfg, state.breedSearch);
        var listHtml = breeds
          .map(function (b) {
            var sel = state.dogBreed === b ? ' feeding-calculator__breed-row--sel' : '';
            return (
              '<button type="button" class="feeding-calculator__breed-row' +
              sel +
              '" data-breed-pick="' +
              escapeHtml(b) +
              '">' +
              escapeHtml(b) +
              '</button>'
            );
          })
          .join('');
        if (breeds.length === 0 && state.breedSearch.trim()) {
          listHtml =
            '<button type="button" class="feeding-calculator__breed-row feeding-calculator__breed-custom" data-breed-custom>' +
            escapeHtml(
              tplReplace(el.getAttribute('data-label-use-breed') || 'Use "__B__"', {
                __B__: state.breedSearch.trim(),
              })
            ) +
            '</button>';
        }
        body =
          '<div class="feeding-calculator__step-icon" aria-hidden="true">🦴</div>' +
          '<h2 class="feeding-calculator__title-serif">' +
          escapeHtml(
            tplReplace(el.getAttribute('data-label-q-breed') || 'What breed is __NAME__?', { __NAME__: dn })
          ) +
          '</h2>' +
          '<p class="feeding-calculator__step-sub">' +
          escapeHtml(el.getAttribute('data-hint-q-breed') || 'Helps us personalise the experience.') +
          '</p>' +
          '<input type="text" class="feeding-calculator__input feeding-calculator__input--wiz" data-fc-breed-search value="' +
          escapeHtml(state.breedSearch) +
          '" placeholder="' +
          escapeHtml(el.getAttribute('data-placeholder-breed-search') || 'Search breed...') +
          '" />' +
          '<div class="feeding-calculator__breed-list">' +
          listHtml +
          '</div>' +
          '<button type="button" class="feeding-calculator__btn feeding-calculator__btn--primary feeding-calculator__btn--wiz" data-fc-next ' +
          (!state.dogBreed.trim() ? 'disabled' : '') +
          '>' +
          escapeHtml(el.getAttribute('data-label-continue') || 'Continue') +
          '</button>' +
          '<button type="button" class="feeding-calculator__link feeding-calculator__link--back" data-fc-back-step>← ' +
          escapeHtml(el.getAttribute('data-label-back') || 'Back') +
          '</button>';
      } else if (step === 3) {
        var wMin = parseFloat(el.getAttribute('data-weight-min'));
        var wMax = parseFloat(el.getAttribute('data-weight-max'));
        if (isNaN(wMin)) wMin = 0;
        if (isNaN(wMax)) wMax = 100;
        if (wMax < wMin) wMax = wMin;
        body =
          '<div class="feeding-calculator__step-icon" aria-hidden="true">⚖️</div>' +
          '<h2 class="feeding-calculator__title-serif">' +
          escapeHtml(
            tplReplace(el.getAttribute('data-label-q-weight') || 'How much does __NAME__ weigh?', { __NAME__: dn })
          ) +
          '</h2>' +
          '<p class="feeding-calculator__step-sub">' +
          escapeHtml(el.getAttribute('data-hint-weight') || 'An approximate weight is fine.') +
          '</p>' +
          '<div class="feeding-calculator__field-inner">' +
          '<input type="text" inputmode="decimal" class="feeding-calculator__input feeding-calculator__input--wiz" autocomplete="off" spellcheck="false" minlength="0" maxlength="6" data-fc-weight data-weight-min="' +
          wMin +
          '" data-weight-max="' +
          wMax +
          '" value="' +
          escapeHtml(state.weight) +
          '" placeholder="e.g. 25" aria-describedby="fc-weight-hint-' +
          (el.id || 'fc') +
          '" />' +
          '<span class="feeding-calculator__suffix">kg</span></div>' +
          '<p class="visually-hidden" id="fc-weight-hint-' +
          (el.id || 'fc') +
          '">Enter a number between ' +
          wMin +
          ' and ' +
          wMax +
          ' kilograms.</p>' +
          '<button type="button" class="feeding-calculator__btn feeding-calculator__btn--primary feeding-calculator__btn--wiz" data-fc-next ' +
          (function () {
            var _w = parseFloat(filterWeightInputRaw(state.weight));
            return !_w || _w <= 0 || _w > wMax ? 'disabled' : '';
          })() +
          '>' +
          escapeHtml(el.getAttribute('data-label-continue') || 'Continue') +
          '</button>' +
          '<button type="button" class="feeding-calculator__link feeding-calculator__link--back" data-fc-back-step>← ' +
          escapeHtml(el.getAttribute('data-label-back') || 'Back') +
          '</button>';
      } else if (step === 4) {
        var cards = activityLevels
          .map(function (a) {
            var sel = state.activity === a.id;
            var ic = a.icon || '';
            return (
              '<button type="button" class="feeding-calculator__activity-card' +
              (sel ? ' feeding-calculator__activity-card--selected' : '') +
              '" data-activity="' +
              escapeHtml(a.id) +
              '">' +
              '<span class="feeding-calculator__activity-emoji" aria-hidden="true">' +
              ic +
              '</span>' +
              '<span class="feeding-calculator__activity-text">' +
              '<span class="feeding-calculator__activity-title">' +
              escapeHtml(a.label) +
              '</span>' +
              '<span class="feeding-calculator__activity-desc">' +
              escapeHtml(a.description) +
              '</span></span>' +
              (sel ? '<span class="feeding-calculator__activity-check" aria-hidden="true">✓</span>' : '') +
              '</button>'
            );
          })
          .join('');
        body =
          '<div class="feeding-calculator__step-icon" aria-hidden="true">💪</div>' +
          '<h2 class="feeding-calculator__title-serif">' +
          escapeHtml(
            tplReplace(el.getAttribute('data-label-q-activity') || 'How active is __NAME__?', { __NAME__: dn })
          ) +
          '</h2>' +
          '<p class="feeding-calculator__step-sub">' +
          escapeHtml(el.getAttribute('data-hint-q-activity') || 'This determines daily food amount.') +
          '</p>' +
          '<div class="feeding-calculator__activity-stack">' +
          cards +
          '</div>' +
          '<button type="button" class="feeding-calculator__btn feeding-calculator__btn--primary feeding-calculator__btn--wiz" data-fc-see-plan ' +
          (!state.activity ? 'disabled' : '') +
          '>' +
          escapeHtml(
            tplReplace(el.getAttribute('data-label-see-plan-name') || "See __NAME__'s Plan", { __NAME__: dn })
          ) +
          '</button>' +
          '<button type="button" class="feeding-calculator__link feeding-calculator__link--back" data-fc-back-step>← ' +
          escapeHtml(el.getAttribute('data-label-back') || 'Back') +
          '</button>';
      }

      panel.innerHTML =
        '<div class="feeding-calculator__wizard">' + head + '<div class="feeding-calculator__wiz-body">' + body + '</div></div>';

      wireStep(step);
    }

    function wireStep(step) {
      if (step === 1) {
        var n = panel.querySelector('[data-fc-name]');
        var nx = panel.querySelector('[data-fc-next]');
        if (n) {
          n.focus();
          n.addEventListener('input', function () {
            state.dogName = n.value;
            nx.disabled = !state.dogName.trim();
          });
          n.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && state.dogName.trim()) {
              e.preventDefault();
              state.wizard = 2;
              state.breedSearch = state.dogBreed;
              render();
            }
          });
        }
        if (nx) {
          nx.addEventListener('click', function () {
            if (!state.dogName.trim()) return;
            state.wizard = 2;
            state.breedSearch = state.dogBreed;
            render();
          });
        }
      }
      if (step === 2) {
        var bs = panel.querySelector('[data-fc-breed-search]');
        if (bs) {
          bs.addEventListener('input', function () {
            state.breedSearch = bs.value;
            state.breedListOpen = true;
            render();
          });
          bs.addEventListener('focus', function () {
            state.breedListOpen = true;
          });
        }
        panel.querySelectorAll('[data-breed-pick]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            state.dogBreed = btn.getAttribute('data-breed-pick');
            state.breedSearch = state.dogBreed;
            render();
          });
        });
        var cust = panel.querySelector('[data-breed-custom]');
        if (cust) {
          cust.addEventListener('click', function () {
            state.dogBreed = state.breedSearch.trim();
            render();
          });
        }
        var nx2 = panel.querySelector('[data-fc-next]');
        if (nx2) {
          nx2.disabled = !state.dogBreed.trim();
          nx2.addEventListener('click', function () {
            if (!state.dogBreed.trim()) return;
            state.wizard = 3;
            render();
          });
        }
      }
      if (step === 3) {
        var wIn = panel.querySelector('[data-fc-weight]');
        var nx3 = panel.querySelector('[data-fc-next]');
        function weightBoundsFromInput(inp) {
          var mn = parseFloat(inp.getAttribute('data-weight-min'));
          var mx = parseFloat(inp.getAttribute('data-weight-max'));
          return {
            min: isNaN(mn) ? 0 : mn,
            max: isNaN(mx) ? 100 : mx,
          };
        }
        function syncWeightFromField() {
          if (!wIn || !nx3) return;
          var b = weightBoundsFromInput(wIn);
          var raw = filterWeightInputRaw(wIn.value);
          var n = parseFloat(raw);
          if (!isNaN(n) && n > b.max) {
            raw = String(b.max);
            n = b.max;
          }
          wIn.value = raw;
          state.weight = raw;
          nx3.disabled = !n || n <= 0 || n > b.max;
        }
        if (wIn) {
          wIn.focus();
          syncWeightFromField();
          wIn.addEventListener('input', syncWeightFromField);
          wIn.addEventListener('blur', function () {
            if (!wIn || !nx3) return;
            var b = weightBoundsFromInput(wIn);
            var raw = filterWeightInputRaw(wIn.value);
            var n = parseFloat(raw);
            if (isNaN(n) || raw === '') {
              state.weight = raw;
              nx3.disabled = true;
              return;
            }
            if (n < b.min) n = b.min;
            if (n > b.max) n = b.max;
            var out = String(n);
            wIn.value = out;
            state.weight = out;
            nx3.disabled = !n || n <= 0 || n > b.max;
          });
          wIn.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            var b = weightBoundsFromInput(wIn);
            var wf = parseFloat(filterWeightInputRaw(wIn.value));
            if (!wf || wf <= 0 || wf > b.max) return;
            e.preventDefault();
            state.weight = String(wf);
            state.wizard = 4;
            render();
          });
        }
        if (nx3) {
          nx3.addEventListener('click', function () {
            if (!wIn) return;
            var b = weightBoundsFromInput(wIn);
            var wf = parseFloat(filterWeightInputRaw(wIn.value));
            if (!wf || wf <= 0 || wf > b.max) return;
            state.weight = String(wf);
            state.wizard = 4;
            render();
          });
        }
      }
      if (step === 4) {
        panel.querySelectorAll('[data-activity]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            state.activity = btn.getAttribute('data-activity');
            render();
          });
        });
        var sp = panel.querySelector('[data-fc-see-plan]');
        if (sp) {
          sp.addEventListener('click', function () {
            if (!state.activity) return;
            startLoading();
          });
        }
      }
      var backBtns = panel.querySelectorAll('[data-fc-back-step]');
      backBtns.forEach(function (b) {
        b.addEventListener('click', function () {
          if (state.wizard === 5) {
            state.wizard = 4;
            state.resultCtx = null;
          } else if (state.wizard === 1 && layout !== 'modal') {
            state.wizard = 'intro';
          } else if (state.wizard > 1) {
            state.wizard -= 1;
          }
          render();
        });
      });
    }

    function startLoading() {
      state.wizard = 'loading';
      state.loadingProgress = 0;
      render();
      state.loadingTimer = setInterval(function () {
        state.loadingProgress = Math.min(
          100,
          state.loadingProgress + (8 + Math.random() * 12)
        );
        if (state.wizard === 'loading') render();
      }, 280);
      window.setTimeout(function () {
        if (state.loadingTimer) {
          clearInterval(state.loadingTimer);
          state.loadingTimer = null;
        }
        state.loadingProgress = 100;
        var w = parseFloat(state.weight);
        var activityLevels = cfg.activityLevels || [];
        var act = null;
        for (var ai = 0; ai < activityLevels.length; ai++) {
          if (activityLevels[ai].id === state.activity) {
            act = activityLevels[ai];
            break;
          }
        }
        var row = feedingRowsForWeight(w, cfg);
        var grams = dailyGrams(row, act ? act.position : 'mid');
        var monthlyKg = (grams * days) / 1000;
        var rec = recommendPack(monthlyKg, cfg);
        var recommendedPackId = rec.packDef.id;
        state.selectedPackId = recommendedPackId;
        var allPacks = computeAllPackOptions(cfg, componentMap, monthlyKg, recommendedPackId);
        state.resultCtx = {
          w: w,
          grams: grams,
          monthlyKg: monthlyKg,
          rec: rec,
          recommendedPackId: recommendedPackId,
          allPacks: allPacks,
        };
        state.wizard = 5;
        render();
      }, 2800);
    }

    function renderResults(activityLevels, pl) {
      var ctx = state.resultCtx;
      if (!ctx) return;
      var rec = ctx.rec;
      var grams = ctx.grams;
      var monthlyKg = ctx.monthlyKg;
      var w = ctx.w;
      var allPacks = ctx.allPacks;
      var dn = state.dogName.trim() || el.getAttribute('data-default-dog-call') || 'your dog';
      var breedWord =
        state.dogBreed && String(state.dogBreed).trim()
          ? String(state.dogBreed).trim()
          : el.getAttribute('data-default-breed-word') || 'dog';

      var packId = state.selectedPackId || rec.packDef.id;
      var selPackRow = allPacks.filter(function (p) {
        return p.id === packId;
      })[0];
      if (!selPackRow) selPackRow = allPacks[0];

      var dailyCostOneTime = (selPackRow.totalCents / 100 / days).toFixed(2);
      var dailyCostSub = (selPackRow.subCents / 100 / days).toFixed(2);

      var headTitle =
        tplReplace(el.getAttribute('data-label-results-header') || "__NAME__'s Plan", { __NAME__: dn }) ||
        dn + "'s Plan";
      var headHtml =
        '<div class="feeding-calculator__wiz-head feeding-calculator__wiz-head--results">' +
        '<span class="feeding-calculator__wiz-step">' +
        escapeHtml(headTitle) +
        '</span></div>';

      var liFood =
        rec.bags +
        ' × ' +
        cfg.kgPerBag +
        'kg ' +
        pl.food +
        ' bags';
      var liTop = rec.packDef.toppers + ' × ' + pl.topper + ' tubes';
      var liTreat = rec.packDef.treats + ' × ' + pl.treat + ' pouches';

      var packCards = allPacks
        .map(function (pk) {
          var sel = state.selectedPackId === pk.id;
          var priceShown = state.purchase === 'subscribe' ? pk.subCents : pk.totalCents;
          var dailyShown = state.purchase === 'subscribe' ? pk.dailySub : pk.dailyOTP;
          var recBadge = '';
          if (pk.isRecommended) {
            recBadge =
              '<span class="feeding-calculator__pack-badge feeding-calculator__pack-badge--rec">' +
              escapeHtml(
                tplReplace(el.getAttribute('data-badge-recommended') || 'Recommended for __NAME__', {
                  __NAME__: dn,
                })
              ) +
              '</span>';
          }
          var tierBadge = pk.badge
            ? '<span class="feeding-calculator__pack-badge feeding-calculator__pack-badge--tier">' +
              escapeHtml(pk.badge) +
              '</span>'
            : '';
          return (
            '<button type="button" class="feeding-calculator__pack-card' +
            (sel ? ' feeding-calculator__pack-card--selected' : '') +
            '" data-pick-pack="' +
            escapeHtml(pk.id) +
            '">' +
            recBadge +
            tierBadge +
            '<span class="feeding-calculator__pack-radio' +
            (sel ? ' feeding-calculator__pack-radio--on' : '') +
            '"></span>' +
            '<span class="feeding-calculator__pack-main">' +
            '<span class="feeding-calculator__pack-name">' +
            escapeHtml(pk.name) +
            '</span>' +
            '<span class="feeding-calculator__pack-sub">' +
            pk.bags +
            ' BioBowl, ' +
            pk.toppers +
            ' topper' +
            (pk.toppers > 1 ? 's' : '') +
            ', ' +
            pk.treats +
            ' treat' +
            (pk.treats > 1 ? 's' : '') +
            '</span></span>' +
            '<span class="feeding-calculator__pack-prices">' +
            '<span class="feeding-calculator__pack-total">' +
            formatMoney(priceShown, moneyFormat) +
            '</span>' +
            '<span class="feeding-calculator__pack-daily">' +
            formatMoney(Math.round(parseFloat(dailyShown) * 100), moneyFormat) +
            '/' +
            escapeHtml(el.getAttribute('data-label-day') || 'day') +
            '</span></span></button>'
          );
        })
        .join('');

      var benefitPills = parseBenefitsPipe(
        el.getAttribute('data-subscribe-benefits-pills') || el.getAttribute('data-subscribe-benefits')
      );
      var pillsHtml = benefitPills
        .map(function (t) {
          return '<span class="feeding-calculator__pill">' + escapeHtml(t) + '</span>';
        })
        .join('');

      var ctaPrice = state.purchase === 'subscribe' ? selPackRow.subCents : selPackRow.totalCents;
      var ctaLabel =
        state.purchase === 'subscribe'
          ? tplReplace(el.getAttribute('data-label-cta-sub') || 'Start My Monthly Treat Plan – __PRICE__', {
              __PRICE__: formatMoney(ctaPrice, moneyFormat),
              __PACK__: selPackRow.name || '',
            })
          : tplReplace(el.getAttribute('data-label-cta-once') || 'Buy Once – __PRICE__', {
              __PRICE__: formatMoney(ctaPrice, moneyFormat),
              __PACK__: selPackRow.name || '',
            });

      var viewUrl = el.getAttribute('data-view-url') || '';
      if (!viewUrl && componentMap.food && componentMap.food.url) {
        viewUrl = componentMap.food.url;
      }
      var componentsReady = !!(componentMap.food && componentMap.topper && componentMap.treat);

      var purchaseBlock =
        '<div class="feeding-calculator__purchase feeding-calculator__purchase--cards">' +
        '<span class="feeding-calculator__purchase-label">' +
        escapeHtml(el.getAttribute('data-label-purchase') || 'How would you like to buy?') +
        '</span>' +
        '<div class="feeding-calculator__purchase-row" data-fc-subscribe-wrap>' +
        '<button type="button" class="feeding-calculator__purchase-card feeding-calculator__purchase-card--subscribe' +
        (state.purchase === 'subscribe' ? ' feeding-calculator__purchase-card--selected' : '') +
        '" data-purchase="subscribe" aria-pressed="' +
        (state.purchase === 'subscribe' ? 'true' : 'false') +
        '">' +
        '<span class="feeding-calculator__pack-badge feeding-calculator__pack-badge--tier">' +
        escapeHtml(el.getAttribute('data-label-best-value') || 'Best Value') +
        '</span>' +
        '<span class="feeding-calculator__purchase-card-inner">' +
        '<span class="feeding-calculator__p-radio' +
        (state.purchase === 'subscribe' ? ' feeding-calculator__p-radio--on' : '') +
        '"></span>' +
        '<span><strong>' +
        escapeHtml(el.getAttribute('data-label-subscribe') || 'Subscribe & Save') +
        '</strong>' +
        '<span class="feeding-calculator__purchase-sub">' +
        escapeHtml(el.getAttribute('data-label-subscribe-sub') || 'Save 10% + Free delivery') +
        '</span></span></span>' +
        '<span class="feeding-calculator__pill-row feeding-calculator__pill-row--in-subscribe">' +
        pillsHtml +
        '</span></button>' +
        '</div>' +
        '<div class="feeding-calculator__purchase-onetime-wrap">' +
        '<button type="button" class="feeding-calculator__purchase-onetime" data-purchase="onetime" aria-pressed="' +
        (state.purchase === 'onetime' ? 'true' : 'false') +
        '">' +
        '<span class="feeding-calculator__p-radio feeding-calculator__p-radio--onetime' +
        (state.purchase === 'onetime' ? ' feeding-calculator__p-radio--on' : '') +
        '" aria-hidden="true"></span>' +
        '<span class="feeding-calculator__purchase-onetime-label">' +
        escapeHtml(el.getAttribute('data-label-onetime') || 'One-time purchase') +
        '</span></button></div></div>';

      panel.innerHTML =
        '<div class="feeding-calculator__wizard feeding-calculator__wizard--results">' +
        headHtml +
        '<div class="feeding-calculator__wiz-body">' +
        '<div class="feeding-calculator__result-hero">' +
        '<p class="feeding-calculator__result-kicker">' +
        escapeHtml(el.getAttribute('data-label-feeding-plan-for') || 'Feeding plan for') +
        '</p>' +
        '<h2 class="feeding-calculator__result-hero-title">' +
        escapeHtml(dn + "'s Pawcredible Plan 🐾") +
        '</h2>' +
        '<p class="feeding-calculator__result-hero-sub">' +
        escapeHtml(
          tplReplace(
            el.getAttribute('data-msg-based-on-being') || 'Based on __NAME__ being a __W__kg __B__, we recommend:',
            { __NAME__: dn, __W__: formatKgDisplay(w), __B__: breedWord }
          )
        ) +
        '</p>' +
        '<ul class="feeding-calculator__result-lines">' +
        '<li><span aria-hidden="true">🥩</span> ' +
        escapeHtml(liFood) +
        '</li>' +
        '<li><span aria-hidden="true">🥄</span> ' +
        escapeHtml(liTop) +
        '</li>' +
        '<li><span aria-hidden="true">🦴</span> ' +
        escapeHtml(liTreat) +
        '</li></ul></div>' +
        '<div class="feeding-calculator__feeding-guide feeding-calculator__feeding-guide--boxed">' +
        '<div class="feeding-calculator__fg-label">' +
        escapeHtml(el.getAttribute('data-label-feeding-guide') || 'Feeding guide') +
        '</div>' +
        '<div class="feeding-calculator__stats feeding-calculator__stats--flat">' +
        '<div class="feeding-calculator__stat"><span>' +
        escapeHtml(el.getAttribute('data-label-daily-grams') || 'Daily Serving') +
        '</span><strong>' +
        grams +
        'g</strong></div>' +
        '<div class="feeding-calculator__stat"><span>' +
        escapeHtml(el.getAttribute('data-label-monthly') || 'Monthly Need') +
        '</span><strong>' +
        monthlyKg.toFixed(1) +
        ' kg</strong></div></div></div>' +
        '<div class="feeding-calculator__daily feeding-calculator__daily--hero">' +
        '<span class="feeding-calculator__daily-kicker">' +
        escapeHtml(tplReplace(el.getAttribute('data-label-feed-from') || 'Feed __NAME__ from just', { __NAME__: dn })) +
        '</span>' +
        '<strong class="feeding-calculator__daily-hero-amt">' +
        formatMoney(
          Math.round(
            parseFloat(state.purchase === 'subscribe' ? dailyCostSub : dailyCostOneTime) * 100
          ),
          moneyFormat
        ) +
        '</strong><span class="feeding-calculator__daily-hero-unit">/' +
        escapeHtml(el.getAttribute('data-label-day') || 'day') +
        '</span></div>' +
        '<div class="feeding-calculator__choose-pack">' +
        '<span class="feeding-calculator__purchase-label">' +
        escapeHtml(el.getAttribute('data-label-choose-pack') || 'Choose Your Pack') +
        '</span>' +
        '<div class="feeding-calculator__pack-list">' +
        packCards +
        '</div></div>' +
        purchaseBlock +
        '<button type="button" class="feeding-calculator__btn feeding-calculator__btn--cta' +
        (state.purchase === 'onetime' ? ' feeding-calculator__btn--cta-black' : '') +
        '" data-fc-primary-cta ' +
        (!componentsReady ? 'disabled' : '') +
        '>' +
        escapeHtml(ctaLabel) +
        '</button>' +
        '<p class="feeding-calculator__cta-foot">' +
        escapeHtml(
          state.purchase === 'subscribe'
            ? el.getAttribute('data-label-cta-foot-sub') || 'Delivered every 4 weeks. Cancel anytime.'
            : el.getAttribute('data-label-cta-foot-once') || 'One-time delivery. No commitment.'
        ) +
        '</p>' +
        (componentsReady
          ? ''
          : '<p class="feeding-calculator__hint">' +
            escapeHtml(
              el.getAttribute('data-msg-cart-incomplete') ||
                'Connect BioBowl, topper, and treat products to add to cart.'
            ) +
            '</p>') +
        (viewUrl
          ? '<a class="feeding-calculator__btn feeding-calculator__btn--outline feeding-calculator__btn--view" href="' +
            escapeHtml(viewUrl) +
            '">' +
            escapeHtml(el.getAttribute('data-label-view') || 'View product') +
            '</a>'
          : '') +
        '<button type="button" class="feeding-calculator__link feeding-calculator__link--back" data-fc-back-results>← ' +
        escapeHtml(el.getAttribute('data-label-back') || 'Back') +
        '</button>' +
        (layout === 'modal'
          ? '<button type="button" class="feeding-calculator__link" data-feeding-close>' +
            escapeHtml(el.getAttribute('data-label-close') || 'Close') +
            '</button>'
          : '') +
        '</div></div>';

      panel.querySelectorAll('[data-pick-pack]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          state.selectedPackId = btn.getAttribute('data-pick-pack');
          render();
        });
      });
      panel.querySelectorAll('[data-purchase]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          state.purchase = btn.getAttribute('data-purchase');
          render();
        });
      });
      var primary = panel.querySelector('[data-fc-primary-cta]');
      if (primary && componentsReady) {
        primary.addEventListener('click', function () {
          var wantSub2 = state.purchase === 'subscribe';
          var hasPlan2 = hasSellingPlanConfigured(cfg);
          if (wantSub2 && !hasPlan2) {
            alert(
              el.getAttribute('data-hint-subscribe-plan') ||
                'Add a subscription selling plan ID in theme settings to check out with Subscribe & Save from here.'
            );
            return;
          }
          var sub = wantSub2 && hasPlan2;
          var pid = state.selectedPackId || rec.packDef.id;
          var pdef = cfg.packs.filter(function (p) {
            return p.id === pid;
          })[0];
          var recCart = makeRecForPackTier(pdef, monthlyKg, cfg);
          var items = buildPackCartItems(recCart, recCart.packDef, componentMap, cfg.sellingPlanId, sub);
          if (!items) return;
          if (sub) {
            addLineItemsSubscribeThenRest(items, cfg.sellingPlanId, el, primary, componentMap);
          } else {
            addItemsToCart(items, el, primary, null);
          }
        });
      }
      var br = panel.querySelector('[data-fc-back-results]');
      if (br) {
        br.addEventListener('click', function () {
          state.wizard = 4;
          state.resultCtx = null;
          render();
        });
      }
    }

    el._fcWizardReset = function () {
      resetWizard();
      render();
    };
    el._fcRender = render;

    render();
  }

  function boot() {
    document.querySelectorAll('[data-feeding-calculator]').forEach(initRoot);
  }

  if (document.readyState === 'complete') {
    boot();
  } else {
    window.addEventListener('load', boot);
  }
})();

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ── ENV ────────────────────────────────────────────────────────────────────
const KEYSTRING     = Deno.env.get('ETSY_KEYSTRING') ?? '';
const SHARED_SECRET = Deno.env.get('ETSY_SHARED_SECRET') ?? '';
const REDIRECT_URI  = Deno.env.get('ETSY_REDIRECT_URI') ?? '';
const SUPA_URL      = Deno.env.get('SUPABASE_URL') ?? '';
const SUPA_KEY      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CLAUDE_KEY    = Deno.env.get('CLAUDE_API_KEY') ?? '';

const API      = 'https://openapi.etsy.com/v3/application';
const TOKEN_EP = 'https://api.etsy.com/v3/public/oauth/token';
const CONNECT  = 'https://www.etsy.com/oauth/connect';
const SCOPES   = 'listings_r listings_w listings_d shops_r shops_w';

const BUCKET     = 'trendyol';
const TOKEN_PATH = 'etsy/token.json';
const PKCE_PATH  = 'etsy/pkce.json';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function html(body: string, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;text-align:center">${body}</body>`,
    { status, headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

const supa = () => createClient(SUPA_URL, SUPA_KEY);

// ── PKCE ───────────────────────────────────────────────────────────────────
function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function challengeOf(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(hash));
}

// ── STORAGE HELPERS ────────────────────────────────────────────────────────
async function readJson(path: string): Promise<any | null> {
  const { data, error } = await supa().storage.from(BUCKET).download(path);
  if (error || !data) return null;
  try { return JSON.parse(await data.text()); } catch { return null; }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const blob = new Blob([JSON.stringify(value)], { type: 'application/json' });
  await supa().storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: 'application/json' });
}

// ── TOKEN ──────────────────────────────────────────────────────────────────
// token.json: { access_token, refresh_token, expires_at (epoch ms), user_id, shop_id, shop_name }
async function saveTokenResponse(tok: any, prev: any = {}): Promise<any> {
  const record = {
    ...prev,
    access_token:  tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at:    Date.now() + ((tok.expires_in ?? 3600) - 60) * 1000,
    user_id:       String(tok.access_token || '').split('.')[0],
    scope:         tok.scope ?? prev.scope,
  };
  await writeJson(TOKEN_PATH, record);
  return record;
}

async function refreshToken(record: any): Promise<any> {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     KEYSTRING,
    refresh_token: record.refresh_token,
  });
  const res = await fetch(TOKEN_EP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const tok = await res.json();
  if (!tok.access_token) throw new Error('ETSY_REFRESH_FAILED: ' + JSON.stringify(tok));
  return await saveTokenResponse(tok, record);
}

/** Returns a valid token record, refreshing when it is about to expire. */
async function getToken(): Promise<any> {
  const record = await readJson(TOKEN_PATH);
  if (!record?.access_token) throw new Error('NOT_CONNECTED');
  if (Date.now() >= (record.expires_at ?? 0)) return await refreshToken(record);
  return record;
}

function authHeaders(record: any): Record<string, string> {
  return {
    'x-api-key':     `${KEYSTRING}:${SHARED_SECRET}`,
    'Authorization': `Bearer ${record.access_token}`,
  };
}

/** Calls the Etsy API with auth, retrying once after a forced refresh on 401. */
async function etsy(path: string, init: RequestInit = {}, record?: any): Promise<any> {
  let tok = record ?? await getToken();
  const call = () => fetch(API + path, {
    ...init,
    headers: { ...authHeaders(tok), ...(init.headers ?? {}) },
  });

  let res = await call();
  if (res.status === 401) {
    tok = await refreshToken(tok);
    res = await call();
  }

  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(`ETSY_${res.status}: ${data?.error ?? text}`);
  return data;
}

/** Resolves and caches the shop_id for the connected user. */
async function getShopId(record: any): Promise<number> {
  if (record.shop_id && record.currency_code) return record.shop_id;
  const me   = await etsy('/users/me', {}, record);
  const shop = await etsy(`/shops/${me.shop_id}`, {}, record);
  record.shop_id       = me.shop_id;
  record.shop_name     = shop.shop_name;
  record.currency_code = shop.currency_code;
  await writeJson(TOKEN_PATH, record);
  return me.shop_id;
}

// ── LISTING PAYLOAD ────────────────────────────────────────────────────────
const TAG_RE      = /[^\p{L}\p{Nd}\p{Zs}\-'™©®]/gu;
const MATERIAL_RE = /[^\p{L}\p{Nd}\p{Zs}]/gu;

function cleanList(value: unknown, re: RegExp, maxLen: number, maxCount: number): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  return raw
    .map((v) => String(v).replace(re, '').trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, maxCount);
}

function listingForm(item: any): URLSearchParams {
  const form = new URLSearchParams();
  const set = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== '') form.set(k, String(v));
  };

  set('quantity',    Math.max(1, parseInt(item.quantity, 10) || 1));
  set('title',       String(item.title ?? '').slice(0, 140));
  set('description', item.description);
  set('price',       Number(item.price).toFixed(2));
  set('who_made',    item.who_made   || 'i_did');
  set('when_made',   item.when_made  || 'made_to_order');
  set('taxonomy_id', item.taxonomy_id);
  set('is_supply',   item.is_supply ? 'true' : 'false');
  set('type',        'physical');
  set('state',       'draft');

  set('shipping_profile_id', item.shipping_profile_id);
  set('return_policy_id',    item.return_policy_id);
  set('shop_section_id',     item.shop_section_id);
  // Fiziksel ilanlarda Etsy processing_min/max yerine işlem profili istiyor.
  set('readiness_state_id',  item.readiness_state_id);
  set('should_auto_renew',   item.should_auto_renew ? 'true' : 'false');

  const tags      = cleanList(item.tags, TAG_RE, 20, 13);
  const materials = cleanList(item.materials, MATERIAL_RE, 45, 13);
  if (tags.length)      form.set('tags', tags.join(','));
  if (materials.length) form.set('materials', materials.join(','));

  // Dimensions / weight are only accepted together with their unit.
  if (item.item_weight) { set('item_weight', item.item_weight); set('item_weight_unit', item.item_weight_unit || 'g'); }
  const hasDims = item.item_length || item.item_width || item.item_height;
  if (hasDims) {
    set('item_length', item.item_length);
    set('item_width',  item.item_width);
    set('item_height', item.item_height);
    set('item_dimensions_unit', item.item_dimensions_unit || 'cm');
  }

  return form;
}

// ── HANDLER ────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  // Supports both ?action=x and /etsy-proxy/x path styles (the OAuth callback
  // uses the path style so the registered redirect URI carries no query string).
  const pathAction = url.pathname.replace(/^.*\/etsy-proxy\/?/, '').replace(/\/$/, '');
  const action = pathAction || url.searchParams.get('action') || '';

  try {
    if (!KEYSTRING || !SHARED_SECRET) {
      return json({ error: 'ETSY_KEYSTRING / ETSY_SHARED_SECRET env vars not set' }, 500);
    }

    // ── OAuth: start ──────────────────────────────────────────────────────
    if (action === 'oauth-start') {
      if (!REDIRECT_URI) return json({ error: 'ETSY_REDIRECT_URI env var not set' }, 500);
      const verifier  = randomString();
      const state     = randomString();
      const challenge = await challengeOf(verifier);
      await writeJson(PKCE_PATH, { verifier, state, created_at: Date.now() });

      const params = new URLSearchParams({
        response_type:         'code',
        client_id:             KEYSTRING,
        redirect_uri:          REDIRECT_URI,
        scope:                 SCOPES,
        state,
        code_challenge:        challenge,
        code_challenge_method: 'S256',
      });
      // Etsy'nin dokümante ettiği biçim boşluklar için %20 kullanır; URLSearchParams
      // bunları '+' olarak kodladığı için scope kısmını elle düzeltiyoruz.
      const qs = params.toString().replace(
        /(^|&)(scope=)([^&]*)/,
        (_m, sep, key, v) => sep + key + v.replace(/\+/g, '%20'),
      );
      return json({ url: `${CONNECT}?${qs}` });
    }

    // ── OAuth: callback (browser redirect target) ─────────────────────────
    if (action === 'oauth-callback') {
      const err = url.searchParams.get('error');
      if (err) {
        return html(`<h3>Etsy bağlantısı reddedildi</h3><p>${err}: ${url.searchParams.get('error_description') ?? ''}</p>`);
      }
      const code  = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code) return html('<h3>Eksik authorization code</h3>');

      const pkce = await readJson(PKCE_PATH);
      if (!pkce?.verifier) return html('<h3>Oturum bulunamadı</h3><p>Bağlantıyı yeniden başlatın.</p>');
      if (pkce.state !== state) return html('<h3>State uyuşmuyor</h3><p>Güvenlik nedeniyle iptal edildi.</p>');

      const res = await fetch(TOKEN_EP, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'authorization_code',
          client_id:     KEYSTRING,
          redirect_uri:  REDIRECT_URI,
          code,
          code_verifier: pkce.verifier,
        }),
      });
      const tok = await res.json();
      if (!tok.access_token) return html(`<h3>Token alınamadı</h3><pre>${JSON.stringify(tok)}</pre>`);

      const record = await saveTokenResponse(tok);
      await supa().storage.from(BUCKET).remove([PKCE_PATH]);
      try { await getShopId(record); } catch { /* shop bilgisi sonra çekilir */ }

      return html(
        '<h3>✓ Etsy bağlantısı kuruldu</h3><p>Bu pencereyi kapatabilirsiniz.</p>'
        + '<script>try{window.opener&&window.opener.postMessage("etsy-connected","*")}catch(e){};setTimeout(function(){window.close()},1200)</script>',
      );
    }

    // ── Connection status ─────────────────────────────────────────────────
    if (action === 'status') {
      const record = await readJson(TOKEN_PATH);
      if (!record?.access_token) return json({ connected: false });
      try {
        const tok = await getToken();
        // ?refresh=1 — dükkan adı/para birimi Etsy'de değiştiyse önbelleği tazeler
        if (url.searchParams.get('refresh')) {
          delete tok.shop_id;
          delete tok.currency_code;
        }
        const shopId = await getShopId(tok);
        return json({
          connected: true,
          shop_id:   shopId,
          shop_name: tok.shop_name ?? null,
          currency:  tok.currency_code ?? null,
          user_id:   tok.user_id ?? null,
          scope:     tok.scope ?? null,
        });
      } catch (e) {
        return json({ connected: false, error: String(e) });
      }
    }

    if (action === 'disconnect') {
      await supa().storage.from(BUCKET).remove([TOKEN_PATH, PKCE_PATH]);
      return json({ ok: true });
    }

    // ── Shop reference data ───────────────────────────────────────────────
    if (action === 'shipping-profiles') {
      const tok = await getToken();
      const shopId = await getShopId(tok);
      return json(await etsy(`/shops/${shopId}/shipping-profiles`, {}, tok));
    }

    if (action === 'return-policies') {
      const tok = await getToken();
      const shopId = await getShopId(tok);
      return json(await etsy(`/shops/${shopId}/policies/return`, {}, tok));
    }

    // Etsy fiziksel ilanlarda readiness_state_id (işlem profili) zorunlu tutuyor.
    if (action === 'processing-profiles') {
      const tok = await getToken();
      const shopId = await getShopId(tok);
      return json(await etsy(`/shops/${shopId}/readiness-state-definitions?limit=100`, {}, tok));
    }

    // Dükkanda uygun profil yoksa oluşturur; aynısı varsa 409 döner ve mevcut liste kullanılır.
    if (action === 'create-processing-profile') {
      const { readiness_state, min_processing_time, max_processing_time } = await req.json();
      const tok    = await getToken();
      const shopId = await getShopId(tok);
      const body = new URLSearchParams({
        readiness_state:      readiness_state || 'made_to_order',
        min_processing_time:  String(min_processing_time ?? 3),
        max_processing_time:  String(max_processing_time ?? 7),
        processing_time_unit: 'days',
      });
      try {
        const p = await etsy(`/shops/${shopId}/readiness-state-definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        }, tok);
        return json({ ok: true, profile: p });
      } catch (e) {
        const msg = String(e instanceof Error ? e.message : e);
        if (msg.startsWith('ETSY_409')) return json({ ok: false, conflict: true, error: msg });
        throw e;
      }
    }

    if (action === 'sections') {
      const tok = await getToken();
      const shopId = await getShopId(tok);
      return json(await etsy(`/shops/${shopId}/sections`, {}, tok));
    }

    // Full seller taxonomy tree, flattened to leaf paths and optionally filtered.
    if (action === 'taxonomy') {
      const q   = (url.searchParams.get('q') || '').toLocaleLowerCase('en');
      const tok = await getToken();
      const data = await etsy('/seller-taxonomy/nodes', {}, tok);

      const flat: { id: number; path: string }[] = [];
      const walk = (nodes: any[], prefix: string) => {
        for (const n of nodes ?? []) {
          const path = prefix ? `${prefix} > ${n.name}` : n.name;
          flat.push({ id: n.id, path });
          if (n.children?.length) walk(n.children, path);
        }
      };
      walk(data.results ?? [], '');

      const filtered = q
        ? flat.filter((n) => n.path.toLocaleLowerCase('en').includes(q))
        : flat;
      return json({ count: filtered.length, results: filtered.slice(0, 300) });
    }

    // Secilen kategoriye ait ozellikler (materyal, renk, occasion, holiday...)
    if (action === 'taxonomy-properties') {
      const taxId = url.searchParams.get('taxonomyId');
      if (!taxId) return json({ error: 'taxonomyId required' }, 400);
      const tok = await getToken();
      return json(await etsy(`/seller-taxonomy/nodes/${taxId}/properties`, {}, tok));
    }

    // Bir ilanin tek bir ozelligini yazar (value_ids + values birlikte gerekir).
    if (action === 'set-listing-property') {
      const { listing_id, property_id, value_ids, values, scale_id } = await req.json();
      if (!listing_id || !property_id) return json({ error: 'listing_id and property_id required' }, 400);

      const body = new URLSearchParams();
      (value_ids || []).forEach((v: number) => body.append('value_ids', String(v)));
      // Parantez karakterlerine Etsy izin vermiyor
      (values || []).forEach((v: string) => body.append('values', String(v).replace(/[()]/g, '')));
      if (scale_id) body.set('scale_id', String(scale_id));

      const tok    = await getToken();
      const shopId = await getShopId(tok);
      const res = await etsy(`/shops/${shopId}/listings/${listing_id}/properties/${property_id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    body.toString(),
      }, tok);
      return json({ ok: true, property: res });
    }

    // ── Anahtar kelime arastirmasi ────────────────────────────────────────
    // Etsy arama hacmi vermiyor (Marketplace Insights API'de yok). Onun yerine
    // bir terim icin en ust siradaki ilanlari cekip etiket/baslik frekansi
    // cikariyoruz: bunlar fiilen siralamayi kazanan kelimeler.
    if (action === 'keyword-research') {
      const q     = url.searchParams.get('q') || '';
      const taxId = url.searchParams.get('taxonomyId') || '';
      if (!q) return json({ error: 'q required' }, 400);

      const params = new URLSearchParams({ keywords: q, limit: '100', sort_on: 'score' });
      if (taxId) params.set('taxonomy_id', taxId);

      const tok  = await getToken();
      // Ilanlar kendi para birimlerinde donuyor; ortalamanin anlamli olmasi icin
      // hepsini dukkan para birimine cevirt.
      const shopCurrency = tok.currency_code || 'USD';
      params.set('currency', shopCurrency);
      const data = await etsy(`/listings/active?${params.toString()}`, {}, tok);
      const rows = data.results || [];

      const STOP = new Set([
        'the','and','for','with','from','your','you','our','this','that','are','was',
        'has','have','can','all','new','one','two','set','made','gift','gifts','etsy',
      ]);

      const tagFreq   = new Map<string, number>();
      const wordFreq  = new Map<string, number>();
      const bigrams   = new Map<string, number>();
      const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

      let priceSum = 0, priceCount = 0, favSum = 0;

      for (const r of rows) {
        for (const t of (r.tags ?? [])) {
          const k = String(t).toLocaleLowerCase('en').trim();
          if (k) bump(tagFreq, k);
        }

        const words = String(r.title ?? '')
          .toLocaleLowerCase('en')
          .replace(/[^\p{L}\p{Nd}\s-]/gu, ' ')
          .split(/\s+/)
          .filter((w) => w.length > 2 && !STOP.has(w));

        for (const w of words) bump(wordFreq, w);
        for (let i = 0; i < words.length - 1; i++) bump(bigrams, `${words[i]} ${words[i + 1]}`);

        const p = r.converted_price ?? r.price;
        if (p?.amount != null && (r.converted_price || p.currency_code === shopCurrency)) {
          priceSum += p.amount / (p.divisor || 100);
          priceCount++;
        }
        favSum += r.num_favorers ?? 0;
      }

      const top = (m: Map<string, number>, n: number, minCount = 2) =>
        [...m.entries()]
          .filter(([, c]) => c >= minCount)
          .sort((a, b) => b[1] - a[1])
          .slice(0, n)
          .map(([term, count]) => ({ term, count }));

      return json({
        ok: true,
        query: q,
        analyzed: rows.length,
        totalMatches: data.count ?? null,
        topTags:    top(tagFreq, 30),
        topPhrases: top(bigrams, 20),
        topWords:   top(wordFreq, 25),
        avgPrice:   priceCount ? +(priceSum / priceCount).toFixed(2) : null,
        currency:   shopCurrency,
        pricedFrom: priceCount,
        avgFavorers: rows.length ? Math.round(favSum / rows.length) : null,
      });
    }

    // ── Create a draft listing ────────────────────────────────────────────
    if (action === 'create-listing') {
      const item   = await req.json();
      const tok    = await getToken();
      const shopId = await getShopId(tok);
      const listing = await etsy(`/shops/${shopId}/listings`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    listingForm(item).toString(),
      }, tok);
      return json({ ok: true, listing_id: listing.listing_id, url: listing.url, state: listing.state });
    }

    // SKU createDraftListing'de yok — envanter kaydina yaziliyor. Varyasyonsuz
    // ilanda tek urun/tek teklif olur; fiyat ve adet burada tekrar verilmeli.
    if (action === 'set-sku') {
      const { listing_id, sku, price, quantity, readiness_state_id } = await req.json();
      if (!listing_id || !sku) return json({ error: 'listing_id and sku required' }, 400);

      const offering: Record<string, unknown> = {
        price:      Number(price),
        quantity:   Math.max(1, parseInt(String(quantity), 10) || 1),
        is_enabled: true,
      };
      if (readiness_state_id) offering.readiness_state_id = Number(readiness_state_id);

      const tok = await getToken();
      const res = await etsy(`/listings/${listing_id}/inventory`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          products: [{ sku: String(sku), property_values: [], offerings: [offering] }],
        }),
      }, tok);
      return json({ ok: true, sku: res.products?.[0]?.sku ?? sku });
    }

    // ── Attach one image (fetched server-side from a public URL) ──────────
    if (action === 'upload-image') {
      const { listing_id, imageUrl, rank, alt_text } = await req.json();
      if (!listing_id || !imageUrl) return json({ error: 'listing_id and imageUrl required' }, 400);

      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) return json({ error: `Görsel indirilemedi (${imgRes.status}): ${imageUrl}` }, 400);
      const blob = await imgRes.blob();
      const name = (imageUrl.split('/').pop() || 'image.jpg').split('?')[0];

      const form = new FormData();
      form.append('image', blob, name);
      if (rank) form.append('rank', String(rank));
      if (alt_text) form.append('alt_text', String(alt_text).slice(0, 500));

      const tok    = await getToken();
      const shopId = await getShopId(tok);
      const img = await etsy(`/shops/${shopId}/listings/${listing_id}/images`, {
        method: 'POST', body: form,
      }, tok);
      return json({ ok: true, listing_image_id: img.listing_image_id, rank: img.rank });
    }

    // ── List shop listings (draft by default) ─────────────────────────────
    if (action === 'listings') {
      const state  = url.searchParams.get('state')  || 'draft';
      const limit  = url.searchParams.get('limit')  || '50';
      const offset = url.searchParams.get('offset') || '0';
      const tok    = await getToken();
      const shopId = await getShopId(tok);
      const params = new URLSearchParams({ state, limit, offset, includes: 'Images' });
      return json(await etsy(`/shops/${shopId}/listings?${params.toString()}`, {}, tok));
    }

    if (action === 'delete-listing') {
      const listingId = url.searchParams.get('listingId');
      if (!listingId) return json({ error: 'listingId required' }, 400);
      const tok = await getToken();
      await etsy(`/listings/${listingId}`, { method: 'DELETE' }, tok);
      return json({ ok: true });
    }

    // ── AI: Turkish product data → English Etsy content ───────────────────
    if (action === 'ai-listing') {
      if (!CLAUDE_KEY) return json({ error: 'CLAUDE_API_KEY env var not set' }, 500);
      const { title, description, category, color, material, height, width, weight, keywords } = await req.json();

      // keywords: keyword-research'ten gelen, o kategoride fiilen siralanan terimler.
      const kwList = (keywords ?? []).slice(0, 30);
      const kwSection = kwList.length
        ? `\nRANKING KEYWORDS (these terms appear most often in the tags and titles of the
listings Etsy currently ranks highest for this product type, ordered by frequency):
${kwList.map((k: any, i: number) => `${i + 1}. ${typeof k === 'string' ? k : k.term}`).join('\n')}

Use this data as evidence of real buyer demand, not as a word list to copy verbatim.`
        : '\n(No keyword data available — rely on standard Etsy search behaviour.)';

      const prompt = `You write Etsy listings for "MAAT SERAMİK", a Turkish handmade ceramics studio.
Translate and rewrite the following Turkish product for an English-speaking Etsy audience,
optimised for Etsy search.

Turkish title: ${title ?? ''}
Turkish description: ${(description ?? '').replace(/<[^>]+>/g, ' ').slice(0, 1200)}
Category: ${category ?? ''}
Color: ${color ?? ''} | Material: ${material ?? ''}
Height: ${height ?? ''} cm | Width: ${width ?? ''} cm | Weight: ${weight ?? ''} g
${kwSection}

FACTUAL LIMITS — these override every other rule:
- Use ONLY the facts given above. If a detail is not supplied, leave it out entirely.
- Never invent: a workshop location, city or country; a forming technique (do not write
  "wheel-thrown", "hand-built", "slip-cast" or similar unless it is stated); a firing
  temperature or kiln type; a glaze type or food/dishwasher/microwave safety; a clay body
  beyond the material given; production time; awards, history or founding story; the number
  of pieces made; sourcing or sustainability claims.
- Dimensions and weight: repeat the supplied numbers exactly. Do not convert into imperial
  units, do not estimate a missing one, do not describe a dimension that was not provided.
- Care instructions: only the generic and always-true (wipe with a damp cloth, hand wash with
  mild soap, avoid prolonged standing water). Never claim dishwasher, microwave or oven safety.
- "Each piece varies slightly because it is handmade" is allowed — it follows from handmade.
- If the supplied information is too thin for the word count, write a shorter description.
  A short accurate description is correct; padding it with plausible invention is not.

HOW ETSY SEARCH WORKS — follow this, it drives every rule below:
- Etsy matches a buyer's query against the title, tags and attributes. Multi-word phrases
  matter far more than isolated words: "ceramic vase" is a query, "ceramic" alone is not.
- Exact phrase matches rank strongest, so a tag must read like something a buyer types.
- The first ~40 characters of the title carry the most weight and are what shows in search
  results and on mobile.
- Repeating the same keyword everywhere does not stack; coverage of DIFFERENT real queries does.
- Descriptions are weighted lightly for ranking but heavily for conversion, and conversion
  feeds back into ranking. Write for the human first.

TITLE (60-140 characters):
- Open with the exact phrase a buyer would search for this item, then add differentiating
  qualifiers (style, colour, use, recipient).
- Read as a natural phrase, not a keyword dump. Separate ideas with commas or a pipe.
- No ALL CAPS, no emoji, no repeated words, no brand-name stuffing.

TAGS (exactly 13, each max 20 characters):
- Every tag is a buyer query. Prefer 2-3 word phrases over single words.
- Cover distinct search intents: what it is, style, material, room or use, occasion,
  recipient. Do not spend several tags on near-synonyms of the same phrase.
- Do not repeat a phrase already used verbatim as another tag.
- Lowercase, letters/numbers/spaces/hyphens only.

DESCRIPTION (150-250 words, plain text, no HTML, no markdown):
- First sentence must restate the main keyword phrase naturally — it is what Google shows
  and what the buyer reads first.
- Then cover, in short paragraphs, using only supplied facts: what it is; the exact
  dimensions given; how it fits a room or occasion; generic care; that each piece varies
  slightly because it is handmade.
- Weave 3-5 secondary keyword phrases in as ordinary prose. Never list keywords, never
  write a keyword block at the end.
- Warm and concrete, but only about things you were told. No hype adjectives.
- 150-250 words is a target, not a quota: never reach it by inventing detail.

MATERIALS: 3-6 words, derived from the material actually supplied. Do not add materials
that were not mentioned.

Return ONLY JSON, nothing else:
{"title":"...","description":"...","tags":["..."],"materials":["..."]}`;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2500, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await res.json();
      if (data.error) return json({ error: data.error.message }, 500);
      const match = (data.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
      if (!match) return json({ error: 'parse hatasi', raw: data.content?.[0]?.text }, 500);
      try { return json({ ok: true, result: JSON.parse(match[0]) }); }
      catch { return json({ error: 'json parse hatasi', raw: match[0] }, 500); }
    }

    return json({ error: 'Unknown action: ' + action }, 400);

  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (msg.includes('NOT_CONNECTED')) return json({ error: 'NOT_CONNECTED' }, 401);
    return json({ error: msg }, 500);
  }
});

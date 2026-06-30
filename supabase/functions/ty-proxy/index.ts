import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SELLER_ID    = '354534';
const API_KEY      = 'SI5R4qDhlJ6SyqRsiLgy';
const API_SECRET   = 'Z1O5HWGqRdDtm5xbhVFq';
const AUTH         = 'Basic ' + btoa(API_KEY + ':' + API_SECRET);
const BASE         = 'https://apigw.trendyol.com/integration/product';
const BASE_SAPIGW  = 'https://apigw.trendyol.com/sapigw/suppliers';
const CLAUDE_KEY   = Deno.env.get('CLAUDE_API_KEY') ?? '';
const SUPA_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SUPA_KEY     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CLIPDROP_KEY = '3ebacc47355ce0c5953bcf2d397f28097da39afe563e54c8eb0b4aa7f4a45abd4805c685303e7bf0b1b7e72809a45111';

const MAAT_BRAND = { id: 2922973, name: 'MAAT SERAMİK' };

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

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url    = new URL(req.url);
  const action = url.searchParams.get('action');

  try {

    if (action === 'brand') {
      return json({ brand: MAAT_BRAND, raw: [MAAT_BRAND] });
    }

    if (action === 'categories') {
      const res = await fetch(`${BASE}/product-categories`, { headers: { Authorization: AUTH } });
      return json(await res.json());
    }

    if (action === 'attributes') {
      const catId = url.searchParams.get('categoryId');
      if (!catId) return json({ error: 'categoryId required' }, 400);
      const res = await fetch(`${BASE}/categories/${catId}/attributes`, { headers: { Authorization: AUTH } });
      return json(await res.json());
    }

    if (action === 'attribute-values') {
      const catId  = url.searchParams.get('categoryId');
      const attrId = url.searchParams.get('attributeId');
      const page   = url.searchParams.get('page') || '0';
      if (!catId || !attrId) return json({ error: 'categoryId and attributeId required' }, 400);
      const res = await fetch(
        `${BASE}/categories/${catId}/attributes/${attrId}/values?page=${page}&size=50`,
        { headers: { Authorization: AUTH } }
      );
      const data = await res.json();
      if (Array.isArray(data)) return json({ content: data, totalPages: 1 });
      return json(data);
    }

    if (action === 'create-product') {
      const body = await req.json();
      if (body.items) body.items.forEach((item: any) => { item.brandId = MAAT_BRAND.id; });
      const res = await fetch(`${BASE}/sellers/${SELLER_ID}/v2/products`, {
        method: 'POST',
        headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return json(await res.json());
    }

    if (action === 'batch-status') {
      const batchId = url.searchParams.get('batchId');
      if (!batchId) return json({ error: 'batchId required' }, 400);
      const res = await fetch(
        `${BASE}/sellers/${SELLER_ID}/products/batch-requests/${batchId}`,
        { headers: { Authorization: AUTH } }
      );
      const data = await res.json();
      const summary = {
        batchId: data.batchRequestId, status: data.status,
        total: data.itemCount, failed: data.failedItemCount,
        items: (data.items || []).map((i: any) => ({
          barcode: i.requestItem?.barcode || i.requestItem?.product?.barcode,
          status: i.status, reasons: i.failureReasons || []
        }))
      };
      return json({ summary, raw: data });
    }

    if (action === 'list-products') {
      const page    = url.searchParams.get('page') || '0';
      const size    = url.searchParams.get('size') || '50';
      const status  = url.searchParams.get('status') || '';
      const barcode = url.searchParams.get('barcode') || '';

      const endpoints = [
        `${BASE_SAPIGW}/${SELLER_ID}/v2/products`,
        `${BASE_SAPIGW}/${SELLER_ID}/products`,
        `${BASE}/sellers/${SELLER_ID}/products`,
      ];

      const params = new URLSearchParams({ page, size });
      if (barcode) params.set('barcode', barcode);
      if (status === 'APPROVED') params.set('approved', 'true');
      if (status === 'REJECTED') params.set('approved', 'false');
      if (status === 'WAITING')  params.set('onSale', 'false');
      if (status === 'PASSIVE')  params.set('blacklisted', 'true');

      const lastErrors: any[] = [];
      for (const base of endpoints) {
        const endpoint = `${base}?${params.toString()}`;
        const res  = await fetch(endpoint, { headers: { Authorization: AUTH } });
        const data = await res.json();
        if (data && (Array.isArray(data.content) || typeof data.totalElements === 'number')) {
          return json({ ...data, _endpoint: endpoint });
        }
        lastErrors.push({ endpoint, data });
      }

      return json({ error: 'Tüm Trendyol endpointleri yanıt vermedi', tried: lastErrors });
    }

    if (action === 'batch-result') {
      const batchId = url.searchParams.get('batchId');
      if (!batchId) return json({ error: 'batchId required' }, 400);
      const res = await fetch(
        `${BASE}/sellers/${SELLER_ID}/products/batch-requests/${batchId}`,
        { headers: { Authorization: AUTH } }
      );
      return json(await res.json());
    }

    if (action === 'upload-video') {
      const supaAdmin = createClient(SUPA_URL, SUPA_KEY);
      const fileName = url.searchParams.get('filename') || (Date.now() + '.mp4');
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `video/${Date.now()}_${safeName}`;
      const { data, error } = await supaAdmin.storage
        .from('trendyol')
        .createSignedUploadUrl(path);
      if (error) return json({ error: 'Signed URL alınamadı', detail: error.message }, 500);
      const publicUrl = `${SUPA_URL}/storage/v1/object/public/trendyol/${path}`;
      return json({ signedUrl: data.signedUrl, token: data.token, publicUrl });
    }

    if (action === 'add-video') {
      const body = await req.json();
      const { productContentId, videoUrl, title } = body;
      if (!productContentId || !videoUrl) return json({ error: 'productContentId and videoUrl required' }, 400);
      const BASE_VIDEO = 'https://apigw.trendyol.com/integration/video';
      const reqBody = {
        title: (title || 'Ürün Tanıtım Videosu').slice(0, 50),
        videoUrl,
        productContentIds: [productContentId],
        videoContentType: 'PRODUCT_PROMOTION',
      };
      const res = await fetch(`${BASE_VIDEO}/sellers/${SELLER_ID}/videos`, {
        method: 'POST',
        headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      });
      return json(await res.json());
    }

    if (action === 'ai-generate') {
      if (!CLAUDE_KEY) return json({ error: 'CLAUDE_API_KEY env var not set' }, 500);
      const body = await req.json();
      const { category, requiredAttrs, hint } = body;
      const rnd = () => Math.floor(Math.random() * 900) + 100;

      const hintSection = hint
        ? `\nÜRÜN TARİFİ (bunu esas al): ${hint}\nTariften renk, malzeme, ölçü gibi bilgileri çıkar ve JSON çıktısında ilgili alanlara yaz.`
        : '';

      const prompt = `Trendyol'da "MAAT SERAMİK" markası için el yapımı seramik ürün içeriği yaz.
Kategori: ${category}
Zorunlu özellikler: ${requiredAttrs}${hintSection}

BAŞLIK KURALLARI:
- En az 9, en fazla 13 kelime
- Her Kelimenin İlk Harfi Büyük Olsun
- Tekrarlayan kelimeler kullanma
- Barkod, stok, marka adı yazma
- Emoji, sembol kullanma
- Abartılı sıfatlardan kaçın
- Sadece kategori adından oluşmasın
- Anahtar kelimeleri doğal içer
- El Yapımı ile başlasın

SADECE JSON döndür (başka hiçbir şey yazma):
{
  "title": "...",
  "description": "(HTML <p> etiketleri, 150-200 kelime, Türkçe, tarifteki özellikleri vurgula)",
  "barcode": "NUN-${rnd()}",
  "productMainId": "MAAT-${rnd()}",
  "stockCode": "NUN-STK-${rnd()}",
  "color": "(tariften çıkan renk, yoksa boş string)",
  "material": "(tariften çıkan malzeme, yoksa boş string)",
  "height": "(tariften çıkan yükseklik cm olarak sayı, yoksa null)",
  "width": "(tariften çıkan çap/genişlik cm olarak sayı, yoksa null)",
  "weight": "(tariften çıkan ağırlık gram olarak sayı, yoksa null)"
}`;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await res.json();
      if (data.error) return json({ error: data.error.message }, 500);
      const text = data.content?.[0]?.text || '';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return json({ error: 'parse hatasi', raw: text }, 500);
      try { return json({ ok: true, result: JSON.parse(match[0]) }); }
      catch { return json({ error: 'json parse hatasi', raw: text }, 500); }
    }

    if (action === 'remove-bg') {
      const body = await req.json();
      const { imageBase64, mimeType } = body;
      if (!imageBase64) return json({ error: 'imageBase64 required' }, 400);
      const bytes = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0));
      const blob  = new Blob([bytes], { type: mimeType || 'image/jpeg' });
      const form  = new FormData();
      form.append('image_file', blob, 'image.jpg');
      const res = await fetch('https://clipdrop-api.co/remove-background/v1', {
        method: 'POST', headers: { 'x-api-key': CLIPDROP_KEY }, body: form,
      });
      if (!res.ok) { const e = await res.text(); return json({ error: `Clipdrop ${res.status}`, detail: e }, res.status); }
      return json({ ok: true, pngBase64: bufToBase64(await res.arrayBuffer()) });
    }

    if (action === 'catalog-add') {
      const supabase = createClient(SUPA_URL, SUPA_KEY);
      const entry = await req.json();
      entry.created_at = new Date().toISOString();
      const { data: existing } = await supabase.storage.from('trendyol').download('catalog/catalog.json');
      let catalog: unknown[] = [];
      if (existing) { try { catalog = JSON.parse(await existing.text()); } catch { catalog = []; } }
      const dup = (catalog as any[]).find((r: any) => r.barcode === entry.barcode);
      if (dup) return json({ error: 'DUPLIKAT_BARKOD', existing: dup }, 409);
      catalog.push(entry);
      const catBlob = new Blob([JSON.stringify(catalog, null, 2)], { type: 'application/json' });
      const { error } = await supabase.storage.from('trendyol').upload('catalog/catalog.json', catBlob, { upsert: true, contentType: 'application/json' });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, total: catalog.length });
    }

    if (action === 'catalog-list') {
      const supabase = createClient(SUPA_URL, SUPA_KEY);
      const { data, error } = await supabase.storage.from('trendyol').download('catalog/catalog.json');
      if (error || !data) return json([]);
      try { return json(JSON.parse(await data.text())); } catch { return json([]); }
    }

    return json({ error: 'Unknown action' }, 400);

  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

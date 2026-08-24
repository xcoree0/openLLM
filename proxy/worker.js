/**
 * OpenLLM CORS vekili — Cloudflare Workers (ücretsiz katman) için.
 *
 * NE İŞE YARAR?
 * NVIDIA'nın API'leri (integrate.api.nvidia.com, ai.api.nvidia.com,
 * api.nvcf.nvidia.com) tarayıcıdan doğrudan istekler için CORS başlıkları
 * döndürmüyor. Bu worker, statik OpenLLM sayfası ile NVIDIA arasında ince bir
 * "geçiş katmanı" olur: isteği olduğu gibi NVIDIA'ya iletir, yanıtı CORS
 * başlıklarıyla birlikte geri döndürür. API anahtarını HİÇBİR ŞEKİLDE
 * saklamaz, loglamaz ya da başka bir yere göndermez — yalnızca tarayıcının
 * gönderdiği Authorization başlığını olduğu gibi NVIDIA'ya aktarır.
 *
 * KURULUM (yaklaşık 2 dakika, kredi kartı gerekmez):
 *   1. https://dash.cloudflare.com → ücretsiz hesap aç / giriş yap
 *   2. Workers & Pages → Create → "Create Worker"
 *   3. Açılan düzenleyicideki örnek kodu SİL, bu dosyanın tamamını yapıştır
 *   4. Deploy'a bas; sana "https://<isim>.<hesap>.workers.dev" gibi bir adres verilecek
 *   5. Bu adresi OpenLLM'de "Kendi vekil sunucum" alanına yapıştır
 *
 * (İsteğe bağlı) Sadece kendi GitHub Pages adresinden gelen isteklere izin
 * vermek için Worker ayarlarından bir ortam değişkeni ekleyebilirsin:
 *   ALLOWED_ORIGIN = https://kullanici-adin.github.io
 * Tanımlanmazsa varsayılan olarak her origin'e izin verilir (*).
 */

const ALLOWED_HOSTS = {
  integrate: 'integrate.api.nvidia.com',
  genai: 'ai.api.nvidia.com',
  nvcf: 'api.nvcf.nvidia.com',
};

function corsHeaders(origin, allowedOrigin) {
  return {
    'Access-Control-Allow-Origin': allowedOrigin || origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Expose-Headers': 'NVCF-REQID, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Beklenen yol: /proxy/{integrate|genai|nvcf}/geri-kalan/yol
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'proxy' || !ALLOWED_HOSTS[parts[1]]) {
      return new Response(
        JSON.stringify({ error: 'Beklenmeyen yol. Örn: /proxy/integrate/v1/models' }),
        { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    const host = ALLOWED_HOSTS[parts[1]];
    const upstreamPath = '/' + parts.slice(2).join('/');
    const upstreamUrl = `https://${host}${upstreamPath}${url.search}`;

    const forwardHeaders = new Headers();
    const auth = request.headers.get('Authorization');
    if (auth) forwardHeaders.set('Authorization', auth);
    const contentType = request.headers.get('Content-Type');
    if (contentType) forwardHeaders.set('Content-Type', contentType);
    forwardHeaders.set('Accept', request.headers.get('Accept') || 'application/json');

    let upstreamRes;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method: request.method,
        headers: forwardHeaders,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: `Üst akış isteği başarısız: ${err.message}` }),
        { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    const resHeaders = new Headers(upstreamRes.headers);
    Object.entries(cors).forEach(([k, v]) => resHeaders.set(k, v));

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: resHeaders,
    });
  },
};

/* appMoove 専用 CORS プロキシ (Cloudflare Worker, 依存なし)
 *
 * 呼び出し形式（どちらでも可）
 *   1) 前置き形式: https://<worker>/https://api.example.com/path?query
 *      （app.js の「corsProxy + 転送先URL」形式にそのまま合う）
 *   2) クエリ形式: https://<worker>/?url=<encodeURIComponent(転送先URL)>
 *
 * オープンプロキシにしないため、
 *   - 呼び出し元 Origin を ALLOWED_ORIGINS で制限
 *   - 転送先ホストを ALLOWED_HOSTS で制限（リダイレクト先も毎回チェック）
 * 許可リストは wrangler.toml の [vars]（またはダッシュボードの「変数」）で変更する。
 * このファイルに秘密情報は含めないこと（GitHub Pages で公開される可能性がある）。
 */

const DEFAULT_ALLOWED_ORIGINS =
  "https://kfjwara.github.io,http://localhost:*,http://127.0.0.1:*";
const DEFAULT_ALLOWED_HOSTS = "api.cobalt.liubquanti.click";

const ALLOWED_METHODS = "GET, HEAD, POST, OPTIONS";
const MAX_POST_BYTES = 64 * 1024; // cobalt への JSON は数百バイト程度
const MAX_REDIRECTS = 5;

// 転送先へ渡すリクエストヘッダ（それ以外は落とす: Cookie, Referer, CF-* など）
const FORWARD_REQ_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "range",
  "if-range",
  "authorization", // cobalt インスタンスが Api-Key 認証を要求する場合用
];

// クライアントへ返すレスポンスヘッダ（Content-Encoding は fetch が展開済みなので返さない）
const FORWARD_RES_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "content-disposition",
  "etag",
  "last-modified",
  "cache-control",
  "estimated-content-length", // cobalt tunnel が付けることがある
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "ratelimit-policy",
  "retry-after",
];

const EXPOSE_HEADERS = [
  "Content-Length",
  "Content-Type",
  "Content-Range",
  "Accept-Ranges",
  "Content-Disposition",
  "ETag",
  "Last-Modified",
  "Estimated-Content-Length",
  "RateLimit-Limit",
  "RateLimit-Remaining",
  "RateLimit-Reset",
  "RateLimit-Policy",
  "Retry-After",
  "X-Proxy-Final-Url",
].join(", ");

function parseList(s) {
  return String(s || "")
    .split(/[\s,]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

// "http://localhost:*" のようなポートワイルドカード、"https://*.example.com" のサブドメインワイルドカードに対応
function originAllowed(origin, list) {
  if (!origin) return false;
  const o = origin.toLowerCase();
  for (const pat of list) {
    if (pat === o) return true;
    if (pat.endsWith(":*")) {
      const base = pat.slice(0, -2);
      if (o === base || (o.startsWith(base + ":") && /^\d+$/.test(o.slice(base.length + 1)))) return true;
    }
    if (pat.includes("://*.")) {
      const [scheme, rest] = pat.split("://*.");
      if (o.startsWith(scheme + "://") && o.endsWith("." + rest)) return true;
    }
  }
  return false;
}

// "example.com"（完全一致）と "*.example.com"（サブドメイン）に対応
function hostAllowed(hostname, list) {
  const h = hostname.toLowerCase();
  for (const pat of list) {
    if (pat === "*") continue; // 全許可は意図的に無効（オープンプロキシ化防止）
    if (pat.startsWith("*.")) {
      if (h.endsWith(pat.slice(1))) return true;
    } else if (h === pat) {
      return true;
    }
  }
  return false;
}

function corsHeaders(origin) {
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", origin);
  h.set("Vary", "Origin");
  h.set("Access-Control-Expose-Headers", EXPOSE_HEADERS);
  return h;
}

function textResponse(status, msg, origin) {
  const h = origin ? corsHeaders(origin) : new Headers({ Vary: "Origin" });
  h.set("Content-Type", "text/plain; charset=utf-8");
  h.set("Cache-Control", "no-store");
  return new Response(msg + "\n", { status, headers: h });
}

// リクエストURLから転送先URLを取り出す
function extractTarget(request) {
  const reqUrl = new URL(request.url);
  const q = reqUrl.searchParams.get("url");
  if (q && reqUrl.pathname === "/") return q;
  // 前置き形式: パス以降を生の文字列で取る（クエリも転送先のもの）
  let rest = request.url.slice(reqUrl.origin.length + 1);
  if (!rest) return null;
  try { if (/^https?%3A/i.test(rest)) rest = decodeURIComponent(rest); } catch (_) { /* そのまま */ }
  // 途中の経路で "https://" の "//" が "/" に潰された場合の救済
  rest = rest.replace(/^(https?):\/(?!\/)/i, "$1://");
  return rest;
}

export default {
  async fetch(request, env) {
    const allowedOrigins = parseList((env && env.ALLOWED_ORIGINS) || DEFAULT_ALLOWED_ORIGINS);
    const allowedHosts = parseList((env && env.ALLOWED_HOSTS) || DEFAULT_ALLOWED_HOSTS);

    const origin = request.headers.get("Origin");
    if (!originAllowed(origin, allowedOrigins)) {
      return textResponse(403, "forbidden origin", null);
    }

    // プリフライト
    if (request.method === "OPTIONS") {
      const h = corsHeaders(origin);
      h.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
      const reqHdrs = request.headers.get("Access-Control-Request-Headers");
      h.set("Access-Control-Allow-Headers", reqHdrs || "Accept, Content-Type, Range, If-Range, Authorization");
      h.set("Access-Control-Max-Age", "86400");
      return new Response(null, { status: 204, headers: h });
    }

    if (!["GET", "HEAD", "POST"].includes(request.method)) {
      return textResponse(405, "method not allowed", origin);
    }

    const raw = extractTarget(request);
    if (!raw) return textResponse(400, "usage: /<https-url> or /?url=<encoded-url>", origin);
    let target;
    try { target = new URL(raw); } catch (_) { return textResponse(400, "bad target url", origin); }
    if (target.protocol !== "https:" || target.username || target.password ||
        (target.port && target.port !== "443")) {
      return textResponse(400, "only plain https targets are allowed", origin);
    }
    if (!hostAllowed(target.hostname, allowedHosts)) {
      return textResponse(403, `target host not allowed: ${target.hostname}`, origin);
    }

    const fwd = new Headers();
    for (const name of FORWARD_REQ_HEADERS) {
      const v = request.headers.get(name);
      if (v) fwd.set(name, v);
    }
    // cobalt は UA 無しを弾くことがあるので最低限付ける
    fwd.set("User-Agent", "appMoove-proxy/1.0");

    let body;
    if (request.method === "POST") {
      const len = Number(request.headers.get("content-length") || 0);
      if (len > MAX_POST_BYTES) return textResponse(413, "body too large", origin);
      const buf = await request.arrayBuffer();
      if (buf.byteLength > MAX_POST_BYTES) return textResponse(413, "body too large", origin);
      body = buf;
    }

    // リダイレクトは手動で追い、毎回ホスト許可リストを確認する
    let upstream;
    let url = target;
    let method = request.method;
    for (let i = 0; ; i++) {
      try {
        upstream = await fetch(url.toString(), { method, headers: fwd, body, redirect: "manual" });
      } catch (err) {
        return textResponse(502, `upstream fetch failed: ${err && err.message}`, origin);
      }
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const loc = upstream.headers.get("Location");
      if (!loc) break;
      if (i >= MAX_REDIRECTS) return textResponse(508, "too many redirects", origin);
      let next;
      try { next = new URL(loc, url); } catch (_) { return textResponse(502, "bad redirect", origin); }
      if (next.protocol !== "https:" || !hostAllowed(next.hostname, allowedHosts)) {
        return textResponse(403, `redirect target host not allowed: ${next.hostname}`, origin);
      }
      if (upstream.status === 303 || ((upstream.status === 301 || upstream.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        fwd.delete("content-type");
      }
      url = next;
    }

    const h = corsHeaders(origin);
    for (const name of FORWARD_RES_HEADERS) {
      const v = upstream.headers.get(name);
      if (v) h.set(name, v);
    }
    // 上流が圧縮していた場合、fetch は展開済みなので元の Content-Length は不正確 → 落とす
    if (upstream.headers.get("content-encoding")) h.delete("content-length");
    h.set("X-Proxy-Final-Url", url.toString());

    // body はストリームのまま素通し（Worker のメモリに溜めない）
    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: h,
    });
  },
};

import { ProxyAgent, type Dispatcher } from 'undici';

export const dynamic = 'force-dynamic';
export const maxDuration = 180;

// 支持 HTTPS_PROXY / HTTP_PROXY 走自建正向代理出网。
// 部分上游(尤其挂 Cloudflare 的公益站)按 ASN 拉黑云厂商 IP 段,
// 配置代理地址即可换一个出网 IP。与生图/Tripo 路由的做法保持一致。
function getProxyDispatcher(): Dispatcher | undefined {
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY;
  return proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
}

// 浏览器与托管平台附加的这些头不该原样转给第三方 API:
// cookie/origin/referer 会把本站凭据和来源泄露给任意上游;
// sec-* / cf-* / x-forwarded-* / x-vercel-* 这类组合会暴露"这是机房里的服务端转发",
// 是 Cloudflare 托管 WAF 触发拦截的常见原因。
const BLOCKED_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  'cookie',
  'cookie2',
  'origin',
  'referer',
  'forwarded',
  'cdn-loop',
  'x-real-ip',
  'x-middleware-prefetch',
  'purpose',
  'priority',
]);

const BLOCKED_PREFIXES = ['sec-', 'cf-', 'x-forwarded-', 'x-vercel-', 'x-amz-cf-'];

function buildForwardHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    const name = key.toLowerCase();
    if (BLOCKED_HEADERS.has(name)) return;
    if (BLOCKED_PREFIXES.some(prefix => name.startsWith(prefix))) return;
    headers.set(key, value);
  });
  // 不带 UA 的请求在 Cloudflare 眼里就是脚本,补一个常规浏览器 UA
  if (!headers.has('user-agent')) {
    headers.set(
      'user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    );
  }
  return headers;
}

async function handler(req: Request, { params }: { params: { path: string[] } }) {
  // 路径第一段是目标域名(比如 youzi.today),后面才是真正的接口路径
  const [targetHost, ...rest] = params.path;
  const url = new URL(req.url);
  const targetUrl = `https://${targetHost}/${rest.join('/')}${url.search}`;

  const headers = buildForwardHeaders(req.headers);

  const init: RequestInit = {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
  };

  const dispatcher = getProxyDispatcher();
  const resp = dispatcher
    ? await fetch(targetUrl, { ...init, dispatcher } as RequestInit & { dispatcher: Dispatcher })
    : await fetch(targetUrl, init);

  const respHeaders = new Headers(resp.headers);
  respHeaders.delete('content-encoding');
  respHeaders.delete('content-length');
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Access-Control-Allow-Headers', '*');
  respHeaders.set('Access-Control-Allow-Methods', '*');

  return new Response(resp.body, {
    status: resp.status,
    headers: respHeaders,
  });
}

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as DELETE,
  handler as PATCH,
};

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    },
  });
}

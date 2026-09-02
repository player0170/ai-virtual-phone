export const dynamic = 'force-dynamic';

async function handler(req: Request, { params }: { params: { path: string[] } }) {
  // 路径第一段是目标域名(比如 youzi.today),后面才是真正的接口路径
  const [targetHost, ...rest] = params.path;
  const url = new URL(req.url);
  const targetUrl = `https://${targetHost}/${rest.join('/')}${url.search}`;

  const headers = new Headers(req.headers);
  headers.delete('host');

  const init: RequestInit = {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
  };

  const resp = await fetch(targetUrl, init);

  const respHeaders = new Headers(resp.headers);
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

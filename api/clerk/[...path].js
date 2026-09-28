const clerkFrontendApi = 'https://frontend-api.clerk.dev';

function clientIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  return typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : request.headers['x-real-ip'] || '';
}

function requestBody(request) {
  if (request.body === undefined || request.body === null || request.body === '') return undefined;
  if (typeof request.body === 'string' || Buffer.isBuffer(request.body)) return request.body;
  return JSON.stringify(request.body);
}

function proxyPath(requestUrl) {
  const path = requestUrl.pathname.startsWith('/__clerk') ? requestUrl.pathname.slice('/__clerk'.length) : requestUrl.pathname.slice('/api/clerk'.length);
  return path || '/';
}

export default async function handler(request, response) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const proxyUrl = process.env.CLERK_PROXY_URL || `https://${request.headers.host}/__clerk`;
  if (!secretKey) return response.status(503).json({ error: 'Clerk proxy is not configured' });
  try {
    const requestUrl = new URL(request.url || '/', `https://${request.headers.host}`);
    const targetUrl = new URL(`${clerkFrontendApi}${proxyPath(requestUrl)}`);
    targetUrl.search = requestUrl.search;
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (!value || ['host', 'content-length', 'connection'].includes(name.toLowerCase())) continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    headers.set('Clerk-Proxy-Url', proxyUrl);
    headers.set('Clerk-Secret-Key', secretKey);
    headers.set('X-Forwarded-For', clientIp(request));
    const upstream = await fetch(targetUrl, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : requestBody(request), redirect: 'manual' });
    for (const [name, value] of upstream.headers) if (!['content-length', 'connection', 'transfer-encoding'].includes(name.toLowerCase())) response.setHeader(name, value);
    response.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    response.status(502).json({ error: 'Clerk proxy request failed' });
  }
}

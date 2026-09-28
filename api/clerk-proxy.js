const clerkFrontendApi = 'https://frontend-api.clerk.dev';

function clientIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  return typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : request.headers['x-real-ip'] || '';
}

function requestBody(request) {
  if (request.body === undefined || request.body === null || request.body === '') return undefined;
  if (typeof request.body === 'string' || Buffer.isBuffer(request.body)) return request.body;
  const contentType = request.headers['content-type'] || request.headers['Content-Type'] || '';
  if (contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams();
    for (const [name, value] of Object.entries(request.body)) {
      if (Array.isArray(value)) value.forEach(item => form.append(name, String(item)));
      else if (value !== undefined && value !== null) form.append(name, String(value));
    }
    return form.toString();
  }
  return JSON.stringify(request.body);
}

function clerkPath(requestUrl) {
  const path = requestUrl.searchParams.get('path') || '/';
  if (!path.startsWith('/') || path.includes('..')) throw new Error('Invalid Clerk proxy path');
  return path;
}

export default async function handler(request, response) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const proxyUrl = process.env.CLERK_PROXY_URL || `https://${request.headers.host}/__clerk`;
  if (!secretKey) return response.status(503).json({ error: 'Clerk proxy is not configured' });
  try {
    const requestUrl = new URL(request.url || '/', `https://${request.headers.host}`);
    const targetUrl = new URL(`${clerkFrontendApi}${clerkPath(requestUrl)}`);
    targetUrl.search = requestUrl.search;
    targetUrl.searchParams.delete('path');
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (!value || ['host', 'content-length', 'connection'].includes(name.toLowerCase())) continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    headers.set('Clerk-Proxy-Url', proxyUrl);
    headers.set('Clerk-Secret-Key', secretKey);
    headers.set('X-Forwarded-For', clientIp(request));
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : requestBody(request),
      redirect: 'manual'
    });
    for (const [name, value] of upstream.headers) {
      const lowerName = name.toLowerCase();
      if (['content-length', 'content-encoding', 'connection', 'transfer-encoding'].includes(lowerName)) continue;
      if (lowerName === 'set-cookie' && typeof upstream.headers.getSetCookie === 'function') {
        response.setHeader('set-cookie', upstream.headers.getSetCookie());
      } else {
        response.setHeader(name, value);
      }
    }
    response.statusCode = upstream.status;
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    response.status(502).json({ error: 'Clerk proxy request failed' });
  }
}

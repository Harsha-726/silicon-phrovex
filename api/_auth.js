import { createPublicKey, verify as verifySignature } from 'node:crypto';

const json = (response, status, body) => response.status(status).json(body);
let jwksCache = { expiresAt: 0, value: null };

function decodePart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

async function clerkJwks(force = false) {
  const url = process.env.CLERK_JWKS_URL;
  if (!url) throw new Error('CLERK_JWKS_URL is not configured');
  if (!force && jwksCache.value && jwksCache.expiresAt > Date.now()) return jwksCache.value;
  const response = await fetch(url);
  if (!response.ok) throw new Error('Unable to load Clerk JWKS');
  jwksCache = { value: await response.json(), expiresAt: Date.now() + 5 * 60 * 1000 };
  return jwksCache.value;
}

export async function requireClerkUser(request, response) {
  const authorization = request.headers.authorization || request.headers.Authorization;
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return { error: json(response, 401, { error: 'Authentication required' }) };
  if (!process.env.CLERK_ISSUER || !process.env.CLERK_JWKS_URL) return { error: json(response, 503, { error: 'Authentication service is not configured' }) };
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature || token.length > 12_000) throw new Error('Malformed token');
    const header = decodePart(encodedHeader);
    const payload = decodePart(encodedPayload);
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== 'RS256' || !payload.sub || payload.iss !== process.env.CLERK_ISSUER || !Number.isFinite(payload.exp) || payload.exp <= now || (payload.nbf && payload.nbf > now)) throw new Error('Invalid token claims');
    let keys = await clerkJwks();
    let jwk = keys.keys?.find(key => key.kid === header.kid);
    if (!jwk) {
      keys = await clerkJwks(true);
      jwk = keys.keys?.find(key => key.kid === header.kid);
    }
    if (!jwk) throw new Error('Signing key not found');
    const valid = verifySignature('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(encodedSignature, 'base64url'));
    if (!valid) throw new Error('Invalid token signature');
    return { userId: payload.sub, claims: payload };
  } catch {
    return { error: json(response, 401, { error: 'Invalid authentication token' }) };
  }
}

export async function supabaseRequest(path, options = {}) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase server configuration is incomplete');
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) { const error = new Error('Supabase request failed'); error.status = response.status; error.body = body; throw error; }
  return body;
}

export async function ensureProfile(userId) {
  await supabaseRequest('profiles', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ user_id: userId }])
  });
}

export { json };

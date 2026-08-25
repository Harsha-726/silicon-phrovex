const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Clerk's browser SDK is loaded once in index.html. Keeping this boundary tiny
// means the core app does not know anything about the auth provider.
export const clerk = typeof window !== 'undefined' && window.Clerk ? window.Clerk : null;
export const supabaseConfig = supabaseUrl && supabaseAnonKey ? { url: supabaseUrl, anonKey: supabaseAnonKey } : null;
export const platformStatus = {
  clerkConfigured: Boolean(clerkKey),
  supabaseConfigured: Boolean(supabaseConfig)
};

export async function getAuthHeaders() {
  const token = await window.Clerk?.session?.getToken?.();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Use this only from an authenticated server-backed adapter. The anon key is
// browser-safe, but it must never be treated as authorization for user data.
export async function supabaseRequest(path, options = {}) {
  if (!supabaseConfig) throw new Error('Supabase is not configured');
  const response = await fetch(`${supabaseConfig.url}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: supabaseConfig.anonKey, Authorization: `Bearer ${supabaseConfig.anonKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error(`Supabase request failed: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

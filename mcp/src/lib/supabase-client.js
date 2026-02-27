import { createClient } from '@supabase/supabase-js';

let _client = null;

export function getSupabaseClient() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_ANON_KEY/SUPABASE_SERVICE_KEY. ' +
      'Copy mcp/.env.example to mcp/.env and fill in your values.'
    );
  }

  _client = createClient(url, key);
  return _client;
}

export function getUserId() {
  const userId = process.env.KYT_USER_ID;
  if (!userId) {
    throw new Error('Missing KYT_USER_ID in .env — set to your auth.users UUID.');
  }
  return userId;
}

export async function callEdgeFunction(functionName, body) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const token = serviceKey || anonKey;

  if (!url || !token) {
    throw new Error('Missing SUPABASE_URL or auth key in .env');
  }

  const res = await fetch(`${url}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'apikey': anonKey || token,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Edge function ${functionName} returned ${res.status}`);
  }

  return res.json();
}

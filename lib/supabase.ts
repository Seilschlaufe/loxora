import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Persist through route remounts, Strict Mode and development hot reload.
const browserState = globalThis as typeof globalThis & {
  __lexoraSupabase?: {
    url: string;
    key: string;
    client: SupabaseClient;
  };
};
export function browserDb() {
  if (typeof window === "undefined") return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const existing = browserState.__lexoraSupabase;
  if (existing?.url === url && existing.key === key) return existing.client;
  const client = createClient(url, key);
  browserState.__lexoraSupabase = { url, key, client };
  return client;
}

export function serverDb(token: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw Error("Supabase не настроен");
  // Every server request uses its caller's JWT. Never use service_role or retain sessions.
  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export async function authorized(req: Request) {
  const match = /^Bearer ([^\s]+)$/i.exec(
    req.headers.get("authorization") || "",
  );
  if (!match || match[1].length > 16384) throw Error("AUTH");
  const token = match[1];
  const db = serverDb(token);
  // getUser verifies with Supabase Auth; decoded JWT claims alone are not trusted.
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw Error("AUTH");
  return { db, user: data.user };
}

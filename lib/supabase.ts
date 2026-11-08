import { createClient } from "@supabase/supabase-js";

export function browserDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && key ? createClient(url, key) : null;
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

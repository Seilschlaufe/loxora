import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(() => ({ auth: {} })) }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.create }));
import { browserDb, serverDb } from "../lib/supabase";
beforeEach(() => {
  mocks.create.mockClear();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-key");
  delete (globalThis as Record<string, unknown>).__lexoraSupabase;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete (globalThis as Record<string, unknown>).__lexoraSupabase;
});
it("reuses one auth client across repeated browser calls and module reloads", async () => {
  vi.stubGlobal("window", {});
  const first = browserDb();
  expect(browserDb()).toBe(first);
  vi.resetModules();
  const fresh = await import("../lib/supabase");
  expect(fresh.browserDb()).toBe(first);
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
it("does not create a persistent browser auth client during server rendering", () => {
  expect(browserDb()).toBeNull();
  expect(mocks.create).not.toHaveBeenCalled();
});
it("keeps server clients separate for different JWTs", () => {
  serverDb("token-a");
  serverDb("token-b");
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(mocks.create.mock.calls[0]).toEqual([
    "https://example.supabase.co",
    "public-key",
    {
      global: { headers: { Authorization: "Bearer token-a" } },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  ]);
});

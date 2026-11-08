import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { demoAnalysis, context } from "../lib/analysis";
const mocks = vi.hoisted(() => ({ authorized: vi.fn(), parse: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ authorized: mocks.authorized }));
vi.mock("openai", () => ({
  default: class {
    responses = { parse: mocks.parse };
  },
}));
import { POST } from "../app/api/analyze/route";

const doc = {
  id: "ba4720dd-864d-40b1-a3cf-1ffb07ec0f43",
  owner_id: "user-a",
  content: "Er beschloss zu gehen.",
  language: "de",
};
function body(overrides: Record<string, unknown> = {}) {
  return {
    document_id: doc.id,
    selected: "beschloss",
    start: 3,
    end: 12,
    ...overrides,
  };
}
function request(value = body()) {
  return new Request("http://localhost/api/analyze", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify(value),
  });
}
function database({
  document = doc as typeof doc | null,
  cached = null as unknown,
  cachedAfterLease = null as unknown,
  lease = "ok",
} = {}) {
  let cacheReads = 0;
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const rpc = vi.fn().mockResolvedValue({ data: lease, error: null });
  const from = vi.fn((table: string) => {
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      delete: vi.fn(() => chain),
      single: vi.fn(async () => {
        if (table === "documents") return { data: document };
        const item = ++cacheReads === 1 ? cached : cachedAfterLease || cached;
        return { data: item ? { analysis: item } : null };
      }),
      upsert,
    };
    return chain;
  });
  return { from, rpc, upsert };
}
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-only-key");
  mocks.authorized.mockReset();
  mocks.parse.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("analysis API ownership and input boundary", () => {
  it("rejects a streamed oversized body without Content-Length", async () => {
    const db = database();
    mocks.authorized.mockResolvedValue({ db, user: { id: "user-a" } });
    const cancel = vi.fn();
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
        if (++sent === 8) controller.close();
      },
      cancel,
    });
    const req = new Request("http://localhost/api/analyze", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(req.headers.has("content-length")).toBe(false);
    const response = await POST(req);
    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
    expect(mocks.parse).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON before accessing data", async () => {
    const db = database();
    mocks.authorized.mockResolvedValue({ db, user: { id: "user-a" } });
    const req = new Request("http://localhost/api/analyze", {
      method: "POST",
      body: '{"incomplete":',
      headers: { authorization: "Bearer test-token" },
    });
    const response = await POST(req);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Некорректный JSON" });
    expect(db.from).not.toHaveBeenCalled();
    expect(mocks.parse).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated requests before accessing documents or model", async () => {
    mocks.authorized.mockRejectedValue(Error("AUTH"));
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.parse).not.toHaveBeenCalled();
  });
  it("rejects documents not visible under RLS without querying the model", async () => {
    const db = database({ document: null });
    mocks.authorized.mockResolvedValue({ db, user: { id: "user-b" } });
    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(mocks.parse).not.toHaveBeenCalled();
  });
  it("rejects forged offsets and reversed selections", async () => {
    const db = database();
    mocks.authorized.mockResolvedValue({ db, user: { id: "user-a" } });
    expect(
      (await POST(request(body({ selected: "something else" })))).status,
    ).toBe(400);
    expect((await POST(request(body({ start: 12, end: 3 })))).status).toBe(400);
    expect(
      (
        await POST(
          request(
            body({
              start: 0,
              end: doc.content.length + 100,
              selected: doc.content,
            }),
          ),
        )
      ).status,
    ).toBe(400);
    expect(mocks.parse).not.toHaveBeenCalled();
  });
  it("validates UUIDs and selected length before querying documents", async () => {
    const db = database();
    mocks.authorized.mockResolvedValue({ db, user: { id: "user-a" } });
    expect(
      (await POST(request(body({ document_id: "not-a-uuid" })))).status,
    ).toBe(400);
    expect(
      (await POST(request(body({ selected: "x".repeat(201) })))).status,
    ).toBe(400);
    expect(db.from).not.toHaveBeenCalled();
  });
});

describe("cache, quotas, model response and failure handling", () => {
  it("rechecks a newly populated cache after the lease before a paid request", async () => {
    const analysis = demoAnalysis("beschloss", doc.content, "de");
    const db = database({ cachedAfterLease: analysis });
    mocks.authorized.mockResolvedValue({ db, user: { id: "user-a" } });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ analysis, cached: true });
    expect(db.rpc).toHaveBeenCalledWith("claim_analysis", {
      p_key: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
    expect(db.from).toHaveBeenCalledWith("analysis_leases");
  });
  it("opens a cached full card without a paid request or a key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const analysis = demoAnalysis("beschloss", doc.content, "de");
    const db = database({ cached: analysis });
    mocks.authorized.mockResolvedValue({ db, user: { id: "user-a" } });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ analysis, cached: true });
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it.each(["busy", "limited"])(
    "enforces an atomic %s lease/quota before invoking the model",
    async (lease) => {
      const db = database({ lease });
      mocks.authorized.mockResolvedValue({ db, user: { id: "user-a" } });
      expect((await POST(request())).status).toBe(429);
      expect(mocks.parse).not.toHaveBeenCalled();
    },
  );
  it("validates and stores the complete structured response for its owner", async () => {
    const db = database();
    mocks.authorized.mockResolvedValue({ db, user: { id: "user-a" } });
    const analysis = demoAnalysis(
      "beschloss",
      context(doc.content, 3, 12, "de"),
      "de",
    );
    mocks.parse.mockResolvedValue({ output_parsed: analysis });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ analysis, cached: false });
    expect(db.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ owner_id: "user-a", analysis }),
      { onConflict: "owner_id,cache_key" },
    );
  });
  it("rejects a hallucinated or malformed word and never saves it", async () => {
    const db = database();
    mocks.authorized.mockResolvedValue({ db, user: { id: "user-a" } });
    mocks.parse.mockResolvedValue({
      output_parsed: { ...demoAnalysis("anderes", doc.content, "de") },
    });
    expect((await POST(request())).status).toBe(502);
    expect(db.upsert).not.toHaveBeenCalled();
  });
  it("handles provider failures without exposing provider secrets", async () => {
    const db = database();
    mocks.authorized.mockResolvedValue({ db, user: { id: "user-a" } });
    mocks.parse.mockRejectedValue(
      Error("API key test-only-key upstream timeout"),
    );
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("test-only-key");
    expect(db.from).toHaveBeenCalledWith("analysis_leases");
  });
  it("reports a missing key instead of fabricating an AI result", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const db = database();
    mocks.authorized.mockResolvedValue({ db, user: { id: "user-a" } });
    expect((await POST(request())).status).toBe(503);
    expect(mocks.parse).not.toHaveBeenCalled();
  });
});

describe("actionable analysis failures without secret leakage", () => {
  it.each([
    [{ status: 429, code: "insufficient_quota" }, 503, "Billing"],
    [{ status: 401 }, 502, "API-ключ"],
    [{ status: 404, code: "model_not_found" }, 503, "OPENAI_MODEL"],
    [{ status: 429, code: "rate_limit_exceeded" }, 429, "ограничил"],
    [{ status: 403 }, 503, "запретил"],
    [{ name: "APIConnectionTimeoutError" }, 504, "вовремя"],
    [{ name: "APIConnectionError" }, 502, "подключиться"],
    [{ status: 400 }, 502, "параметры"],
  ])("classifies %j safely", async (error, status, expected) => {
    const db = database();
    mocks.authorized.mockResolvedValue({ db, user: { id: "user-a" } });
    mocks.parse.mockRejectedValue({
      ...error,
      message: "SECRET-KEY-DO-NOT-LEAK",
    });
    const response = await POST(request());
    expect(response.status).toBe(status);
    const text = await response.text();
    expect(text).toContain(expected);
    expect(text).not.toContain("SECRET-KEY-DO-NOT-LEAK");
    expect(db.upsert).not.toHaveBeenCalled();
    expect(db.from).toHaveBeenCalledWith("analysis_leases");
  });
  it("distinguishes storage errors from a failed model call", async () => {
    const db = database();
    mocks.authorized.mockResolvedValue({ db, user: { id: "user-a" } });
    mocks.parse.mockResolvedValue({
      output_parsed: demoAnalysis(
        "beschloss",
        context(doc.content, 3, 12, "de"),
        "de",
      ),
    });
    db.upsert.mockResolvedValue({
      error: { message: "SECRET DATABASE DETAILS" },
    } as never);
    const response = await POST(request());
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain("не сохранён");
    expect(text).not.toContain("SECRET DATABASE DETAILS");
  });
});

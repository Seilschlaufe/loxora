import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { demoAnalysis, demoExpanded } from "../lib/analysis";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  fetch: vi.fn(),
  cache: new Map<string, unknown>(),
}));
vi.mock("../lib/local", () => ({
  readLocal: mocks.read,
  writeLocal: mocks.write,
}));
import { requestAnalysis } from "../lib/analysis-client";
const compact = demoAnalysis("beschloss", "Er beschloss zu gehen.", "de");
const source = {
  document_id: "doc-a",
  selected: "beschloss",
  start: 3,
  end: 12,
};
const options = {
  scope: "user-a",
  token: "jwt-a",
  source,
  selection: {
    word: "beschloss",
    sentence: compact.original_sentence,
    language: "de" as const,
  },
  canStore: () => true,
};
beforeEach(() => {
  mocks.cache.clear();
  mocks.fetch.mockReset();
  mocks.write.mockReset();
  mocks.read.mockReset();
  mocks.read.mockImplementation(async (key: string) => mocks.cache.get(key));
  mocks.write.mockImplementation(async (key: string, value: unknown) => {
    mocks.cache.set(key, value);
  });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) =>
    Response.json({
      analysis:
        JSON.parse(String(init.body)).mode === "expanded"
          ? demoExpanded(compact)
          : compact,
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
it("opening compact analysis sends only a compact request; explicit expanded call uses another schema/cache", async () => {
  const result = await requestAnalysis({ ...options, mode: "compact" });
  expect(result).toEqual(compact);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).mode).toBe("compact");
  await requestAnalysis({ ...options, mode: "compact" });
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  const expanded = await requestAnalysis({
    ...options,
    mode: "expanded",
    compact,
  });
  expect(expanded).toEqual(demoExpanded(compact));
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(mocks.cache.size).toBe(2);
  await requestAnalysis({ ...options, mode: "expanded", compact });
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});
it("coalesces simultaneous paid calls separately for each mode", async () => {
  await Promise.all([
    requestAnalysis({ ...options, mode: "compact" }),
    requestAnalysis({ ...options, mode: "compact" }),
  ]);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  await Promise.all([
    requestAnalysis({ ...options, mode: "expanded", compact }),
    requestAnalysis({ ...options, mode: "expanded", compact }),
  ]);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});
it("never shares pending responses across accounts", async () => {
  await Promise.all([
    requestAnalysis({ ...options, mode: "compact" }),
    requestAnalysis({
      ...options,
      mode: "compact",
      scope: "user-b",
      token: "jwt-b",
    }),
  ]);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(mocks.fetch.mock.calls.map((c) => c[1].headers.Authorization)).toEqual(
    ["Bearer jwt-a", "Bearer jwt-b"],
  );
});
it("rejects an offline expansion while keeping the cached compact result usable", async () => {
  await requestAnalysis({ ...options, mode: "compact" });
  vi.stubGlobal("navigator", { onLine: false });
  await expect(
    requestAnalysis({ ...options, mode: "expanded", compact }),
  ).rejects.toThrow("Нет подключения");
  await expect(
    requestAnalysis({ ...options, mode: "compact" }),
  ).resolves.toEqual(compact);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});
it("keeps late results out of storage after account data deletion", async () => {
  await requestAnalysis({ ...options, mode: "compact", canStore: () => false });
  expect(mocks.write).not.toHaveBeenCalled();
});
it("separates source spans at different document selections", async () => {
  await requestAnalysis({ ...options, mode: "compact" });
  await requestAnalysis({
    ...options,
    mode: "compact",
    source: { ...source, document_id: "doc-b", start: 103, end: 112 },
  });
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});

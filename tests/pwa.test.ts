import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
const publicFile = (path: string) =>
  readFileSync(new URL("../public/" + path, import.meta.url));
describe("installable assets", () => {
  it("declares standalone mode, Russian language and usable regular and maskable icons", () => {
    const manifest = JSON.parse(publicFile("manifest.webmanifest").toString());
    expect(manifest.display).toBe("standalone");
    expect(manifest.lang).toBe("ru");
    expect(manifest.start_url).toBe("/");
    expect(
      manifest.icons.some((i: { purpose: string }) => i.purpose === "maskable"),
    ).toBe(true);
    for (const icon of manifest.icons) {
      const bytes = publicFile(icon.src.slice(1));
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe(
        icon.sizes,
      );
    }
  });
});

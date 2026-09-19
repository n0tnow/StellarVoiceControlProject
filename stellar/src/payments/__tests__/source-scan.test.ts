/**
 * Source scan: the pure payment modules must stay browser-safe — no Node
 * `Buffer` global and no `node:` imports (slice analysis §G.2, §H.3).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PURE_MODULES = ["aliases.ts", "assets.ts", "summary.ts", "sendPayment.ts"];

function read(name: string): string {
  const src = readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");
  // Ignore comments: the prose explains that Buffer must not be used, which is
  // not itself a use of it.
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("pure payment modules are browser-safe", () => {
  for (const file of PURE_MODULES) {
    it(`${file} does not use the Buffer global`, () => {
      expect(read(file)).not.toMatch(/\bBuffer\b/);
    });
    it(`${file} does not import a node: builtin`, () => {
      expect(read(file)).not.toMatch(/["']node:/);
    });
  }
});

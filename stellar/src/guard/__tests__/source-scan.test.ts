/**
 * Source scans for the guard module:
 *  - the deployed v0.1 contract id must never be hard-coded (D9: contract id is
 *    always a parameter, so v0.1 and a future v2 can run side by side);
 *  - the guard modules stay browser-safe (no Node `Buffer` global, no `node:`
 *    imports), matching the payments modules they are wired into.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const GUARD_DIR = fileURLToPath(new URL("..", import.meta.url));
const DEPLOYED_ID = "CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D";
const STRKEY_CONTRACT = /\bC[A-Z2-7]{55}\b/;

/** Non-test guard sources only (the scans' own fixtures are excluded). */
function sourceFiles(): string[] {
  return readdirSync(GUARD_DIR).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
}

function read(name: string): string {
  return readFileSync(join(GUARD_DIR, name), "utf8");
}

describe("guard sources are contract-id parametrised", () => {
  it("never contains the deployed v0.1 contract id", () => {
    for (const file of sourceFiles()) {
      expect(read(file), `${file} must not hard-code the deployed contract id`).not.toContain(DEPLOYED_ID);
    }
  });

  it("contains no strkey contract-id literal at all", () => {
    for (const file of sourceFiles()) {
      expect(read(file), `${file} must not embed a contract id`).not.toMatch(STRKEY_CONTRACT);
    }
  });

  it("takes the contract id from the options (createGuardClient)", () => {
    expect(read("client.ts")).toMatch(/contractId: string/);
    expect(read("client.ts")).not.toMatch(/GUARD_CONTRACT_ID\s*=/);
  });
});

describe("guard modules are browser-safe", () => {
  for (const file of sourceFiles()) {
    it(`${file} does not use the Buffer global`, () => {
      const src = read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(src).not.toMatch(/\bBuffer\b/);
    });
    it(`${file} does not import a node: builtin`, () => {
      expect(read(file)).not.toMatch(/["']node:/);
    });
  }
});

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  KEY_ROLES,
  keypairOf,
  loadOrCreateKeys,
  newKeysFile,
  publicAddresses,
  repairPermissions,
  writeKeys,
} from "../keys.ts";

let dir: string;
let path: string;

beforeAll(() => {
  // Temp dir INSIDE the worktree; removed after the suite.
  dir = mkdtempSync(join(process.cwd(), ".tmp-live-keys-"));
  path = join(dir, "keys.json");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("key store", () => {
  it("generates all roles with valid public keys", () => {
    const file = newKeysFile();
    for (const role of KEY_ROLES) {
      expect(file.keys[role].public).toMatch(/^G[A-Z2-7]{55}$/);
      expect(file.keys[role].secret).toMatch(/^S[A-Z2-7]{55}$/);
      expect(keypairOf(file, role).publicKey()).toBe(file.keys[role].public);
    }
  });

  it("writes dir 0700 and file 0600", () => {
    const nested = join(dir, "sub", "keys.json");
    writeKeys(nested, newKeysFile());
    expect(statSync(join(dir, "sub")).mode & 0o777).toBe(0o700);
    expect(statSync(nested).mode & 0o777).toBe(0o600);
  });

  it("is idempotent without reset", () => {
    const first = loadOrCreateKeys(path);
    const second = loadOrCreateKeys(path);
    expect(second.keys.owner.public).toBe(first.keys.owner.public);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("regenerates every key with reset", () => {
    const before = loadOrCreateKeys(path);
    const after = loadOrCreateKeys(path, { reset: true });
    expect(after.keys.owner.public).not.toBe(before.keys.owner.public);
    expect(after.asset).toBeUndefined();
  });

  it("exposes only public addresses", () => {
    const file = loadOrCreateKeys(path);
    const addresses = publicAddresses(file);
    expect(Object.keys(addresses).sort()).toEqual([...KEY_ROLES].sort());
    expect(Object.values(addresses).every((a) => /^G/.test(a))).toBe(true);
  });

  it("repairs wrong permissions on load (review COR-2)", () => {
    const target = join(dir, "repair", "keys.json");
    writeKeys(target, newKeysFile());
    chmodSync(join(dir, "repair"), 0o777);
    chmodSync(target, 0o644);
    loadOrCreateKeys(target);
    expect(statSync(join(dir, "repair")).mode & 0o777).toBe(0o700);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("writes atomically and leaves no temp file behind (non-blocking #5)", () => {
    const atomicDir = join(dir, "atomic");
    const target = join(atomicDir, "keys.json");
    writeKeys(target, newKeysFile());
    expect(readdirSync(atomicDir)).toEqual(["keys.json"]);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect((JSON.parse(readFileSync(target, "utf8")) as { version: number }).version).toBe(1);
  });

  it("refuses to chmod through a symlinked key file (non-blocking #4)", () => {
    const realDir = join(dir, "symlink-real");
    mkdirSync(realDir, { recursive: true });
    const real = join(realDir, "keys.json");
    writeKeys(real, newKeysFile());
    chmodSync(real, 0o644);

    const linkDir = join(dir, "symlink-link");
    mkdirSync(linkDir, { recursive: true });
    const link = join(linkDir, "keys.json");
    symlinkSync(real, link);

    const warnings: string[] = [];
    repairPermissions(link, (message) => warnings.push(message));
    // The symlink target keeps its (wrong) mode; nothing was chmodded through it.
    expect(statSync(real).mode & 0o777).toBe(0o644);
    expect(warnings.join("\n")).toMatch(/symlink/i);

    // The same guard holds on the load path (`loadOrCreateKeys`).
    const moreWarnings: string[] = [];
    const loaded = loadOrCreateKeys(link, { warn: (message) => moreWarnings.push(message) });
    expect(loaded.network).toBe("testnet");
    expect(statSync(real).mode & 0o777).toBe(0o644);
    expect(moreWarnings.join("\n")).toMatch(/symlink/i);
  });
});

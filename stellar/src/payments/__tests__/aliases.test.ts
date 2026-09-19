import { fileURLToPath } from "node:url";
import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { loadAliasBook } from "../loadAliases.ts";
import { findAliasCollisions, parseAliasBook, resolveAlias } from "../aliases.ts";
import { ADA } from "./helpers.ts";

const VALID = {
  ada: { address: ADA, network: "testnet", ctRegistered: true },
  bob: { address: "GB3HO3WGM273M2OZLE5DVRN5WNCNSART6H6SAHP4CXGK34MMGNNDYLX5", network: "testnet" },
};

describe("parseAliasBook", () => {
  it("accepts a valid book and keeps the optional flags", () => {
    const { book, warnings } = parseAliasBook(VALID);
    expect(Object.keys(book)).toEqual(["ada", "bob"]);
    expect(book.ada).toEqual({ address: ADA, network: "testnet", ctRegistered: true });
    expect(book.bob?.sppReady).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("builds the book with a null prototype", () => {
    const { book } = parseAliasBook(VALID);
    expect(Object.getPrototypeOf(book)).toBeNull();
    expect((book as Record<string, unknown>).toString).toBeUndefined();
  });

  it.each(["__proto__", "constructor", "prototype"])("rejects the reserved alias name %s", (name) => {
    expect(() => parseAliasBook({ [name]: { address: ADA, network: "testnet" } })).toThrow(
      /reserved and cannot be used/,
    );
  });

  it("accepts a JSON string", () => {
    const { book } = parseAliasBook(JSON.stringify(VALID));
    expect(book.ada?.address).toBe(ADA);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseAliasBook("{not json")).toThrow(/not valid JSON/);
  });

  it("rejects a non-object book", () => {
    expect(() => parseAliasBook([])).toThrow(/JSON object/);
    expect(() => parseAliasBook(42)).toThrow(/JSON object/);
  });

  it("rejects an invalid alias name", () => {
    expect(() => parseAliasBook({ Ada: { address: ADA, network: "testnet" } })).toThrow(/alias name/);
    expect(() => parseAliasBook({ "1ada": { address: ADA, network: "testnet" } })).toThrow(/alias name/);
  });

  it("rejects an invalid address checksum", () => {
    expect(() => parseAliasBook({ ada: { address: "GNOTAREALADDRESS", network: "testnet" } })).toThrow(/invalid Stellar address/);
  });

  it("rejects a non-testnet network", () => {
    expect(() => parseAliasBook({ ada: { address: ADA, network: "public" } })).toThrow(/testnet/);
  });

  it("rejects a non-boolean flag", () => {
    expect(() => parseAliasBook({ ada: { address: ADA, network: "testnet", ctRegistered: "yes" } })).toThrow(/ctRegistered/);
  });

  it("reports an address collision as a warning but keeps both aliases", () => {
    const { book, warnings } = parseAliasBook({
      ada: { address: ADA, network: "testnet" },
      alias2: { address: ADA, network: "testnet" },
    });
    expect(Object.keys(book)).toEqual(["ada", "alias2"]);
    expect(warnings).toEqual([`ada, alias2 all resolve to ${ADA}`]);
  });

  it("finds collisions and returns none for a clean book", () => {
    expect(findAliasCollisions({ ada: { address: ADA, network: "testnet" } })).toEqual([]);
  });
});

describe("resolveAlias", () => {
  const { book } = parseAliasBook(VALID);

  it("is case-insensitive and trims", () => {
    expect(resolveAlias(book, "  ADA ")?.address).toBe(ADA);
  });

  it("returns undefined for an unknown name or a raw address", () => {
    expect(resolveAlias(book, "nobody")).toBeUndefined();
    expect(resolveAlias(book, ADA)).toBeUndefined();
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])(
    "never resolves inherited Object.prototype member %s",
    (name) => {
      expect(resolveAlias(book, name)).toBeUndefined();
    },
  );

  it("also refuses prototype keys on a plain (non-null-proto) book", () => {
    const plain: Record<string, { address: string; network: "testnet" }> = {};
    expect(resolveAlias(plain, "constructor")).toBeUndefined();
    expect(resolveAlias(plain, "toString")).toBeUndefined();
  });
});

describe("committed stellar/config/aliases.json", () => {
  const CONFIG = fileURLToPath(new URL("../../../config/aliases.json", import.meta.url));

  it("loads, validates and seeds ada/bob/carol with no warnings", () => {
    const { book, warnings } = loadAliasBook(CONFIG);
    expect(Object.keys(book).sort()).toEqual(["ada", "bob", "carol"]);
    expect(warnings).toEqual([]);
    expect(book.ada?.address).toBe(ADA);
    expect(book.ada?.ctRegistered).toBe(true);
    expect(book.carol?.sppReady).toBe(false);
  });

  it("round-trips every committed alias address through the book", () => {
    const { book } = loadAliasBook(CONFIG);
    for (const name of Object.keys(book)) {
      const entry = resolveAlias(book, name);
      expect(entry).toBeDefined();
      expect(entry?.address).toBe(book[name]?.address);
      expect(StrKey.isValidEd25519PublicKey(entry?.address ?? "")).toBe(true);
    }
  });
});

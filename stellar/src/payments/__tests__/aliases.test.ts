import { fileURLToPath } from "node:url";
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
});

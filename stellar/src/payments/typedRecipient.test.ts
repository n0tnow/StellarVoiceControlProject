import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAliasBook, resolveAlias } from "./aliases.ts";

// The app registers a typed address under `to-<last 24 chars>`; the alias book
// must accept that name and the object entry shape (chain.recipientForTypedAddress).
test("a typed address registers under a short to-… alias the book accepts", () => {
  const address = "GAJW5V7VXHIRTJBGNVYTGXJ6CLDM7IEIPAYD3XLKKTKJKPRBYOTAC25A";
  const name = `to-${address.slice(-24).toLowerCase()}`;
  const { book } = parseAliasBook({ [name]: { address, network: "testnet" } });
  assert.equal(resolveAlias(book, name)?.address, address);
});

test("a bare string entry is rejected (the shape the first attempt used)", () => {
  assert.throws(
    () => parseAliasBook({ "to-x": "GAJW5V7VXHIRTJBGNVYTGXJ6CLDM7IEIPAYD3XLKKTKJKPRBYOTAC25A" }),
    /object/,
  );
});

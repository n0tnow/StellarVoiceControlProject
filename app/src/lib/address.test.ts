import assert from "node:assert/strict";
import { test } from "node:test";

import { shortAddress } from "./address.ts";

const OWNER = "GARXWVNCJ22U2OR23LAB5Z5RWI2XFIJZA2R3TRPFUKKY65JQZZOEWWCO";

test("shortAddress keeps the first and last four characters", () => {
  assert.equal(shortAddress(OWNER), "GARX…WWCO");
  assert.equal(shortAddress("GABC"), "GABC");
});

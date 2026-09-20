import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveAssetRows,
  fetchAccountDetail,
  formatReserved,
  formatStellarAmount,
  hasTrustline,
  mapAccountDetail,
  requestFriendbotFund,
  reservedTenths,
  shortIssuer,
  sortAccountBalances,
  trustlineRows,
  TRUSTLINE_ASSETS,
  USDC_FAUCET_URL,
  type HorizonAccountBalance,
} from "./walletAssets.ts";

test("amounts are formatted from strings, never a float", () => {
  assert.equal(formatStellarAmount("100.0000000"), "100");
  assert.equal(formatStellarAmount("847.2000000"), "847.2");
  assert.equal(formatStellarAmount("1234.5678900"), "1,234.56789");
  assert.equal(formatStellarAmount("0.0001000"), "0.0001");
  assert.equal(formatStellarAmount("1234567.1234567"), "1,234,567.1234567");
  assert.equal(formatStellarAmount("-5.5000000"), "-5.5");
  assert.equal(formatStellarAmount("12"), "12");
});

test("the native reserve is (2 + subentries) * 0.5 XLM", () => {
  assert.equal(reservedTenths(0), 10);
  assert.equal(reservedTenths(3), 25);
  assert.equal(formatReserved(reservedTenths(0)), "1 XLM reserved");
  assert.equal(formatReserved(reservedTenths(3)), "2.5 XLM reserved");
  assert.equal(formatReserved(reservedTenths(5)), "3.5 XLM reserved");
});

test("natives sort first, then code and issuer", () => {
  const rows: HorizonAccountBalance[] = [
    { assetType: "credit_alphanum4", code: "USDC", issuer: "GB", balance: "1", native: false, limit: "9" },
    { assetType: "native", code: "XLM", issuer: null, balance: "2", native: true, limit: null },
    { assetType: "credit_alphanum4", code: "AQUA", issuer: "GA", balance: "3", native: false, limit: "9" },
  ];
  assert.deepEqual(
    sortAccountBalances(rows).map((row) => row.code),
    ["XLM", "AQUA", "USDC"],
  );
});

test("issuers are shortened for the notch width", () => {
  assert.equal(shortIssuer(null), null);
  assert.equal(shortIssuer("GABCDEFGHIJKLMNOP"), "GABC…MNOP");
});

test("Horizon JSON maps to asset rows with the native reserve note", () => {
  const detail = mapAccountDetail({
    sequence: "123",
    subentry_count: 2,
    balances: [
      { asset_type: "native", balance: "100.0000000" },
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GDUKMGUGDZQK6YHYA5Z6AY2G4XDSZPSZ3SW5UN3ARVMO6QSRDWP5YLEX",
        balance: "5.0000000",
      },
    ],
  });
  assert.equal(detail.sequence, "123");
  assert.equal(detail.subentryCount, 2);
  const rows = deriveAssetRows(detail);
  assert.deepEqual(rows[0], {
    key: "native",
    code: "XLM",
    issuer: null,
    balance: "100",
    note: "2 XLM reserved",
    native: true,
  });
  assert.equal(rows[1]?.code, "USDC");
  assert.equal(rows[1]?.issuer, "GDUK…YLEX");
  assert.equal(rows[1]?.note, "credit");
});

test("a 404 is an unfunded account and a failure is offline", async () => {
  const notFound = await fetchAccountDetail("https://h", "GABC", {
    fetchImpl: () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
  });
  assert.equal(notFound.status, "not_found");

  const offline = await fetchAccountDetail("https://h", "GABC", {
    fetchImpl: () => Promise.reject(new Error("timeout")),
  });
  assert.equal(offline.status, "offline");
  if (offline.status === "offline") assert.match(offline.message, /timeout/);
});

test("Friendbot funding calls the faucet in-process with the public address", async () => {
  const calls: string[] = [];
  const ok = await requestFriendbotFund("GABC", {
    endpoint: "https://friendbot.test/",
    fetchImpl: (url) => {
      calls.push(String(url));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    },
  });
  assert.equal(ok.status, "ok");
  assert.deepEqual(calls, ["https://friendbot.test/?addr=GABC"]);

  const failed = await requestFriendbotFund("GABC", {
    fetchImpl: () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
  });
  assert.equal(failed.status, "failed");

  const unreachable = await requestFriendbotFund("GABC", {
    fetchImpl: () => Promise.reject(new Error("timeout")),
  });
  assert.equal(unreachable.status, "failed");
  if (unreachable.status === "failed") assert.match(unreachable.message, /timeout/);
});

test("the Add-asset catalog marks only the held trustlines as added", () => {
  const detail = mapAccountDetail({
    balances: [
      { asset_type: "native", balance: "100.0000000" },
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        balance: "5.0000000",
      },
    ],
  });
  assert.deepEqual(
    trustlineRows(detail).map((row) => [row.code, row.added]),
    [
      ["USDC", true],
      ["SRT", false],
    ],
  );
  assert.equal(trustlineRows(null)[0]?.added, false);
  assert.equal(hasTrustline(detail, "usdc"), true);
  assert.equal(hasTrustline(detail, "SRT"), false);
  assert.deepEqual(
    TRUSTLINE_ASSETS.map((asset) => asset.code),
    ["USDC", "SRT"],
  );
  assert.equal(USDC_FAUCET_URL, "https://faucet.circle.com/");
});

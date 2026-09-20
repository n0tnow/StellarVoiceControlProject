import assert from "node:assert/strict";
import { test } from "node:test";

import type { AliasEntryView, HorizonPaymentRecord } from "../../lib/history.ts";
import { mapAccountDetail } from "../../lib/walletAssets.ts";
import { deriveWalletPageView } from "./useWalletData.ts";

const OWNER = "GARXWVNCJ22U2OR23LAB5Z5RWI2XFIJZA2R3TRPFUKKY65JQZZOEWWCO";
const FRIEND = "GB3HO3WGM273M2OZLE5DVRN5WNCNSART6H6SAHP4CXGK34MMGNNDYLX5";

const ALIASES: AliasEntryView[] = [
  { name: "ada", address: FRIEND, source: "committed" },
];

function payment(overrides: Partial<HorizonPaymentRecord> = {}): HorizonPaymentRecord {
  return {
    id: "1",
    type: "payment",
    transaction_hash: "b".repeat(64),
    created_at: "2026-09-20T10:00:00Z",
    from: OWNER,
    to: FRIEND,
    amount: "1.0000000",
    asset_type: "native",
    successful: true,
    ...overrides,
  };
}

function readyInput(payments: HorizonPaymentRecord[]) {
  return {
    configLoaded: true,
    network: "testnet",
    ownerAddress: OWNER,
    account: {
      status: "ok" as const,
      balances: [
        { asset: "XLM", balance: "100.0000000", native: true },
        { asset: "USDC", balance: "847.2000000", native: false },
      ],
    },
    payments: { status: "ok" as const, payments },
    aliasEntries: ALIASES,
  };
}

test("the config is not assumed missing before it loads", () => {
  const view = deriveWalletPageView({
    configLoaded: false,
    network: "testnet",
    ownerAddress: null,
    account: null,
    payments: null,
  });
  assert.equal(view.status, "loading");
  assert.equal(view.ownerAddress, null);
});

test("a loaded config with no owner is unconfigured", () => {
  const view = deriveWalletPageView({
    configLoaded: true,
    network: "testnet",
    ownerAddress: null,
    account: null,
    payments: null,
  });
  assert.equal(view.status, "unconfigured");
  assert.match(view.message, /POLARIS_OWNER_ADDRESS/);
});

test("a null account means the balances are still loading", () => {
  const view = deriveWalletPageView({
    configLoaded: true,
    network: "testnet",
    ownerAddress: OWNER,
    account: null,
    payments: null,
  });
  assert.equal(view.status, "loading");
  assert.equal(view.explorerUrl, `https://stellar.expert/explorer/testnet/account/${OWNER}`);
});

test("a 404 account is unfunded and offers Friendbot", () => {
  const view = deriveWalletPageView({
    configLoaded: true,
    network: "testnet",
    ownerAddress: OWNER,
    account: { status: "not_found" },
    payments: null,
  });
  assert.equal(view.status, "unfunded");
  assert.match(view.friendbotUrl ?? "", /^https:\/\/friendbot\.stellar\.org\/\?addr=G/);
});

test("an unreachable Horizon is an offline state with the reason", () => {
  const view = deriveWalletPageView({
    configLoaded: true,
    network: "testnet",
    ownerAddress: OWNER,
    account: { status: "offline", message: "timeout" },
    payments: null,
  });
  assert.equal(view.status, "offline");
  assert.match(view.message, /timeout/);
});

test("a funded account maps balances, aliases and at most five payments", () => {
  const payments = Array.from({ length: 8 }, (_, index) =>
    payment({
      id: `p${index}`,
      created_at: `2026-09-${String(20 - index).padStart(2, "0")}T10:00:00Z`,
    }),
  );
  const view = deriveWalletPageView(readyInput(payments));

  assert.equal(view.status, "ready");
  assert.equal(view.network, "testnet");
  assert.deepEqual(view.assets, [
    { code: "XLM", balance: "100.0000000", note: "native" },
    { code: "USDC", balance: "847.2000000", note: "credit" },
  ]);
  assert.equal(view.transactions.length, 5);
  assert.equal(view.aliases[0]?.name, "ada");

  const sent = view.transactions[0];
  assert.equal(sent?.direction, "out");
  assert.equal(sent?.amount, "-1 XLM");
  assert.equal(sent?.summary, "Sent to ada");
  assert.equal(sent?.status, "success");
  assert.ok(sent?.explorerUrl?.startsWith("https://stellar.expert/explorer/testnet/tx/"));
  assert.equal(view.latestTransaction, null);
});

test("the session's tx_submitted event is surfaced as the latest transaction", () => {
  const hash = "a".repeat(64);
  const view = deriveWalletPageView({
    ...readyInput([]),
    latestTransaction: {
      hash,
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${hash}`,
    },
  });
  assert.equal(view.latestTransaction?.hash, hash);
});

test("the dashboard activity keeps up to ten rows and carries the account detail", () => {
  const payments = Array.from({ length: 12 }, (_, index) =>
    payment({
      id: `p${index}`,
      created_at: `2026-09-${String(20 - index).padStart(2, "0")}T10:00:00Z`,
    }),
  );
  const view = deriveWalletPageView({
    ...readyInput(payments),
    networkPassphrase: "Test SDF Network ; September 2015",
    accountDetail: mapAccountDetail({
      sequence: "42",
      subentry_count: 1,
      balances: [{ asset_type: "native", balance: "10.0000000" }],
    }),
  });
  assert.equal(view.transactions.length, 5);
  assert.equal(view.activity.length, 10);
  assert.equal(view.accountDetail?.subentryCount, 1);
  assert.match(view.networkPassphrase, /Test SDF Network/);
});

test("balances still load when the payments read is offline", () => {
  const view = deriveWalletPageView({
    configLoaded: true,
    network: "testnet",
    ownerAddress: OWNER,
    account: { status: "ok", balances: [{ asset: "XLM", balance: "5", native: true }] },
    payments: { status: "offline", message: "timeout" },
    aliasEntries: ALIASES,
  });
  assert.equal(view.status, "ready");
  assert.match(view.message, /recent transactions are unavailable/);
  assert.equal(view.transactions.length, 0);
});

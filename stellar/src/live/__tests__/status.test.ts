import { afterEach, describe, expect, it, vi } from "vitest";
import { main, renderStatus, statusJson, type StatusReport } from "../status.ts";

const GUARD = "CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D";
const OWNER = "GBKTFHHLB62NDBK6EGNXODHZO2AWZTT2HEGDM4IQTNWYDIHG3TODO7QU";
const EXECUTOR = "GDFX76I436JEQW5XWHATLQAJT6LF62TJRTI6YCFEEDHRUEKE5XQXU4OK";
const RECIPIENT = "GBKBLL2ICQZP5CJDURR3AA5TOJZQVW5UV2QR2EH36I2HGFG53EPY42WC";
const ISSUER = "GADH3U7N26OP74VVUDZWEH3ILSJ5WWMAZFRALEM7MOKAJUAH5V7EA5SA";
const KEEPER = "GB5NFVLPAO7EPRDN7QQSFLODFVTF4BMYPQO5ZGHOPE2V2O76XTNI44RO";
const SAC = "CBRBMTWR44FTXXKWFYD7NVL6PEXKH2FTJIYWT477ZOQVKEYYAKQ6K4KK";

function report(): StatusReport {
  return {
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    guardContractId: GUARD,
    asset: { code: "E2EUSD", issuer: ISSUER, sac: SAC },
    addresses: { owner: OWNER, executor: EXECUTOR, recipient: RECIPIENT, issuer: ISSUER, keeper: KEEPER },
    balances: [
      { role: "owner", address: OWNER, balance: "9735" },
      { role: "recipient", address: RECIPIENT, balance: "265" },
    ],
    rule: {
      auto_approve_limit: 0n,
      per_tx_limit: 1_000_000_000n,
      daily_limit: 20_000_000_000n,
      allowed_assets: [SAC],
      known_recipients_only: false,
    },
    ruleDecoded: {
      auto_approve_limit: "0",
      per_tx_limit: "100",
      daily_limit: "2000",
      allowed_assets: [SAC],
      known_recipients_only: false,
    },
    executor: null,
    aliasAda: RECIPIENT,
    spentToday: "240",
    spentTodayRaw: "2400000000",
    allowance: "4800",
    allowanceRaw: "48000000000",
    schedules: [
      {
        id: 7,
        to: RECIPIENT,
        amount: "5",
        amountRaw: "50000000",
        nextRunUtc: "2026-09-20T12:00:00.000Z",
        nextRunLocal: "2026-09-20T15:00:00+03:00",
        runsLeft: 1,
        intervalWords: "one-shot (no repeat)",
        active: true,
      },
    ],
    timeZone: "Europe/Istanbul",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderStatus", () => {
  it("prints addresses, balances, rule, alias, spent_today, allowance and schedules", () => {
    const text = renderStatus(report());
    expect(text).toContain(GUARD);
    expect(text).toContain(`E2EUSD:${ISSUER}`);
    for (const address of [OWNER, EXECUTOR, RECIPIENT, ISSUER, KEEPER]) expect(text).toContain(address);
    expect(text).toContain("9735");
    expect(text).toContain("per_tx_limit         100");
    expect(text).toContain("daily_limit          2000");
    expect(text).toContain("executor             (none)");
    expect(text).toContain(`alias ada            ${RECIPIENT}`);
    expect(text).toContain("spent_today          240");
    expect(text).toContain("SAC allowance        4800");
    expect(text).toContain("2026-09-20T15:00:00+03:00");
    expect(text).toContain("2026-09-20T12:00:00.000Z");
  });

  it("serializes raw bigints as strings for --json", () => {
    const parsed = JSON.parse(statusJson(report())) as { rule: { per_tx_limit: string } };
    expect(parsed.rule.per_tx_limit).toBe("1000000000");
  });
});

describe("e2e:status CLI", () => {
  it("without --live prints the plan and does no network I/O", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await main([]);
    expect(code).toBe(0);
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("plan (no network");
    expect(output).toContain(GUARD);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders help", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await main(["--help"]);
    expect(code).toBe(0);
    expect(writeSpy.mock.calls.map((c) => String(c[0])).join("")).toContain("e2e:status");
  });

  it("rejects an invalid --tz with a usage error", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await main(["--tz", "Not/AZone"]);
    expect(code).toBe(2);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("")).toContain("IANA zone");
  });
});

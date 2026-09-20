/**
 * Mock data for the notch panel pages (History / Tasks / Rules / Wallet).
 *
 * Everything here is local, fabricated and self-contained: no chain calls, no
 * agent wiring, no persistence beyond in-memory state. The shapes deliberately
 * mirror the terminology already designed for the real backend so the swap is
 * a data-source change, not a UI rewrite:
 *
 * - rules follow the `polaris_guard` on-chain rule engine
 *   (`backlog/guard-rules-schedule.md`): auto-approve limit, per-tx / daily
 *   limits, executor vs owner payment paths, and the "approval card" concept
 *   from the approval layer (`backlog/approval-policy.md` — `always_ask` /
 *   `auto_approve` profiles);
 * - scheduled tasks mirror the guard's scheduler (`create_schedule` /
 *   `next_run_at` / interval-based recurrence).
 */

/* ------------------------------------------------------------------ *
 * Shared bits
 * ------------------------------------------------------------------ */

export type TxStatus = "success" | "pending" | "failed";

/** `GAAAA…PROOF` — Stellar public keys are 56 chars; keep the two ends. */
export function truncateKey(key: string, head = 6, tail = 4): string {
  return key.length <= head + tail ? key : `${key.slice(0, head)}…${key.slice(-tail)}`;
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

export interface HistoryEntry {
  id: string;
  /** Unix epoch seconds. */
  timestamp: number;
  /** What the user said (Turkish transcripts are expected — the product is Turkish-first). */
  transcript: string;
  /** The agent's spoken/shown answer. */
  response: string;
  /** Resulting on-chain action, if the turn produced one. */
  action: string | null;
  status: TxStatus;
  /** Transaction hash when an action settled (or is in flight). */
  txHash: string | null;
}

export const MOCK_HISTORY: HistoryEntry[] = [
  {
    id: "h-001",
    timestamp: 1758278400, // 2026-09-19 09:12 UTC
    transcript: "Cüzdanımda ne kadar USDC var?",
    response: "Your balance is 847.20 USDC and 128.44 XLM.",
    action: null,
    status: "success",
    txHash: null,
  },
  {
    id: "h-002",
    timestamp: 1758283200, // 2026-09-19 10:40 UTC
    transcript: "Alice'e 10 USDC gönder.",
    response: "Sent 10 USDC to Alice (GBBD…FUTR). No approval needed — under your $20 auto-approve limit.",
    action: "send 10 USDC → Alice",
    status: "success",
    txHash: "c9f3a1d24e7b8c05f1a9e3d6b2c48f07a1e5d9c3b6a8f4e2d1c0b9a7f5e3d1c0b8",
  },
  {
    id: "h-003",
    timestamp: 1758290400, // 2026-09-19 12:40 UTC
    transcript: "Binance'e 500 USDC gönder.",
    response: "This is above your $200 per-transaction limit. Touch ID approval required.",
    action: "send 500 USDC → Binance deposit",
    status: "failed",
    txHash: null,
  },
  {
    id: "h-004",
    timestamp: 1758362400, // 2026-09-20 08:40 UTC
    transcript: "Her pazartesi bakiyemi kontrol edip rapor et.",
    response: "Scheduled: balance report every Monday at 09:00.",
    action: "schedule balance-report (weekly)",
    status: "success",
    txHash: null,
  },
  {
    id: "h-005",
    timestamp: 1758369600, // 2026-09-20 10:40 UTC
    transcript: "Savings'e 50 USDC gönder.",
    response: "Sending 50 USDC to Savings… waiting for confirmation.",
    action: "send 50 USDC → Savings",
    status: "pending",
    txHash: "3b7e2f91a4c6d8e0b1f3a5c7e9d1b3f5a7c9e1d3f5b7a9c1e3d5f7b9a1c3e5d7f9",
  },
];

/* ------------------------------------------------------------------ *
 * Scheduled tasks (mirrors the guard's scheduler)
 * ------------------------------------------------------------------ */

export type ScheduleRecurrence = "once" | "daily" | "weekly" | "monthly";

export interface ScheduledTask {
  id: string;
  /** Human-readable schedule text (the cron-ish string the user heard back). */
  schedule: string;
  recurrence: ScheduleRecurrence;
  /** What the agent will do. */
  description: string;
  enabled: boolean;
  /** Unix epoch seconds of the next run (the contract's `next_run_at`). */
  nextRunAt: number;
}

export const MOCK_SCHEDULED_TASKS: ScheduledTask[] = [
  {
    id: "t-001",
    schedule: "Every Monday at 09:00",
    recurrence: "weekly",
    description: "Check balance and report",
    enabled: true,
    nextRunAt: 1758435600, // 2026-09-21 09:00 UTC
  },
  {
    id: "t-002",
    schedule: "In 2 hours",
    recurrence: "once",
    description: "Send 5 USDC to Alice",
    enabled: true,
    nextRunAt: 1758387600, // 2026-09-20 15:40 UTC
  },
  {
    id: "t-003",
    schedule: "Daily at 08:30",
    recurrence: "daily",
    description: "Report overnight spending vs daily limit",
    enabled: false,
    nextRunAt: 1758447000, // 2026-09-21 08:30 UTC
  },
  {
    id: "t-004",
    schedule: "1st of every month at 10:00",
    recurrence: "monthly",
    description: "Move 50 USDC to Savings if balance ≥ 200 USDC",
    enabled: true,
    nextRunAt: 1759370400, // 2026-10-01 10:00 UTC
  },
];

/* ------------------------------------------------------------------ *
 * Rules / policies (mirrors the polaris_guard rule engine)
 * ------------------------------------------------------------------ */

export type ApprovalRequirement = "none" | "touch_id" | "always_ask";

export interface GuardRule {
  id: string;
  /** Short user-facing name. */
  name: string;
  /** The condition that must hold ("under $20", "balance ≥ $200"). */
  condition: string;
  /** What happens when the condition holds. */
  action: string;
  /** Approval profile applied when the action runs (approval-policy.md). */
  approval: ApprovalRequirement;
  enabled: boolean;
}

export const MOCK_RULES: GuardRule[] = [
  {
    id: "r-001",
    name: "Auto-approve limit",
    condition: "Any send under $20",
    action: "Execute without asking",
    approval: "none",
    enabled: true,
  },
  {
    id: "r-002",
    name: "Per-transaction limit",
    condition: "Any send up to $200",
    action: "Execute after Touch ID approval",
    approval: "touch_id",
    enabled: true,
  },
  {
    id: "r-003",
    name: "Hard per-transaction cap",
    condition: "Any send above $200",
    action: "Refuse — exceeds the guard's per_tx_limit",
    approval: "always_ask",
    enabled: true,
  },
  {
    id: "r-004",
    name: "Monthly savings sweep",
    condition: "Monthly, if balance ≥ $200",
    action: "Send $50 to Savings (GBBD…FUTR)",
    approval: "touch_id",
    enabled: false,
  },
];

/* ------------------------------------------------------------------ *
 * Wallet
 * ------------------------------------------------------------------ */

export interface WalletAsset {
  code: string;
  /** Display balance, already formatted to the asset's precision. */
  balance: string;
  /** Mock USD valuation of the holding. */
  usdValue: string;
}

export interface WalletTransaction {
  id: string;
  /** Unix epoch seconds. */
  timestamp: number;
  /** e.g. "Sent to Alice" / "Received from Coinbase". */
  summary: string;
  /** Signed display amount, e.g. "-10.00 USDC" / "+25.00 XLM". */
  amount: string;
  direction: "in" | "out";
  status: TxStatus;
  txHash: string;
}

export interface WalletOverview {
  publicKey: string;
  assets: WalletAsset[];
  /** Quick stats for the month-to-date strip. */
  monthlySpendUsd: string;
  monthlyBudgetUsd: string;
  transactions: WalletTransaction[];
}

export const MOCK_WALLET: WalletOverview = {
  publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
  assets: [
    { code: "XLM", balance: "128.44", usdValue: "$15.84" },
    { code: "USDC", balance: "847.20", usdValue: "$847.20" },
  ],
  monthlySpendUsd: "$142.50",
  monthlyBudgetUsd: "$300.00",
  transactions: [
    {
      id: "w-001",
      timestamp: 1758369600,
      summary: "Sent to Savings",
      amount: "-50.00 USDC",
      direction: "out",
      status: "pending",
      txHash: "3b7e2f91a4c6d8e0b1f3a5c7e9d1b3f5a7c9e1d3f5b7a9c1e3d5f7b9a1c3e5d7f9",
    },
    {
      id: "w-002",
      timestamp: 1758283200,
      summary: "Sent to Alice",
      amount: "-10.00 USDC",
      direction: "out",
      status: "success",
      txHash: "c9f3a1d24e7b8c05f1a9e3d6b2c48f07a1e5d9c3b6a8f4e2d1c0b9a7f5e3d1c0b8",
    },
    {
      id: "w-003",
      timestamp: 1758204000,
      summary: "Received from Coinbase",
      amount: "+250.00 USDC",
      direction: "in",
      status: "success",
      txHash: "8a1c3e5d7f9b1a3c5e7d9f1b3a5c7e9d1f3b5a7c9e1d3f5b7a9c1e3d5f7b9a1c3e",
    },
    {
      id: "w-004",
      timestamp: 1758117600,
      summary: "Bought XLM",
      amount: "+128.44 XLM",
      direction: "in",
      status: "success",
      txHash: "f9e7d5c3b1a9f7e5d3c1b9a7f5e3d1c9b7a5f3e1d9c7b5a3f1e9d7c5b3a1f9e7d5",
    },
  ],
};

/* ------------------------------------------------------------------ *
 * Formatting helpers shared by the pages
 * ------------------------------------------------------------------ */

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
});

const fullFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** "Today 10:40", "Sep 19, 12:40" — compact enough for a notch row. */
export function formatTimestamp(
  epochSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const date = new Date(epochSeconds * 1000);
  const now = new Date(nowSeconds * 1000);
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay ? `Today ${timeFormatter.format(date)}` : fullFormatter.format(date);
}

/** "Sep 21, 09:00" for a scheduled task's next run. */
export function formatNextRun(epochSeconds: number): string {
  return fullFormatter.format(new Date(epochSeconds * 1000));
}

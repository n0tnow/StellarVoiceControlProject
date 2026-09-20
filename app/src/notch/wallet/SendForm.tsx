/**
 * The dashboard's Send form (task W13b).
 *
 * It builds the same `Intent` a spoken "send 5 XLM to ada" produces and runs it
 * through the single `executeApprovedIntent` seam (chain tool → approval card →
 * Touch ID → `wallet_sign` → submit), so a typed send and a voice send cannot
 * diverge. The recipient is a saved contact or a pasted `G…` address; the asset
 * is one of the account's own balances.
 */
import { useState, type FormEvent } from "react";
import { ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { executeApprovedIntent } from "@/lib/chain";
import type { PaymentStage } from "@/lib/turnSession";

import { useContacts } from "./useContacts";
import { ACTIONS, CARD, ERROR, FIELD, HINT } from "./styles";

/** A 56-char `G...` StrKey shape; the chain layer validates the checksum. */
const ADDRESS_SHAPE = /^G[A-Z2-7]{55}$/;
/** A positive decimal with at most 7 places; never parsed as a float here. */
const AMOUNT_SHAPE = /^\d+(\.\d{1,7})?$/;

const STAGE_LABEL: Record<PaymentStage, string> = {
  awaiting_approval: "Waiting for approval…",
  signing: "Signing…",
  submitting: "Submitting…",
};

type SendState =
  | { kind: "idle" }
  | { kind: "running"; label: string }
  | { kind: "done"; explorerUrl?: string }
  | { kind: "failed"; label: string };

export interface SendFormProps {
  /** The asset codes the account holds, native first. */
  assets: readonly string[];
  onSent?: () => void;
}

export function SendForm({ assets, onSent }: SendFormProps) {
  const { contacts } = useContacts();
  const [recipient, setRecipient] = useState("");
  const [asset, setAsset] = useState(assets[0] ?? "XLM");
  const [amount, setAmount] = useState("");
  const [state, setState] = useState<SendState>({ kind: "idle" });

  const resolvedRecipient = (): string => {
    const match = contacts.find((contact) => contact.nickname === recipient.trim().toLowerCase());
    return match ? match.address : recipient.trim();
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const to = resolvedRecipient();
    if (!ADDRESS_SHAPE.test(to)) {
      setState({ kind: "failed", label: "Enter a valid G… address or a saved recipient." });
      return;
    }
    if (!AMOUNT_SHAPE.test(amount.trim()) || !/[1-9]/.test(amount)) {
      setState({ kind: "failed", label: "Enter a positive amount with up to 7 decimals." });
      return;
    }
    setState({ kind: "running", label: STAGE_LABEL.awaiting_approval });
    try {
      const outcome = await executeApprovedIntent(
        { kind: "send", asset, amount: amount.trim(), recipient: to },
        { onStage: (stage) => setState({ kind: "running", label: STAGE_LABEL[stage] }) },
      );
      if (outcome.status === "executed" && outcome.txHash !== undefined) {
        setState({ kind: "done", explorerUrl: outcome.explorerUrl });
        setAmount("");
        onSent?.();
      } else {
        setState({ kind: "failed", label: outcome.label ?? "Could not send." });
      }
    } catch (error) {
      setState({ kind: "failed", label: error instanceof Error ? error.message : "Send failed." });
    }
  };

  const busy = state.kind === "running";

  return (
    <section className={CARD}>
      <h3 className="text-xs font-semibold">Send</h3>
      <form className="space-y-2" onSubmit={(event) => void submit(event)}>
        <label className="block text-[11px] text-polaris-muted">
          Recipient
          <input
            className={FIELD}
            value={recipient}
            placeholder="ada or G…"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setRecipient(event.target.value)}
          />
        </label>
        {contacts.length > 0 ? (
          <select
            className={FIELD}
            aria-label="Pick a saved recipient"
            value=""
            onChange={(event) => {
              if (event.target.value) setRecipient(event.target.value);
            }}
          >
            <option value="">Saved recipients…</option>
            {contacts.map((contact) => (
              <option key={contact.nickname} value={contact.nickname}>
                {contact.nickname}
              </option>
            ))}
          </select>
        ) : null}

        <div className="flex gap-2">
          <label className="block flex-1 text-[11px] text-polaris-muted">
            Asset
            <select
              className={FIELD}
              value={asset}
              onChange={(event) => setAsset(event.target.value)}
            >
              {assets.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
          <label className="block flex-1 text-[11px] text-polaris-muted">
            Amount
            <input
              className={FIELD}
              inputMode="decimal"
              value={amount}
              placeholder="0.0"
              autoComplete="off"
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
        </div>

        {state.kind === "failed" ? <p className={ERROR}>{state.label}</p> : null}
        {state.kind === "running" ? <p className={HINT}>{state.label}</p> : null}
        {state.kind === "done" ? (
          <p className={HINT}>
            Sent.{" "}
            {state.explorerUrl !== undefined ? (
              <a
                className="inline-flex items-center gap-1 underline"
                href={state.explorerUrl}
                target="_blank"
                rel="noreferrer"
              >
                View on explorer <ExternalLink aria-hidden="true" className="h-3 w-3" />
              </a>
            ) : null}
          </p>
        ) : null}

        <div className={ACTIONS}>
          <Button size="sm" type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send"}
          </Button>
        </div>
      </form>
      <p className={HINT}>Typed and spoken sends both go through the approval card and Touch ID.</p>
    </section>
  );
}

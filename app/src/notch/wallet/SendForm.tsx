/**
 * The dashboard's Send card (task W15b).
 *
 * Two inputs on one row — "To" (a saved contact name or a pasted `G…` address,
 * with matching contacts suggested as you type) and "Amount" — plus one Send
 * button. The asset is XLM unless the account holds more than one asset, in
 * which case a tiny switcher appears. The form builds the same `Intent` a spoken
 * send produces and runs it through `executeApprovedIntent` (approval card →
 * Touch ID → sign → submit), so a typed send and a voice send cannot diverge.
 */
import { useState, type FormEvent } from "react";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ExplorerLink } from "@/notch/ExplorerLink";
import { executeApprovedIntent, recipientForTypedAddress } from "@/lib/chain";
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
  | { kind: "done"; txHash: string }
  | { kind: "failed"; label: string };

export interface SendFormProps {
  /** The asset codes the account holds, native first. */
  assets: readonly string[];
  onSent?: () => void;
}

export function SendForm({ assets, onSent }: SendFormProps) {
  const { contacts } = useContacts();
  const [recipient, setRecipient] = useState("");
  const [asset, setAsset] = useState("XLM");
  const [amount, setAmount] = useState("");
  const [state, setState] = useState<SendState>({ kind: "idle" });

  const query = recipient.trim().toLowerCase();
  const isAddress = ADDRESS_SHAPE.test(recipient.trim());
  const suggestions = isAddress
    ? []
    : contacts
        .filter((contact) => query.length > 0 && contact.nickname.includes(query))
        .slice(0, 3);

  const resolvedRecipient = (): string => {
    const match = contacts.find((contact) => contact.nickname === recipient.trim().toLowerCase());
    return match ? match.address : recipient.trim();
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const to = resolvedRecipient();
    if (!ADDRESS_SHAPE.test(to)) {
      setState({ kind: "failed", label: "Enter a valid G… address or a saved contact." });
      return;
    }
    if (!AMOUNT_SHAPE.test(amount.trim()) || !/[1-9]/.test(amount)) {
      setState({ kind: "failed", label: "Enter a positive amount with up to 7 decimals." });
      return;
    }
    setState({ kind: "running", label: STAGE_LABEL.awaiting_approval });
    try {
      const outcome = await executeApprovedIntent(
        { kind: "send", asset, amount: amount.trim(), recipient: await recipientForTypedAddress(to) },
        { onStage: (stage) => setState({ kind: "running", label: STAGE_LABEL[stage] }) },
      );
      if (outcome.status === "executed" && outcome.txHash !== undefined) {
        setState({ kind: "done", txHash: outcome.txHash });
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
        <div className="flex gap-2">
          <label className="block flex-1 text-[11px] text-polaris-muted">
            To
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
          <label className="block w-28 text-[11px] text-polaris-muted">
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

        {suggestions.length > 0 ? (
          <div className={ACTIONS}>
            {suggestions.map((contact) => (
              <button
                key={contact.nickname}
                type="button"
                className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-[var(--color-notch-muted)] hover:text-[var(--color-notch-text)]"
                onClick={() => setRecipient(contact.nickname)}
              >
                {contact.nickname}
              </button>
            ))}
          </div>
        ) : null}

        {state.kind === "failed" ? <p className={ERROR}>{state.label}</p> : null}
        {state.kind === "running" ? <p className={HINT}>{state.label}</p> : null}
        {state.kind === "done" ? (
          <p className={`${HINT} flex items-center gap-1`}>
            <Check aria-hidden="true" className="h-3 w-3 text-[var(--color-polaris-ok)]" />
            Sent.
            <code className="selectable" title={state.txHash}>
              {`${state.txHash.slice(0, 8)}…${state.txHash.slice(-8)}`}
            </code>
            <ExplorerLink kind="tx" target={state.txHash} />
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button size="sm" type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send"}
          </Button>
          {assets.length > 1 ? (
            <select
              className={`${FIELD} w-24`}
              aria-label="Asset"
              value={asset}
              onChange={(event) => setAsset(event.target.value)}
            >
              {assets.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </form>
    </section>
  );
}

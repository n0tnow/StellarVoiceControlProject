/**
 * "Create a new wallet" flow (task W10b).
 *
 * Three visible steps: confirm (Touch ID inside Rust), the one-time recovery
 * phrase with its "I saved it" gate, then the new address. The phrase exists in
 * state only while the phrase step is on screen and is dropped the moment the
 * user confirms; nothing here logs or persists it.
 */
import { useReducer, useState } from "react";

import { Button } from "@/components/ui/button";
import { walletEngine } from "@/lib/wallet";
import { initialCreateState, reduceCreate, splitPhrase } from "@/lib/walletFlows";

import { PhraseGrid } from "./PhraseGrid";
import { ACTIONS, CARD, ERROR, HINT } from "./styles";

export interface CreateWalletProps {
  onDone: (address: string) => void;
  onCancel: () => void;
}

export function CreateWallet({ onDone, onCancel }: CreateWalletProps) {
  const [state, dispatch] = useReducer(reduceCreate, initialCreateState);
  const [saved, setSaved] = useState(false);

  const create = async (): Promise<void> => {
    dispatch({ type: "start" });
    try {
      const result = await walletEngine.create();
      dispatch({
        type: "created",
        address: result.address,
        recoveryPhrase: result.recoveryPhrase,
      });
    } catch (failure) {
      dispatch({
        type: "failed",
        error: failure instanceof Error ? failure.message : String(failure),
      });
    }
  };

  if (state.step === "phrase") {
    const words = state.phrase ?? splitPhrase("");
    return (
      <section className={CARD}>
        <p className={HINT}>
          Write these 24 words down and keep them offline. They are shown once and
          are the only way to recover this wallet.
        </p>
        <PhraseGrid words={words} />
        <label className="flex items-center gap-2 text-[11px] text-polaris-muted">
          <input
            type="checkbox"
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
          />
          I saved my recovery phrase
        </label>
        <div className={ACTIONS}>
          <Button
            size="sm"
            disabled={!saved || state.address === null}
            onClick={() => {
              if (state.address === null) return;
              dispatch({ type: "confirmed" });
              onDone(state.address);
            }}
          >
            Continue
          </Button>
        </div>
      </section>
    );
  }

  if (state.step === "saved" || (state.step === "working" && state.address !== null)) {
    return (
      <section className={CARD}>
        <p className={HINT}>Wallet created.</p>
        <code className="wallet-key-value selectable">{state.address}</code>
        <div className={ACTIONS}>
          <Button size="sm" onClick={() => onDone(state.address ?? "")}>
            Done
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className={CARD}>
      <p className={HINT}>Polaris will generate a key in the macOS Keychain.</p>
      {state.error !== null ? <p className={ERROR}>{state.error}</p> : null}
      <div className={ACTIONS}>
        <Button size="sm" disabled={state.step === "working"} onClick={() => void create()}>
          {state.step === "working" ? "Creating…" : "Create new wallet"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

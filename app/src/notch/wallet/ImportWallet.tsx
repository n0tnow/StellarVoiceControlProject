/**
 * "Import an existing wallet" flow (task W10b).
 *
 * Two modes — a secret key (`S…`) or a 12/24-word phrase — plus an optional
 * account index. The value is validated live, previewed to show the derived
 * address, and only stored after an explicit confirmation. The field is cleared
 * on submit, cancel and failure; the value never reaches a log, the URL, local
 * storage or the agent, only the Rust engine's typed command.
 */
import { useReducer, useState } from "react";

import { Button } from "@/components/ui/button";
import { walletEngine } from "@/lib/wallet";
import {
  CONNECT_COPY,
  initialImportState,
  parseImportIndex,
  reduceImport,
  validateImportIndex,
  validateImportValue,
} from "@/lib/walletFlows";

import { ACTIONS, CARD, ERROR, FIELD } from "./styles";

export interface ImportWalletProps {
  onDone: (address: string) => void;
  onCancel: () => void;
}

export function ImportWallet({ onDone, onCancel }: ImportWalletProps) {
  const [state, dispatch] = useReducer(reduceImport, initialImportState);
  const [attempted, setAttempted] = useState(false);

  const valueError = validateImportValue(state.mode, state.secret);
  const indexError = validateImportIndex(state.index);

  const inputArgs = (): { secretOrPhrase: string; index?: number } => {
    const index = parseImportIndex(state.index);
    return { secretOrPhrase: state.secret, ...(index === undefined ? {} : { index }) };
  };

  const preview = async (): Promise<void> => {
    setAttempted(true);
    if (valueError !== null || indexError !== null) return;
    dispatch({ type: "preview" });
    try {
      const result = await walletEngine.importPreview(inputArgs());
      dispatch({ type: "previewed", address: result.address });
    } catch (failure) {
      dispatch({
        type: "failed",
        error: failure instanceof Error ? failure.message : String(failure),
      });
    }
  };

  const confirm = async (): Promise<void> => {
    // Capture the value, then clear it before the async store resolves.
    const args = inputArgs();
    dispatch({ type: "store" });
    try {
      const result = await walletEngine.import(args);
      dispatch({ type: "stored", address: result.address });
      onDone(result.address);
    } catch (failure) {
      dispatch({
        type: "failed",
        error: failure instanceof Error ? failure.message : String(failure),
      });
    }
  };

  if (state.step === "preview") {
    return (
      <section className={CARD}>
        <h2 className="text-sm font-semibold">{CONNECT_COPY.previewHeading}</h2>
        <code className="wallet-key-value selectable">{state.address}</code>
        <div className={ACTIONS}>
          <Button size="sm" onClick={() => void confirm()}>
            {CONNECT_COPY.confirm}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "back" })}>
            Back
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold">{CONNECT_COPY.importHeading}</h2>
      <div className={ACTIONS} role="group" aria-label="Connect type">
        <Button
          size="sm"
          variant={state.mode === "secret" ? "secondary" : "ghost"}
          onClick={() => dispatch({ type: "mode", mode: "secret" })}
        >
          Secret key
        </Button>
        <Button
          size="sm"
          variant={state.mode === "phrase" ? "secondary" : "ghost"}
          onClick={() => dispatch({ type: "mode", mode: "phrase" })}
        >
          Recovery phrase
        </Button>
      </div>

      <label className="block text-[11px] text-polaris-muted">
        {state.mode === "secret" ? "Secret key (S…)" : "Recovery phrase (12 or 24 words)"}
        <input
          className={FIELD}
          type="password"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={state.secret}
          onChange={(event) => dispatch({ type: "secret", value: event.target.value })}
        />
      </label>

      <label className="block text-[11px] text-polaris-muted">
        Account index (optional)
        <input
          className={FIELD}
          inputMode="numeric"
          autoComplete="off"
          value={state.index}
          onChange={(event) => dispatch({ type: "index", value: event.target.value })}
        />
      </label>

      {attempted && valueError !== null ? <p className={ERROR}>{valueError}</p> : null}
      {attempted && indexError !== null ? <p className={ERROR}>{indexError}</p> : null}
      {state.error !== null ? <p className={ERROR}>{state.error}</p> : null}

      <div className={ACTIONS}>
        <Button
          size="sm"
          disabled={state.step === "previewing"}
          onClick={() => void preview()}
        >
          {state.step === "previewing" ? "Deriving…" : "Preview address"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            dispatch({ type: "reset" });
            onCancel();
          }}
        >
          Cancel
        </Button>
      </div>
    </section>
  );
}

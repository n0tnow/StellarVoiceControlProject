/**
 * First-run state of the Wallet page (task W10b): no wallet is connected, so
 * the only two things to offer are creating a new one and importing an existing
 * one. Nothing here touches the chain.
 */
import { Button } from "@/components/ui/button";

import { ACTIONS, CARD, ERROR, HINT } from "./styles";

export interface ConnectScreenProps {
  loading: boolean;
  error: string | null;
  onCreate: () => void;
  onImport: () => void;
}

export function ConnectScreen({ loading, error, onCreate, onImport }: ConnectScreenProps) {
  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold">Connect your wallet</h2>
      <p className={HINT}>
        Create a new testnet wallet or import an existing one. The key is held in
        the macOS Keychain; Polaris never stores a secret after import.
      </p>
      {error !== null ? <p className={ERROR}>{error}</p> : null}
      <div className={ACTIONS}>
        <Button size="sm" onClick={onCreate} disabled={loading}>
          Create new
        </Button>
        <Button size="sm" variant="secondary" onClick={onImport} disabled={loading}>
          Import
        </Button>
      </div>
    </section>
  );
}

/**
 * First-run state of the Wallet page (task W10b): no wallet is connected, so
 * the two things to offer are connecting an existing wallet and creating a new
 * one. Task W14 makes connecting an existing wallet the primary path, because
 * Polaris is meant to replace a Freighter/Lobstr/xBull signer, not to be a
 * separate fake wallet. Nothing here touches the chain.
 */
import { Button } from "@/components/ui/button";
import { CONNECT_COPY } from "@/lib/walletFlows";

import { StoreNotice } from "./StoreNotice";
import { ACTIONS, CARD, ERROR, HINT } from "./styles";

export interface ConnectScreenProps {
  loading: boolean;
  error: string | null;
  onCreate: () => void;
  onImport: () => void;
  /** The `wallet_status.store` state, so a weaker store is visible up front. */
  store?: string | null;
}

export function ConnectScreen({ loading, error, onCreate, onImport, store }: ConnectScreenProps) {
  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold">{CONNECT_COPY.screenTitle}</h2>
      <p className={HINT}>{CONNECT_COPY.screenBody}</p>
      <StoreNotice store={store} />
      {error !== null ? <p className={ERROR}>{error}</p> : null}
      <div className={ACTIONS}>
        <Button size="sm" onClick={onImport} disabled={loading}>
          {CONNECT_COPY.connectExisting}
        </Button>
        <Button size="sm" variant="secondary" onClick={onCreate} disabled={loading}>
          {CONNECT_COPY.createNew}
        </Button>
      </div>
    </section>
  );
}

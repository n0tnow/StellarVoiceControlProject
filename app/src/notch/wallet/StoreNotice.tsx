/**
 * Seed-store status line for the Wallet page (task W10-fix).
 *
 * The Keychain is the only store by default. This shows the two weaker states:
 * the opt-in plaintext file store and `keychain unavailable`, so a user is
 * never misled about where the seed lives. Renders nothing when the store is
 * the Keychain.
 */
import { ERROR, HINT } from "./styles";

export interface StoreNoticeProps {
  store: string | null | undefined;
}

export function StoreNotice({ store }: StoreNoticeProps) {
  if (!store || store === "keychain") return null;
  const unavailable = store === "keychain unavailable";
  const message = unavailable
    ? "Keychain unavailable — allow Polaris in Keychain Access, or unlock the login keychain. Creating, importing and signing stay locked until then."
    : `Seeds are stored in the ${store} store; this is testnet only.`;
  return (
    <p className={unavailable ? ERROR : HINT} role="status">
      {message}
    </p>
  );
}

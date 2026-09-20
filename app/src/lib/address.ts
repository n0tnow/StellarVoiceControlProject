/**
 * Address display helper.
 *
 * The notch pages show the first and last characters of an address; the full
 * value stays available behind "Details" or a copy action. Pure, no DOM.
 */

/** `GARXWV…WCO` — the first and last four characters of an address. */
export function shortAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

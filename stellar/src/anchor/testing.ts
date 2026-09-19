/**
 * TEST-ONLY entry point (`@polaris/stellar/anchor/testing`), deliberately NOT
 * part of the main anchor barrel so the env-secret signer cannot ship in the app
 * bundle. Product code must use the injected `Signer` (Touch ID on the shell).
 */
export { EnvSigner } from "./testSigner.ts";

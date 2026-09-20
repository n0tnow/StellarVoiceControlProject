/**
 * The webview has no Node `Buffer`, but the Stellar SDK helpers in
 * `@polaris/stellar` (hashing, SEP-10/SEP-6 decoding, submit) use it. Installing
 * the browser implementation once, before anything else runs, fixes every
 * "Can't find variable: Buffer" path (Add asset, anchor deposit/withdraw).
 */
import { Buffer } from "buffer";

const scope = globalThis as { Buffer?: typeof Buffer };
scope.Buffer ??= Buffer;

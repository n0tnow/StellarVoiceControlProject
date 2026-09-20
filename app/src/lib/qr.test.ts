import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { QR_MAX_VERSION, encodeQr } from "./qr.ts";
import type { QrMatrix } from "./qr.ts";

function bitString(matrix: QrMatrix): string {
  let bits = "";
  for (const row of matrix.modules) {
    for (const cell of row) bits += cell ? "1" : "0";
  }
  return bits;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

test("encodes a short ASCII string as version 1 (21x21)", () => {
  const matrix = encodeQr("hello");
  assert.equal(matrix.version, 1);
  assert.equal(matrix.size, 21);
  assert.equal(matrix.modules.length, 21);
  assert.equal(matrix.modules[0]?.length, 21);
});

test("picks the smallest version that fits across byte-capacity boundaries", () => {
  assert.equal(encodeQr("a".repeat(17)).version, 1);
  assert.equal(encodeQr("a".repeat(18)).version, 2);
  assert.equal(encodeQr("a".repeat(53)).version, 3);
  assert.equal(encodeQr("a".repeat(54)).version, 4);
  assert.equal(encodeQr("a".repeat(271)).version, QR_MAX_VERSION);
  assert.equal(encodeQr("ü".repeat(9)).version, 2);
});

test("golden: 56-char Stellar address matches version and stable hash", () => {
  const address = "GARXWVNCJ22U2OR23LAB5Z5RWI2XFIJZA2R3TRPFUKKY65JQZZOEWWCO";
  assert.equal(address.length, 56);
  const matrix = encodeQr(address);
  assert.equal(matrix.version, 4);
  assert.equal(matrix.size, 33);
  assert.equal(sha256(bitString(matrix)), "1cb3ec1dd9d3fbbe456ed1c181f9e0eb49aa153661c8ebb40f0b1a2a923f2b9a");
});

test("draws finder patterns at the three corners, dark module, and timing pattern", () => {
  const matrix = encodeQr("hello");
  const { size, modules } = matrix;

  for (const [row, col] of [
    [0, 0],
    [0, 6],
    [6, 0],
    [6, 6],
    [0, size - 7],
    [0, size - 1],
    [6, size - 1],
    [size - 7, 0],
    [size - 1, 0],
    [size - 1, 6],
  ] as Array<[number, number]>) {
    assert.equal(modules[row]?.[col], true, `finder corner ${row},${col}`);
  }
  assert.equal(modules[1]?.[1], false);
  assert.equal(modules[2]?.[2], true);

  assert.equal(modules[size - 8]?.[8], true, "dark module");

  for (let i = 8; i <= size - 9; i++) {
    assert.equal(modules[6]?.[i], i % 2 === 0, `row timing ${i}`);
    assert.equal(modules[i]?.[6], i % 2 === 0, `col timing ${i}`);
  }
});

test("throws a sized error when the text cannot fit even version 10", () => {
  assert.throws(
    () => encodeQr("a".repeat(272)),
    new Error("text too long for QR (max 271 bytes)"),
  );
  assert.throws(() => encodeQr("x".repeat(1000)), /text too long for QR \(max 271 bytes\)/);
});

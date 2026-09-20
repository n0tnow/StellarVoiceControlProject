/**
 * Dependency-free QR Code encoder (byte mode, error-correction level L,
 * versions 1..10). Pure TypeScript with no imports so it runs under Node's
 * type-stripping test runner and bundles under Vite unchanged.
 */

export interface QrMatrix {
  /** Modules per side (4 * version + 17). */
  size: number;
  /** Row-major; `true` = dark module. modules[row][col]. */
  modules: boolean[][];
  /** QR version 1..10. */
  version: number;
}

export const QR_MAX_VERSION = 10;

interface BlockGroup {
  count: number;
  totalCodewords: number;
  dataCodewords: number;
}

const ECC_L: BlockGroup[][] = [
  [{ count: 1, totalCodewords: 26, dataCodewords: 19 }],
  [{ count: 1, totalCodewords: 44, dataCodewords: 34 }],
  [{ count: 1, totalCodewords: 70, dataCodewords: 55 }],
  [{ count: 1, totalCodewords: 100, dataCodewords: 80 }],
  [{ count: 1, totalCodewords: 134, dataCodewords: 108 }],
  [{ count: 2, totalCodewords: 86, dataCodewords: 68 }],
  [{ count: 2, totalCodewords: 98, dataCodewords: 78 }],
  [{ count: 2, totalCodewords: 121, dataCodewords: 97 }],
  [{ count: 2, totalCodewords: 146, dataCodewords: 116 }],
  [
    { count: 2, totalCodewords: 86, dataCodewords: 68 },
    { count: 2, totalCodewords: 87, dataCodewords: 69 },
  ],
];

const ALIGNMENT: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return bytes;
}

function dataCodewordsFor(version: number): number {
  const groups = ECC_L[version - 1] as BlockGroup[];
  let total = 0;
  for (const group of groups) total += group.count * group.dataCodewords;
  return total;
}

function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function pickVersion(byteLength: number): number {
  for (let version = 1; version <= QR_MAX_VERSION; version++) {
    const needed = 4 + charCountBits(version) + byteLength * 8;
    if (needed <= dataCodewordsFor(version) * 8) return version;
  }
  const maxBytes = Math.floor((dataCodewordsFor(QR_MAX_VERSION) * 8 - 4 - charCountBits(QR_MAX_VERSION)) / 8);
  throw new Error(`text too long for QR (max ${maxBytes} bytes)`);
}

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function buildDataCodewords(version: number, bytes: number[]): number[] {
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, charCountBits(version));
  for (const byte of bytes) appendBits(bits, byte, 8);

  const capacityBits = dataCodewordsFor(version) * 8;
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (bits.length < capacityBits) {
    appendBits(bits, padBytes[padIndex] as number, 8);
    padIndex ^= 1;
  }

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] as number);
    codewords.push(byte);
  }
  return codewords;
}

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < degree - 1; i++) result.push(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j] as number, root);
      if (j + 1 < result.length) result[j] = (result[j] as number) ^ (result[j + 1] as number);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result: number[] = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < divisor.length; i++) {
      result[i] = (result[i] as number) ^ gfMultiply(divisor[i] as number, factor);
    }
  }
  return result;
}

function interleave(version: number, dataCodewords: number[]): number[] {
  const groups = ECC_L[version - 1] as BlockGroup[];
  const blocks: { data: number[]; ecc: number[] }[] = [];
  let offset = 0;
  for (const group of groups) {
    for (let i = 0; i < group.count; i++) {
      const data = dataCodewords.slice(offset, offset + group.dataCodewords);
      offset += group.dataCodewords;
      const ecc = rsRemainder(data, rsDivisor(group.totalCodewords - group.dataCodewords));
      blocks.push({ data, ecc });
    }
  }

  const result: number[] = [];
  const maxData = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) {
      if (i < block.data.length) result.push(block.data[i] as number);
    }
  }
  const maxEcc = Math.max(...blocks.map((block) => block.ecc.length));
  for (let i = 0; i < maxEcc; i++) {
    for (const block of blocks) {
      if (i < block.ecc.length) result.push(block.ecc[i] as number);
    }
  }
  return result;
}

function getBit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

function buildMatrix(version: number, codewords: number[]): boolean[][] {
  const size = version * 4 + 17;
  const modules: boolean[][] = [];
  const isFunction: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    modules.push(new Array<boolean>(size).fill(false));
    isFunction.push(new Array<boolean>(size).fill(false));
  }

  const setFunction = (x: number, y: number, isDark: boolean): void => {
    modules[y]![x] = isDark;
    isFunction[y]![x] = true;
  };

  const drawFinder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  for (let i = 0; i < size; i++) {
    if (!isFunction[6]![i]) setFunction(i, 6, i % 2 === 0);
    if (!isFunction[i]![6]) setFunction(6, i, i % 2 === 0);
  }

  const alignPositions = ALIGNMENT[version - 1] as number[];
  const alignCount = alignPositions.length;
  for (let i = 0; i < alignCount; i++) {
    for (let j = 0; j < alignCount; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === alignCount - 1) ||
        (i === alignCount - 1 && j === 0)
      ) {
        continue;
      }
      const cx = alignPositions[i] as number;
      const cy = alignPositions[j] as number;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  const drawFormatBits = (mask: number): void => {
    const data = (0b01 << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    for (let i = 0; i <= 5; i++) setFunction(8, i, getBit(bits, i));
    setFunction(8, 7, getBit(bits, 6));
    setFunction(8, 8, getBit(bits, 7));
    setFunction(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, getBit(bits, i));

    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, getBit(bits, i));
    setFunction(8, size - 8, true);
  };

  const drawVersion = (): void => {
    if (version < 7) return;
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const color = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, color);
      setFunction(b, a, color);
    }
  };

  drawFormatBits(0);
  drawVersion();
  setFunction(8, size - 8, true);

  const drawCodewords = (): void => {
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFunction[y]![x] && i < codewords.length * 8) {
            modules[y]![x] = getBit(codewords[i >>> 3] as number, 7 - (i & 7));
            i++;
          }
        }
      }
    }
  };
  drawCodewords();

  const applyMask = (mask: number): void => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0:
            invert = (x + y) % 2 === 0;
            break;
          case 1:
            invert = y % 2 === 0;
            break;
          case 2:
            invert = x % 3 === 0;
            break;
          case 3:
            invert = (x + y) % 3 === 0;
            break;
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          case 5:
            invert = ((x * y) % 2) + ((x * y) % 3) === 0;
            break;
          case 6:
            invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          default:
            invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
        }
        if (!isFunction[y]![x] && invert) modules[y]![x] = !modules[y]![x];
      }
    }
  };

  const getPenaltyN1 = (): number => {
    let points = 0;
    let sameCountCol = 0;
    let sameCountRow = 0;
    let lastCol: boolean | null = null;
    let lastRow: boolean | null = null;
    for (let row = 0; row < size; row++) {
      sameCountCol = 0;
      sameCountRow = 0;
      lastCol = null;
      lastRow = null;
      for (let col = 0; col < size; col++) {
        let module = modules[row]![col] as boolean;
        if (module === lastCol) {
          sameCountCol++;
        } else {
          if (sameCountCol >= 5) points += PENALTY_N1 + (sameCountCol - 5);
          lastCol = module;
          sameCountCol = 1;
        }
        module = modules[col]![row] as boolean;
        if (module === lastRow) {
          sameCountRow++;
        } else {
          if (sameCountRow >= 5) points += PENALTY_N1 + (sameCountRow - 5);
          lastRow = module;
          sameCountRow = 1;
        }
      }
      if (sameCountCol >= 5) points += PENALTY_N1 + (sameCountCol - 5);
      if (sameCountRow >= 5) points += PENALTY_N1 + (sameCountRow - 5);
    }
    return points;
  };

  const getPenaltyN2 = (): number => {
    let points = 0;
    for (let row = 0; row < size - 1; row++) {
      for (let col = 0; col < size - 1; col++) {
        const sum =
          (modules[row]![col] ? 1 : 0) +
          (modules[row]![col + 1] ? 1 : 0) +
          (modules[row + 1]![col] ? 1 : 0) +
          (modules[row + 1]![col + 1] ? 1 : 0);
        if (sum === 4 || sum === 0) points++;
      }
    }
    return points * PENALTY_N2;
  };

  const getPenaltyN3 = (): number => {
    let points = 0;
    for (let row = 0; row < size; row++) {
      let bitsCol = 0;
      let bitsRow = 0;
      for (let col = 0; col < size; col++) {
        bitsCol = ((bitsCol << 1) & 0x7ff) | (modules[row]![col] ? 1 : 0);
        if (col >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) points++;
        bitsRow = ((bitsRow << 1) & 0x7ff) | (modules[col]![row] ? 1 : 0);
        if (col >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) points++;
      }
    }
    return points * PENALTY_N3;
  };

  const getPenaltyN4 = (): number => {
    let darkCount = 0;
    const modulesCount = size * size;
    for (const row of modules) {
      for (const cell of row) if (cell) darkCount++;
    }
    const k = Math.abs(Math.ceil(darkCount * 100 / modulesCount / 5) - 10);
    return k * PENALTY_N4;
  };

  const getPenaltyScore = (): number =>
    getPenaltyN1() + getPenaltyN2() + getPenaltyN3() + getPenaltyN4();

  let bestMask = 0;
  let minPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormatBits(mask);
    const penalty = getPenaltyScore();
    if (penalty < minPenalty) {
      bestMask = mask;
      minPenalty = penalty;
    }
    applyMask(mask);
  }
  applyMask(bestMask);
  drawFormatBits(bestMask);

  return modules;
}

/** Encodes UTF-8 text in byte mode at error-correction level L. Throws Error if too long. */
export function encodeQr(text: string): QrMatrix {
  const bytes = utf8Bytes(text);
  const version = pickVersion(bytes.length);
  const dataCodewords = buildDataCodewords(version, bytes);
  const codewords = interleave(version, dataCodewords);
  const modules = buildMatrix(version, codewords);
  return { size: version * 4 + 17, modules, version };
}

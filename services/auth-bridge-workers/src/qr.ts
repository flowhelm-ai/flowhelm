/**
 * From-scratch QR code generator.
 *
 * Supports QR Code Version 1-4 (21x21 to 33x33 modules), Byte mode encoding,
 * Error Correction Level M (15% recovery). Renders to UTF-8 half-block
 * characters for compact terminal display.
 *
 * References:
 * - ISO/IEC 18004:2015 (QR Code specification)
 * - Thonky QR Code Tutorial (public domain reference tables)
 */

// ─── GF(2^8) Arithmetic for Reed-Solomon ────────────────────────────────────

/** Primitive polynomial for GF(2^8): x^8 + x^4 + x^3 + x^2 + 1 = 0x11D */
const GF_POLY = 0x11d;

/** exp[i] = α^i in GF(2^8). 256 entries. */
const GF_EXP = new Uint8Array(256);
/** log[i] = discrete log base α of i. log[0] is undefined (set to 0). */
const GF_LOG = new Uint8Array(256);

// Build log/exp tables
{
  let val = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = val;
    GF_LOG[val] = i;
    val <<= 1;
    if (val >= 256) val ^= GF_POLY;
  }
  GF_EXP[255] = GF_EXP[0]; // wrap
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
}

/** Multiply two polynomials in GF(2^8). Coefficients are highest-degree first. */
function polyMul(a: number[], b: number[]): number[] {
  const result = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      result[i + j] ^= gfMul(a[i], b[j]);
    }
  }
  return result;
}

/** Compute Reed-Solomon error correction codewords. */
function rsEncode(data: number[], ecCount: number): number[] {
  // Build generator polynomial: ∏(x - α^i) for i = 0..ecCount-1
  let gen = [1];
  for (let i = 0; i < ecCount; i++) {
    gen = polyMul(gen, [1, GF_EXP[i]]);
  }

  // Polynomial long division
  const msg = [...data, ...new Array(ecCount).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coeff = msg[i];
    if (coeff !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coeff);
      }
    }
  }

  return msg.slice(data.length);
}

// ─── QR Code Version Tables ─────────────────────────────────────────────────

/** Version info: [totalCodewords, ecCodewordsPerBlock, numBlocks, dataCapacityBytes] for EC level M. */
const VERSION_TABLE: Record<
  number,
  { totalCW: number; ecPerBlock: number; blocks: number; dataCW: number }
> = {
  1: { totalCW: 26, ecPerBlock: 10, blocks: 1, dataCW: 16 },
  2: { totalCW: 44, ecPerBlock: 16, blocks: 1, dataCW: 28 },
  3: { totalCW: 70, ecPerBlock: 26, blocks: 1, dataCW: 44 },
  4: { totalCW: 100, ecPerBlock: 18, blocks: 2, dataCW: 64 },
};

/** Data capacity in bytes for Byte mode, EC level M. */
const BYTE_CAPACITY: Record<number, number> = {
  1: 14,
  2: 26,
  3: 42,
  4: 62,
};

/** Size in modules (side length) for each version. */
function versionSize(version: number): number {
  return 17 + version * 4;
}

/** Character count indicator length in bits for Byte mode. */
function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

// ─── Alignment Pattern Positions ────────────────────────────────────────────

/** Alignment pattern center positions per version. Version 1 has none. */
const ALIGNMENT_POSITIONS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
};

// ─── Data Encoding ──────────────────────────────────────────────────────────

/** Select the smallest version that fits the data. */
function selectVersion(dataLength: number): number {
  for (let v = 1; v <= 4; v++) {
    if (dataLength <= BYTE_CAPACITY[v]) return v;
  }
  throw new Error(
    `Data too long (${dataLength} bytes). Max ${BYTE_CAPACITY[4]} bytes for Version 4 EC-M.`,
  );
}

/** Encode data bytes into the QR bitstream (mode indicator + count + data + terminator + padding). */
function encodeData(data: Uint8Array, version: number): number[] {
  const info = VERSION_TABLE[version];
  const bits: number[] = [];

  const pushBits = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) {
      bits.push((value >> i) & 1);
    }
  };

  // Mode indicator: 0100 (Byte mode)
  pushBits(0b0100, 4);

  // Character count
  pushBits(data.length, charCountBits(version));

  // Data bytes
  for (const byte of data) {
    pushBits(byte, 8);
  }

  // Terminator: up to 4 zero bits
  const totalDataBits = info.dataCW * 8;
  const terminatorLen = Math.min(4, totalDataBits - bits.length);
  pushBits(0, terminatorLen);

  // Pad to byte boundary
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  // Pad with alternating 0xEC, 0x11 to fill data capacity
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bits.length < totalDataBits) {
    pushBits(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  // Convert bits to bytes
  const bytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | (bits[i + j] || 0);
    }
    bytes.push(byte);
  }

  return bytes;
}

/** Split data into blocks and compute EC codewords, then interleave. */
function buildCodewords(dataBytes: number[], version: number): number[] {
  const info = VERSION_TABLE[version];
  const ecPerBlock = info.ecPerBlock;
  const numBlocks = info.blocks;
  const dataCWPerBlock = Math.floor(info.dataCW / numBlocks);
  // For versions with uneven block sizes, last block(s) get one extra
  const shortBlocks = numBlocks - (info.dataCW % numBlocks);

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;

  for (let b = 0; b < numBlocks; b++) {
    const blockLen = dataCWPerBlock + (b >= shortBlocks ? 1 : 0);
    const block = dataBytes.slice(offset, offset + blockLen);
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
    offset += blockLen;
  }

  // Interleave data codewords
  const result: number[] = [];
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) result.push(block[i]);
    }
  }

  // Interleave EC codewords
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) {
      if (i < block.length) result.push(block[i]);
    }
  }

  return result;
}

// ─── Module Placement ───────────────────────────────────────────────────────

type Module = boolean; // true = dark (black), false = light (white)

/** Create the QR matrix and place all patterns and data. */
function buildMatrix(codewords: number[], version: number): boolean[][] {
  const size = versionSize(version);
  // null means "not yet placed"
  const matrix: (Module | null)[][] = Array.from({ length: size }, () =>
    new Array(size).fill(null),
  );
  // Track which modules are function patterns (not masked)
  const reserved: boolean[][] = Array.from({ length: size }, () =>
    new Array(size).fill(false),
  );

  // ─── Finder Patterns (3 corners) ───
  const placeFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const mr = row + r;
        const mc = col + c;
        if (mr < 0 || mr >= size || mc < 0 || mc >= size) continue;

        let dark = false;
        if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
          // Outer border or inner 3x3
          if (
            r === 0 ||
            r === 6 ||
            c === 0 ||
            c === 6 ||
            (r >= 2 && r <= 4 && c >= 2 && c <= 4)
          ) {
            dark = true;
          }
        }
        matrix[mr][mc] = dark;
        reserved[mr][mc] = true;
      }
    }
  };

  placeFinder(0, 0); // Top-left
  placeFinder(0, size - 7); // Top-right
  placeFinder(size - 7, 0); // Bottom-left

  // ─── Timing Patterns ───
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    // Horizontal (row 6)
    if (matrix[6][i] === null) {
      matrix[6][i] = dark;
      reserved[6][i] = true;
    }
    // Vertical (col 6)
    if (matrix[i][6] === null) {
      matrix[i][6] = dark;
      reserved[i][6] = true;
    }
  }

  // ─── Alignment Patterns (Version 2+) ───
  const alignPos = ALIGNMENT_POSITIONS[version];
  if (alignPos.length > 0) {
    for (const row of alignPos) {
      for (const col of alignPos) {
        // Skip if overlapping with finder patterns
        if (reserved[row][col]) continue;

        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            const dark =
              Math.abs(r) === 2 ||
              Math.abs(c) === 2 ||
              (r === 0 && c === 0);
            matrix[row + r][col + c] = dark;
            reserved[row + r][col + c] = true;
          }
        }
      }
    }
  }

  // ─── Dark Module (always present) ───
  matrix[size - 8][8] = true;
  reserved[size - 8][8] = true;

  // ─── Reserve Format Information Areas ───
  // Around top-left finder
  for (let i = 0; i <= 8; i++) {
    if (!reserved[8][i]) {
      reserved[8][i] = true;
    }
    if (!reserved[i][8]) {
      reserved[i][8] = true;
    }
  }
  // Around top-right finder
  for (let i = 0; i <= 7; i++) {
    if (!reserved[8][size - 1 - i]) {
      reserved[8][size - 1 - i] = true;
    }
  }
  // Around bottom-left finder
  for (let i = 0; i <= 7; i++) {
    if (!reserved[size - 1 - i][8]) {
      reserved[size - 1 - i][8] = true;
    }
  }

  // ─── Place Data Bits ───
  const bits: number[] = [];
  for (const cw of codewords) {
    for (let b = 7; b >= 0; b--) {
      bits.push((cw >> b) & 1);
    }
  }

  let bitIdx = 0;
  // Data is placed in 2-column strips, right to left, alternating upward/downward
  let col = size - 1;
  while (col >= 0) {
    // Skip the vertical timing pattern column
    if (col === 6) {
      col--;
      continue;
    }

    // Determine direction: rightmost strip goes up, then alternating
    const stripIndex = col >= 7 ? (size - 1 - col) >> 1 : (size - 2 - col) >> 1;
    const goingUp = stripIndex % 2 === 0;

    for (let i = 0; i < size; i++) {
      const row = goingUp ? size - 1 - i : i;

      for (const dc of [0, -1]) {
        const c = col + dc;
        if (c < 0 || c >= size) continue;
        if (reserved[row][c]) continue;

        if (bitIdx < bits.length) {
          matrix[row][c] = bits[bitIdx] === 1;
        } else {
          matrix[row][c] = false;
        }
        bitIdx++;
      }
    }

    col -= 2;
  }

  return matrix.map((row) => row.map((v) => v === true));
}

// ─── Masking ────────────────────────────────────────────────────────────────

type MaskFn = (row: number, col: number) => boolean;

const MASK_FUNCTIONS: MaskFn[] = [
  (r, c) => (r + c) % 2 === 0, // 000
  (r) => r % 2 === 0, // 001
  (_r, c) => c % 3 === 0, // 010
  (r, c) => (r + c) % 3 === 0, // 011
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, // 100
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0, // 101
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, // 110
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0, // 111
];

/** Build the reserved mask (function patterns that should not be masked). */
function buildReservedMask(version: number): boolean[][] {
  const size = versionSize(version);
  const reserved: boolean[][] = Array.from({ length: size }, () =>
    new Array(size).fill(false),
  );

  // Finder patterns + separators
  const markFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const mr = row + r;
        const mc = col + c;
        if (mr >= 0 && mr < size && mc >= 0 && mc < size) {
          reserved[mr][mc] = true;
        }
      }
    }
  };
  markFinder(0, 0);
  markFinder(0, size - 7);
  markFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    reserved[6][i] = true;
    reserved[i][6] = true;
  }

  // Alignment patterns
  const alignPos = ALIGNMENT_POSITIONS[version];
  if (alignPos.length > 0) {
    for (const row of alignPos) {
      for (const col of alignPos) {
        // Skip if overlapping with finder
        let overlapsFinder = false;
        for (const [fr, fc] of [
          [0, 0],
          [0, size - 7],
          [size - 7, 0],
        ]) {
          if (
            row >= fr - 1 &&
            row <= fr + 7 &&
            col >= fc - 1 &&
            col <= fc + 7
          ) {
            overlapsFinder = true;
            break;
          }
        }
        if (overlapsFinder) continue;

        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            reserved[row + r][col + c] = true;
          }
        }
      }
    }
  }

  // Dark module
  reserved[size - 8][8] = true;

  // Format information areas
  for (let i = 0; i <= 8; i++) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  for (let i = 0; i <= 7; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }

  return reserved;
}

/** Apply a mask to a matrix (only to non-reserved modules). */
function applyMask(
  matrix: boolean[][],
  reservedMask: boolean[][],
  maskIdx: number,
): boolean[][] {
  const size = matrix.length;
  const fn = MASK_FUNCTIONS[maskIdx];
  const result = matrix.map((row) => [...row]);

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reservedMask[r][c] && fn(r, c)) {
        result[r][c] = !result[r][c];
      }
    }
  }

  return result;
}

// ─── Format Information ─────────────────────────────────────────────────────

/** Format info bits for EC level M (01) and each mask pattern. Pre-computed with BCH(15,5). */
const FORMAT_BITS: Record<number, number> = {
  0: 0x5412,
  1: 0x5125,
  2: 0x5e7c,
  3: 0x5b4b,
  4: 0x45f9,
  5: 0x40ce,
  6: 0x4f97,
  7: 0x4aa0,
};

/** Write format information bits into the matrix. */
function writeFormatInfo(matrix: boolean[][], maskIdx: number): void {
  const size = matrix.length;
  const bits = FORMAT_BITS[maskIdx];

  // Format info is 15 bits, placed around the finder patterns
  for (let i = 0; i < 15; i++) {
    const bit = ((bits >> (14 - i)) & 1) === 1;

    // Around top-left (horizontal: row 8, columns 0-7 skipping col 6)
    if (i < 8) {
      const col = i < 6 ? i : i + 1;
      matrix[8][col] = bit;
    } else {
      // columns 7..14 → rows 7..0 of column 8 (but reversed positioning)
      const row = i === 8 ? 7 : 14 - i;
      matrix[row][8] = bit;
    }

    // Mirror: around top-right and bottom-left
    if (i < 8) {
      matrix[size - 1 - i][8] = bit;
    } else {
      matrix[8][size - 15 + i] = bit;
    }
  }
}

// ─── Penalty Scoring ────────────────────────────────────────────────────────

function penaltyScore(matrix: boolean[][]): number {
  const size = matrix.length;
  let score = 0;

  // Rule 1: Runs of 5+ same-color modules (horizontal and vertical)
  for (let r = 0; r < size; r++) {
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      if (matrix[r][c] === matrix[r][c - 1]) {
        runLen++;
      } else {
        if (runLen >= 5) score += runLen - 2;
        runLen = 1;
      }
    }
    if (runLen >= 5) score += runLen - 2;
  }
  for (let c = 0; c < size; c++) {
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      if (matrix[r][c] === matrix[r - 1][c]) {
        runLen++;
      } else {
        if (runLen >= 5) score += runLen - 2;
        runLen = 1;
      }
    }
    if (runLen >= 5) score += runLen - 2;
  }

  // Rule 2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = matrix[r][c];
      if (
        v === matrix[r][c + 1] &&
        v === matrix[r + 1][c] &&
        v === matrix[r + 1][c + 1]
      ) {
        score += 3;
      }
    }
  }

  // Rule 3: Finder-like patterns (1:1:3:1:1 with 4 whites)
  const pattern1 = [true, false, true, true, true, false, true, false, false, false, false];
  const pattern2 = [false, false, false, false, true, false, true, true, true, false, true];

  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 11; c++) {
      let match1 = true;
      let match2 = true;
      for (let k = 0; k < 11; k++) {
        if (matrix[r][c + k] !== pattern1[k]) match1 = false;
        if (matrix[r][c + k] !== pattern2[k]) match2 = false;
      }
      if (match1 || match2) score += 40;
    }
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r <= size - 11; r++) {
      let match1 = true;
      let match2 = true;
      for (let k = 0; k < 11; k++) {
        if (matrix[r + k][c] !== pattern1[k]) match1 = false;
        if (matrix[r + k][c] !== pattern2[k]) match2 = false;
      }
      if (match1 || match2) score += 40;
    }
  }

  // Rule 4: Proportion of dark modules
  let darkCount = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) darkCount++;
    }
  }
  const total = size * size;
  const pct = (darkCount * 100) / total;
  const prev5 = Math.floor(pct / 5) * 5;
  const next5 = prev5 + 5;
  score += Math.min(Math.abs(prev5 - 50) / 5, Math.abs(next5 - 50) / 5) * 10;

  return score;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Generate a QR code matrix (2D boolean array, true = dark module). */
export function generateQRMatrix(text: string): boolean[][] {
  const data = new TextEncoder().encode(text);
  const version = selectVersion(data.length);
  const dataBytes = encodeData(data, version);
  const codewords = buildCodewords(dataBytes, version);
  const baseMatrix = buildMatrix(codewords, version);
  const reservedMask = buildReservedMask(version);

  // Try all 8 mask patterns, pick the one with lowest penalty
  let bestMatrix = baseMatrix;
  let bestScore = Infinity;

  for (let m = 0; m < 8; m++) {
    const masked = applyMask(baseMatrix, reservedMask, m);
    writeFormatInfo(masked, m);
    const score = penaltyScore(masked);
    if (score < bestScore) {
      bestScore = score;
      bestMatrix = masked;
    }
  }

  return bestMatrix;
}

/**
 * Render a QR matrix as UTF-8 half-block characters for terminal display.
 * Uses 2 vertical modules per character row for compact output.
 * Includes a 1-module quiet zone on all sides.
 */
export function renderQRText(matrix: boolean[][]): string {
  const size = matrix.length;
  const lines: string[] = [];

  // Helper: get module value with quiet zone (false = white outside bounds)
  const mod = (r: number, c: number): boolean => {
    if (r < 0 || r >= size || c < 0 || c >= size) return false;
    return matrix[r][c];
  };

  // Process 2 rows at a time, with 1-module quiet zone on each side
  for (let r = -1; r < size + 1; r += 2) {
    let line = '';
    for (let c = -1; c < size + 1; c++) {
      const top = mod(r, c);
      const bottom = mod(r + 1, c);

      if (top && bottom) {
        line += '\u2588'; // █ Full Block
      } else if (top && !bottom) {
        line += '\u2580'; // ▀ Upper Half Block
      } else if (!top && bottom) {
        line += '\u2584'; // ▄ Lower Half Block
      } else {
        line += ' ';
      }
    }
    lines.push(line);
  }

  return lines.join('\n');
}

/**
 * Generate a QR code as UTF-8 text for terminal display.
 * @param text — the text to encode (e.g., a URL)
 * @returns Multi-line string of Unicode block characters
 */
export function generateQR(text: string): string {
  const matrix = generateQRMatrix(text);
  return renderQRText(matrix);
}


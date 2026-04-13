var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/store.ts
var DEFAULT_TTL_SECONDS = 600;
var SESSION_PREFIX = "s:";
var KVSessionStore = class {
  constructor(kv, ttlSeconds = DEFAULT_TTL_SECONDS) {
    this.kv = kv;
    this.ttlSeconds = ttlSeconds;
  }
  static {
    __name(this, "KVSessionStore");
  }
  async create(token, publicKey) {
    const session = {
      publicKey,
      expiresAt: Date.now() + this.ttlSeconds * 1e3
    };
    await this.kv.put(SESSION_PREFIX + token, JSON.stringify(session), {
      expirationTtl: this.ttlSeconds
    });
    return true;
  }
  async get(token) {
    const raw = await this.kv.get(SESSION_PREFIX + token);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (Date.now() > session.expiresAt) {
      await this.kv.delete(SESSION_PREFIX + token);
      return null;
    }
    return session;
  }
  async has(token) {
    return await this.get(token) !== null;
  }
  async submitCredentials(token, encrypted, ephemeralPublicKey, nonce) {
    const session = await this.get(token);
    if (!session) return false;
    if (session.encrypted) return false;
    session.encrypted = encrypted;
    session.ephemeralPublicKey = ephemeralPublicKey;
    session.nonce = nonce;
    const remainingSeconds = Math.max(
      1,
      Math.floor((session.expiresAt - Date.now()) / 1e3)
    );
    await this.kv.put(SESSION_PREFIX + token, JSON.stringify(session), {
      expirationTtl: remainingSeconds
    });
    return true;
  }
  async delete(token) {
    await this.kv.delete(SESSION_PREFIX + token);
  }
};

// src/rate-limit.ts
var RATE_LIMITS = {
  sessionCreate: { maxRequests: 5, windowMs: 6e4 },
  poll: { maxRequests: 30, windowMs: 6e4 },
  submit: { maxRequests: 3, windowMs: 6e4 },
  qr: { maxRequests: 30, windowMs: 6e4 }
};
var GLOBAL_SESSION_LIMIT = {
  maxRequests: 1e3,
  windowMs: 36e5
};
var RL_PREFIX = "rl:";
var KVRateLimiter = class {
  constructor(kv) {
    this.kv = kv;
  }
  static {
    __name(this, "KVRateLimiter");
  }
  /**
   * Check if a request is allowed. Increments the counter if allowed.
   * Returns true if under the limit, false if rate-limited.
   */
  async check(key, rule) {
    const windowId = Math.floor(Date.now() / rule.windowMs);
    const kvKey = `${RL_PREFIX}${key}:${windowId}`;
    const ttlSeconds = Math.ceil(rule.windowMs / 1e3);
    const raw = await this.kv.get(kvKey);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count >= rule.maxRequests) {
      return false;
    }
    await this.kv.put(kvKey, String(count + 1), {
      expirationTtl: ttlSeconds
    });
    return true;
  }
  /**
   * Check the global rate limit (shared across all IPs).
   */
  async checkGlobal(rule) {
    return this.check("global", rule);
  }
  /**
   * Get remaining requests for a key under a rule.
   */
  async remaining(key, rule) {
    const windowId = Math.floor(Date.now() / rule.windowMs);
    const kvKey = `${RL_PREFIX}${key}:${windowId}`;
    const raw = await this.kv.get(kvKey);
    const count = raw ? parseInt(raw, 10) : 0;
    return Math.max(0, rule.maxRequests - count);
  }
};

// src/token.ts
var SAFE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
var TOKEN_LENGTH = 5;
var MAX_RETRIES = 10;
var REJECT_THRESHOLD = 224;
function generateRawToken() {
  const chars = [];
  while (chars.length < TOKEN_LENGTH) {
    const bytes = new Uint8Array(TOKEN_LENGTH - chars.length + 4);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < REJECT_THRESHOLD && chars.length < TOKEN_LENGTH) {
        chars.push(SAFE_ALPHABET[byte % SAFE_ALPHABET.length]);
      }
    }
  }
  return chars.join("");
}
__name(generateRawToken, "generateRawToken");
function generateUniqueToken(existsFn) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const token = generateRawToken();
    if (!existsFn(token)) return token;
  }
  throw new Error(`Failed to generate unique token after ${MAX_RETRIES} attempts`);
}
__name(generateUniqueToken, "generateUniqueToken");

// src/qr.ts
var GF_POLY = 285;
var GF_EXP = new Uint8Array(256);
var GF_LOG = new Uint8Array(256);
{
  let val = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = val;
    GF_LOG[val] = i;
    val <<= 1;
    if (val >= 256) val ^= GF_POLY;
  }
  GF_EXP[255] = GF_EXP[0];
}
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
}
__name(gfMul, "gfMul");
function polyMul(a, b) {
  const result = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      result[i + j] ^= gfMul(a[i], b[j]);
    }
  }
  return result;
}
__name(polyMul, "polyMul");
function rsEncode(data, ecCount) {
  let gen = [1];
  for (let i = 0; i < ecCount; i++) {
    gen = polyMul(gen, [1, GF_EXP[i]]);
  }
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
__name(rsEncode, "rsEncode");
var VERSION_TABLE = {
  1: { totalCW: 26, ecPerBlock: 10, blocks: 1, dataCW: 16 },
  2: { totalCW: 44, ecPerBlock: 16, blocks: 1, dataCW: 28 },
  3: { totalCW: 70, ecPerBlock: 26, blocks: 1, dataCW: 44 },
  4: { totalCW: 100, ecPerBlock: 18, blocks: 2, dataCW: 64 }
};
var BYTE_CAPACITY = {
  1: 14,
  2: 26,
  3: 42,
  4: 62
};
function versionSize(version) {
  return 17 + version * 4;
}
__name(versionSize, "versionSize");
function charCountBits(version) {
  return version <= 9 ? 8 : 16;
}
__name(charCountBits, "charCountBits");
var ALIGNMENT_POSITIONS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26]
};
function selectVersion(dataLength) {
  for (let v = 1; v <= 4; v++) {
    if (dataLength <= BYTE_CAPACITY[v]) return v;
  }
  throw new Error(
    `Data too long (${dataLength} bytes). Max ${BYTE_CAPACITY[4]} bytes for Version 4 EC-M.`
  );
}
__name(selectVersion, "selectVersion");
function encodeData(data, version) {
  const info = VERSION_TABLE[version];
  const bits = [];
  const pushBits = /* @__PURE__ */ __name((value, count) => {
    for (let i = count - 1; i >= 0; i--) {
      bits.push(value >> i & 1);
    }
  }, "pushBits");
  pushBits(4, 4);
  pushBits(data.length, charCountBits(version));
  for (const byte of data) {
    pushBits(byte, 8);
  }
  const totalDataBits = info.dataCW * 8;
  const terminatorLen = Math.min(4, totalDataBits - bits.length);
  pushBits(0, terminatorLen);
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }
  const padBytes = [236, 17];
  let padIdx = 0;
  while (bits.length < totalDataBits) {
    pushBits(padBytes[padIdx % 2], 8);
    padIdx++;
  }
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      byte = byte << 1 | (bits[i + j] || 0);
    }
    bytes.push(byte);
  }
  return bytes;
}
__name(encodeData, "encodeData");
function buildCodewords(dataBytes, version) {
  const info = VERSION_TABLE[version];
  const ecPerBlock = info.ecPerBlock;
  const numBlocks = info.blocks;
  const dataCWPerBlock = Math.floor(info.dataCW / numBlocks);
  const shortBlocks = numBlocks - info.dataCW % numBlocks;
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const blockLen = dataCWPerBlock + (b >= shortBlocks ? 1 : 0);
    const block = dataBytes.slice(offset, offset + blockLen);
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
    offset += blockLen;
  }
  const result = [];
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) result.push(block[i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) {
      if (i < block.length) result.push(block[i]);
    }
  }
  return result;
}
__name(buildCodewords, "buildCodewords");
function buildMatrix(codewords, version) {
  const size = versionSize(version);
  const matrix = Array.from(
    { length: size },
    () => new Array(size).fill(null)
  );
  const reserved = Array.from(
    { length: size },
    () => new Array(size).fill(false)
  );
  const placeFinder = /* @__PURE__ */ __name((row, col2) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const mr = row + r;
        const mc = col2 + c;
        if (mr < 0 || mr >= size || mc < 0 || mc >= size) continue;
        let dark = false;
        if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
          if (r === 0 || r === 6 || c === 0 || c === 6 || r >= 2 && r <= 4 && c >= 2 && c <= 4) {
            dark = true;
          }
        }
        matrix[mr][mc] = dark;
        reserved[mr][mc] = true;
      }
    }
  }, "placeFinder");
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    if (matrix[6][i] === null) {
      matrix[6][i] = dark;
      reserved[6][i] = true;
    }
    if (matrix[i][6] === null) {
      matrix[i][6] = dark;
      reserved[i][6] = true;
    }
  }
  const alignPos = ALIGNMENT_POSITIONS[version];
  if (alignPos.length > 0) {
    for (const row of alignPos) {
      for (const col2 of alignPos) {
        if (reserved[row][col2]) continue;
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            const dark = Math.abs(r) === 2 || Math.abs(c) === 2 || r === 0 && c === 0;
            matrix[row + r][col2 + c] = dark;
            reserved[row + r][col2 + c] = true;
          }
        }
      }
    }
  }
  matrix[size - 8][8] = true;
  reserved[size - 8][8] = true;
  for (let i = 0; i <= 8; i++) {
    if (!reserved[8][i]) {
      reserved[8][i] = true;
    }
    if (!reserved[i][8]) {
      reserved[i][8] = true;
    }
  }
  for (let i = 0; i <= 7; i++) {
    if (!reserved[8][size - 1 - i]) {
      reserved[8][size - 1 - i] = true;
    }
  }
  for (let i = 0; i <= 7; i++) {
    if (!reserved[size - 1 - i][8]) {
      reserved[size - 1 - i][8] = true;
    }
  }
  const bits = [];
  for (const cw of codewords) {
    for (let b = 7; b >= 0; b--) {
      bits.push(cw >> b & 1);
    }
  }
  let bitIdx = 0;
  let col = size - 1;
  while (col >= 0) {
    if (col === 6) {
      col--;
      continue;
    }
    const stripIndex = col >= 7 ? size - 1 - col >> 1 : size - 2 - col >> 1;
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
__name(buildMatrix, "buildMatrix");
var MASK_FUNCTIONS = [
  (r, c) => (r + c) % 2 === 0,
  // 000
  (r) => r % 2 === 0,
  // 001
  (_r, c) => c % 3 === 0,
  // 010
  (r, c) => (r + c) % 3 === 0,
  // 011
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  // 100
  (r, c) => r * c % 2 + r * c % 3 === 0,
  // 101
  (r, c) => (r * c % 2 + r * c % 3) % 2 === 0,
  // 110
  (r, c) => ((r + c) % 2 + r * c % 3) % 2 === 0
  // 111
];
function buildReservedMask(version) {
  const size = versionSize(version);
  const reserved = Array.from(
    { length: size },
    () => new Array(size).fill(false)
  );
  const markFinder = /* @__PURE__ */ __name((row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const mr = row + r;
        const mc = col + c;
        if (mr >= 0 && mr < size && mc >= 0 && mc < size) {
          reserved[mr][mc] = true;
        }
      }
    }
  }, "markFinder");
  markFinder(0, 0);
  markFinder(0, size - 7);
  markFinder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    reserved[6][i] = true;
    reserved[i][6] = true;
  }
  const alignPos = ALIGNMENT_POSITIONS[version];
  if (alignPos.length > 0) {
    for (const row of alignPos) {
      for (const col of alignPos) {
        let overlapsFinder = false;
        for (const [fr, fc] of [
          [0, 0],
          [0, size - 7],
          [size - 7, 0]
        ]) {
          if (row >= fr - 1 && row <= fr + 7 && col >= fc - 1 && col <= fc + 7) {
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
  reserved[size - 8][8] = true;
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
__name(buildReservedMask, "buildReservedMask");
function applyMask(matrix, reservedMask, maskIdx) {
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
__name(applyMask, "applyMask");
var FORMAT_BITS = {
  0: 21522,
  1: 20773,
  2: 24188,
  3: 23371,
  4: 17913,
  5: 16590,
  6: 20375,
  7: 19104
};
function writeFormatInfo(matrix, maskIdx) {
  const size = matrix.length;
  const bits = FORMAT_BITS[maskIdx];
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> 14 - i & 1) === 1;
    if (i < 8) {
      const col = i < 6 ? i : i + 1;
      matrix[8][col] = bit;
    } else {
      const row = i === 8 ? 7 : 14 - i;
      matrix[row][8] = bit;
    }
    if (i < 8) {
      matrix[size - 1 - i][8] = bit;
    } else {
      matrix[8][size - 15 + i] = bit;
    }
  }
}
__name(writeFormatInfo, "writeFormatInfo");
function penaltyScore(matrix) {
  const size = matrix.length;
  let score = 0;
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
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = matrix[r][c];
      if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) {
        score += 3;
      }
    }
  }
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
  let darkCount = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) darkCount++;
    }
  }
  const total = size * size;
  const pct = darkCount * 100 / total;
  const prev5 = Math.floor(pct / 5) * 5;
  const next5 = prev5 + 5;
  score += Math.min(Math.abs(prev5 - 50) / 5, Math.abs(next5 - 50) / 5) * 10;
  return score;
}
__name(penaltyScore, "penaltyScore");
function generateQRMatrix(text) {
  const data = new TextEncoder().encode(text);
  const version = selectVersion(data.length);
  const dataBytes = encodeData(data, version);
  const codewords = buildCodewords(dataBytes, version);
  const baseMatrix = buildMatrix(codewords, version);
  const reservedMask = buildReservedMask(version);
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
__name(generateQRMatrix, "generateQRMatrix");
function renderQRText(matrix) {
  const size = matrix.length;
  const lines = [];
  const mod = /* @__PURE__ */ __name((r, c) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return false;
    return matrix[r][c];
  }, "mod");
  for (let r = -1; r < size + 1; r += 2) {
    let line = "";
    for (let c = -1; c < size + 1; c++) {
      const top = mod(r, c);
      const bottom = mod(r + 1, c);
      if (top && bottom) {
        line += "\u2588";
      } else if (top && !bottom) {
        line += "\u2580";
      } else if (!top && bottom) {
        line += "\u2584";
      } else {
        line += " ";
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}
__name(renderQRText, "renderQRText");
function generateQR(text) {
  const matrix = generateQRMatrix(text);
  return renderQRText(matrix);
}
__name(generateQR, "generateQR");

// src/page.ts
var AUTH_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FlowHelm \u2014 Authenticate</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f1117;
      color: #e1e4e8;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 20px;
    }

    .container {
      max-width: 480px;
      width: 100%;
    }

    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 8px;
      color: #f0f3f6;
    }

    .subtitle {
      color: #8b949e;
      margin-bottom: 24px;
      font-size: 0.95rem;
      line-height: 1.5;
    }

    .steps {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 24px;
    }

    .step {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
    }

    .step:last-child { margin-bottom: 0; }

    .step-num {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: #21262d;
      border: 1px solid #30363d;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.85rem;
      font-weight: 600;
      color: #8b949e;
    }

    .step-content { flex: 1; }

    .step-content p {
      font-size: 0.9rem;
      line-height: 1.5;
      color: #c9d1d9;
    }

    code {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 4px;
      padding: 2px 6px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.85rem;
      color: #79c0ff;
    }

    .input-group {
      margin-bottom: 16px;
    }

    label {
      display: block;
      font-size: 0.85rem;
      font-weight: 500;
      color: #8b949e;
      margin-bottom: 6px;
    }

    textarea {
      width: 100%;
      height: 80px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #e1e4e8;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.85rem;
      padding: 10px;
      resize: vertical;
    }

    textarea:focus {
      outline: none;
      border-color: #58a6ff;
      box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.15);
    }

    button {
      width: 100%;
      padding: 12px;
      border: none;
      border-radius: 6px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }

    button.primary {
      background: #238636;
      color: #fff;
    }

    button.primary:hover { background: #2ea043; }
    button.primary:disabled {
      background: #21262d;
      color: #484f58;
      cursor: not-allowed;
    }

    .status {
      margin-top: 16px;
      padding: 12px;
      border-radius: 6px;
      font-size: 0.9rem;
      display: none;
    }

    .status.success {
      display: block;
      background: rgba(35, 134, 54, 0.15);
      border: 1px solid #238636;
      color: #3fb950;
    }

    .status.error {
      display: block;
      background: rgba(248, 81, 73, 0.15);
      border: 1px solid #f85149;
      color: #f85149;
    }

    .security-note {
      margin-top: 24px;
      padding: 12px;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      font-size: 0.8rem;
      color: #8b949e;
      line-height: 1.5;
    }

    .noscript-warning {
      background: rgba(248, 81, 73, 0.15);
      border: 1px solid #f85149;
      color: #f85149;
      padding: 16px;
      border-radius: 6px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authenticate FlowHelm</h1>
    <p class="subtitle">
      Securely transfer your Claude credentials to your FlowHelm instance.
      All encryption happens in your browser \u2014 the server never sees your token.
    </p>

    <noscript>
      <div class="noscript-warning">
        <p>JavaScript is required for secure credential transfer.</p>
        <p style="margin-top: 8px;">
          Alternatively, paste the token directly into your FlowHelm terminal.
        </p>
      </div>
    </noscript>

    <div id="app">
      <div class="steps">
        <div class="step">
          <div class="step-num">1</div>
          <div class="step-content">
            <p>On a machine with Claude Code installed, run:</p>
            <p style="margin-top: 6px;"><code>claude setup-token</code></p>
          </div>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <div class="step-content">
            <p>Copy the token that is displayed.</p>
          </div>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <div class="step-content">
            <p>Paste it below and click <strong>Connect</strong>.</p>
          </div>
        </div>
      </div>

      <div class="input-group">
        <label for="token-input">Claude Setup Token</label>
        <textarea id="token-input" placeholder="Paste your token here..." spellcheck="false"></textarea>
      </div>

      <button id="connect-btn" class="primary" disabled>Connect</button>

      <div id="status" class="status"></div>

      <div class="security-note">
        Your token is encrypted end-to-end using X25519 key exchange and AES-256-GCM.
        The encryption key is derived from a keypair generated by your FlowHelm instance.
        This page cannot read the private key \u2014 only the public key is passed via the
        URL fragment (which is never sent to the server).
      </div>
    </div>
  </div>

  <script>
    (function() {
      'use strict';

      var TOKEN = '{{TOKEN}}';
      var BASE_URL = '{{BASE_URL}}';
      var tokenInput = document.getElementById('token-input');
      var connectBtn = document.getElementById('connect-btn');
      var statusEl = document.getElementById('status');

      var hash = window.location.hash;
      var pkMatch = hash.match(/pk=([^&]+)/);

      if (!pkMatch) {
        showError('Missing public key. Please scan the QR code again from your FlowHelm terminal.');
        connectBtn.disabled = true;
        tokenInput.disabled = true;
        return;
      }

      var vmPublicKeyB64 = decodeURIComponent(pkMatch[1]);

      tokenInput.addEventListener('input', function() {
        connectBtn.disabled = !this.value.trim();
      });

      connectBtn.addEventListener('click', async function() {
        var plaintext = tokenInput.value.trim();
        if (!plaintext) return;

        connectBtn.disabled = true;
        connectBtn.textContent = 'Encrypting...';

        try {
          await encryptAndSubmit(plaintext, vmPublicKeyB64);
          showSuccess('Token encrypted and sent. Check your FlowHelm terminal.');
          tokenInput.disabled = true;
        } catch (err) {
          showError('Encryption failed: ' + err.message);
          connectBtn.disabled = false;
          connectBtn.textContent = 'Connect';
        }
      });

      async function encryptAndSubmit(plaintext, vmPubKeyB64) {
        var vmPubKeyBytes = base64ToBytes(vmPubKeyB64);

        var vmPubKey = await crypto.subtle.importKey(
          'raw', vmPubKeyBytes, { name: 'X25519' }, false, []
        );

        var ephKeyPair = await crypto.subtle.generateKey(
          { name: 'X25519' }, true, ['deriveBits']
        );

        var sharedBits = await crypto.subtle.deriveBits(
          { name: 'X25519', public: vmPubKey },
          ephKeyPair.privateKey, 256
        );

        var aesKey = await crypto.subtle.importKey(
          'raw', sharedBits, { name: 'AES-GCM' }, false, ['encrypt']
        );

        var nonce = crypto.getRandomValues(new Uint8Array(12));
        var encoded = new TextEncoder().encode(plaintext);
        var ciphertext = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: nonce }, aesKey, encoded
        );

        var ephPubKeyBytes = await crypto.subtle.exportKey('raw', ephKeyPair.publicKey);

        var response = await fetch(BASE_URL + '/api/session/' + TOKEN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            encrypted: bytesToBase64(new Uint8Array(ciphertext)),
            ephemeralPublicKey: bytesToBase64(new Uint8Array(ephPubKeyBytes)),
            nonce: bytesToBase64(nonce),
          }),
        });

        if (!response.ok) {
          var data = await response.json().catch(function() { return {}; });
          throw new Error(data.error || 'Server error: ' + response.status);
        }
      }

      function base64ToBytes(b64) {
        var binary = atob(b64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
      }

      function bytesToBase64(bytes) {
        var binary = '';
        for (var i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
      }

      function showSuccess(msg) {
        statusEl.className = 'status success';
        statusEl.textContent = msg;
      }

      function showError(msg) {
        statusEl.className = 'status error';
        statusEl.textContent = msg;
      }
    })();
  <\/script>
</body>
</html>`;

// src/index.ts
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}
__name(json, "json");
function rateLimited(retryAfterMs) {
  return json(
    { error: "Too many requests" },
    429,
    { "Retry-After": String(Math.ceil(retryAfterMs / 1e3)) }
  );
}
__name(rateLimited, "rateLimited");
function getClientIP(request) {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "0.0.0.0";
}
__name(getClientIP, "getClientIP");
function parsePath(url) {
  return url.pathname.split("/").filter(Boolean);
}
__name(parsePath, "parsePath");
function withCors(response, origin) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
__name(withCors, "withCors");
async function parseBody(request) {
  try {
    const text = await request.text();
    if (text.length > 65536) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}
__name(parseBody, "parseBody");
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const method = request.method;
  const segments = parsePath(url);
  const ip = getClientIP(request);
  const baseUrl = (env.BASE_URL || "https://flowhelm.to").replace(/\/$/, "");
  const corsOrigin = new URL(baseUrl).origin;
  const store = new KVSessionStore(env.SESSIONS);
  const limiter = new KVRateLimiter(env.SESSIONS);
  if (method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }), corsOrigin);
  }
  let response;
  if (url.pathname === "/health" && method === "GET") {
    response = json({ status: "ok" });
    return withCors(response, corsOrigin);
  }
  if (segments[0] === "api" && segments[1] === "session" && segments.length === 2 && method === "POST") {
    if (!await limiter.check(`create:${ip}`, RATE_LIMITS.sessionCreate)) {
      response = rateLimited(6e4);
      return withCors(response, corsOrigin);
    }
    if (!await limiter.checkGlobal(GLOBAL_SESSION_LIMIT)) {
      response = rateLimited(6e4);
      return withCors(response, corsOrigin);
    }
    const body = await parseBody(request);
    if (!body || typeof body.publicKey !== "string" || !body.publicKey) {
      response = json({ error: "Missing or invalid publicKey" }, 400);
      return withCors(response, corsOrigin);
    }
    let token = null;
    for (let i = 0; i < 10; i++) {
      const candidate = generateUniqueToken(() => false);
      if (!await store.has(candidate)) {
        token = candidate;
        break;
      }
    }
    if (!token) {
      response = json({ error: "Server at capacity" }, 503);
      return withCors(response, corsOrigin);
    }
    await store.create(token, body.publicKey);
    const session = await store.get(token);
    response = json({ token, expiresAt: session.expiresAt }, 201);
    return withCors(response, corsOrigin);
  }
  if (segments[0] === "api" && segments[1] === "session" && segments.length === 4 && segments[3] === "poll" && method === "GET") {
    if (!await limiter.check(`poll:${ip}`, RATE_LIMITS.poll)) {
      response = rateLimited(6e4);
      return withCors(response, corsOrigin);
    }
    const token = segments[2];
    const session = await store.get(token);
    if (!session) {
      response = json({ error: "Session not found or expired" }, 404);
      return withCors(response, corsOrigin);
    }
    if (session.encrypted) {
      response = json({
        status: "ready",
        encrypted: session.encrypted,
        ephemeralPublicKey: session.ephemeralPublicKey,
        nonce: session.nonce
      });
    } else {
      response = json({ status: "pending" });
    }
    return withCors(response, corsOrigin);
  }
  if (segments[0] === "api" && segments[1] === "session" && segments.length === 3 && method === "POST") {
    if (!await limiter.check(`submit:${ip}`, RATE_LIMITS.submit)) {
      response = rateLimited(6e4);
      return withCors(response, corsOrigin);
    }
    const token = segments[2];
    const body = await parseBody(request);
    if (!body || typeof body.encrypted !== "string" || typeof body.ephemeralPublicKey !== "string" || typeof body.nonce !== "string") {
      response = json({ error: "Missing encrypted, ephemeralPublicKey, or nonce" }, 400);
      return withCors(response, corsOrigin);
    }
    const ok = await store.submitCredentials(
      token,
      body.encrypted,
      body.ephemeralPublicKey,
      body.nonce
    );
    if (!ok) {
      response = json({ error: "Session not found, expired, or already submitted" }, 404);
      return withCors(response, corsOrigin);
    }
    response = json({ status: "ok" });
    return withCors(response, corsOrigin);
  }
  if (segments[0] === "api" && segments[1] === "session" && segments.length === 3 && method === "DELETE") {
    const token = segments[2];
    await store.delete(token);
    response = json({ status: "deleted" });
    return withCors(response, corsOrigin);
  }
  if (segments[0] === "qr" && segments.length === 2 && method === "GET") {
    if (!await limiter.check(`qr:${ip}`, RATE_LIMITS.qr)) {
      response = rateLimited(6e4);
      return withCors(response, corsOrigin);
    }
    const token = segments[1];
    const session = await store.get(token);
    if (!session) {
      response = json({ error: "Session not found or expired" }, 404);
      return withCors(response, corsOrigin);
    }
    const qrUrl = `${baseUrl}/${token}`;
    const qrText = generateQR(qrUrl);
    response = new Response(qrText, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
    return withCors(response, corsOrigin);
  }
  if (segments[0] === "a" && segments.length === 2 && method === "GET") {
    const token = segments[1];
    const session = await store.get(token);
    if (!session) {
      return new Response("Session not found or expired.", { status: 404 });
    }
    const html = AUTH_PAGE_HTML.replace("{{TOKEN}}", token).replace("{{BASE_URL}}", baseUrl);
    response = new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
    return withCors(response, corsOrigin);
  }
  if (segments.length === 1 && method === "GET") {
    const token = segments[0];
    if (["favicon.ico", "robots.txt"].includes(token)) {
      return new Response(null, { status: 404 });
    }
    const session = await store.get(token);
    if (!session) {
      response = json({ error: "Session not found or expired" }, 404);
      return withCors(response, corsOrigin);
    }
    const redirectUrl = `${baseUrl}/a/${token}#pk=${encodeURIComponent(session.publicKey)}`;
    return Response.redirect(redirectUrl, 302);
  }
  response = json({ error: "Not found" }, 404);
  return withCors(response, corsOrigin);
}
__name(handleRequest, "handleRequest");
var src_default = {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      console.error("Request handler error:", err);
      return json({ error: "Internal server error" }, 500);
    }
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-IN19cB/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-IN19cB/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map

/* 秘密本：单篇文档的「隐藏」与「密码」。

   隐藏（isHidden）：条目仍是一份普通笔记文件，只是不再进入任何列表、搜索、统计与 AI 提问范围，
   只能在「设置 → 秘密本」里找到并打开。

   密码（locked）：正文以 AES-256-GCM 加密后落盘。落盘那一步由 store.js 的 serializeItemFile
   调 serializeSecretBody 现做密文，因此任何保存路径都写不出明文；标题、文件夹、标签与时间等元数据
   保持明文，用于在列表与秘密本里定位条目。

   口令既不落盘也不留在内存：只保留会话内的派生密钥（见 secretUnlocked），关闭页面即全部失效，
   忘记口令的文档无法恢复。

   加解密不依赖 WebCrypto：`crypto.subtle` 只在安全上下文（https 或 localhost）里存在，
   而网页版常年跑在局域网的 http 上。这里是纯 JS 实现的 PBKDF2-SHA256 与 AES-256-GCM；
   信封格式与桌面版逐字段一致，同一份文档在两端都能解开（校验办法见仓库记忆）。 */

/* ---------------- 摘要与派生 ---------------- */

/* SHA-256 的轮常量与初始值按标准定义从质数平方根 / 立方根的小数部分算出，不写死表：
   手抄 64 个常量出错的可能性远高于让机器算。 */
const secretShaPrimes = (() => {
    const list = [];
    for (let n = 2; list.length < 64; n++) {
        let prime = true;
        for (let d = 2; d * d <= n; d++) {
            if (n % d === 0) { prime = false; break; }
        }
        if (prime) list.push(n);
    }
    return list;
})();

// 取一个数小数部分的高 32 位：先乘 2^32 再取整，浮点误差远小于 1
function secretFrac32(value) {
    return Math.floor((value - Math.floor(value)) * 4294967296) >>> 0;
}

const secretSha256K = (() => {
    const table = new Uint32Array(64);
    for (let i = 0; i < 64; i++) table[i] = secretFrac32(Math.cbrt(secretShaPrimes[i]));
    return table;
})();

const secretSha256H0 = (() => {
    const table = new Uint32Array(8);
    for (let i = 0; i < 8; i++) table[i] = secretFrac32(Math.sqrt(secretShaPrimes[i]));
    return table;
})();

// 消息扩展用的是同一块 scratch：单线程，逐块重写前 16 个字
const secretSha256W = new Uint32Array(64);

function secretSha256Block(state, bytes, offset) {
    const w = secretSha256W;
    for (let i = 0; i < 16; i++) {
        const j = offset + i * 4;
        w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
        const x = w[i - 15];
        const y = w[i - 2];
        const s0 = (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) >>> 0;
        const s1 = (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];

    for (let i = 0; i < 64; i++) {
        const s1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
        const ch = ((e & f) ^ (~e & g)) >>> 0;
        const t1 = (h + s1 + ch + secretSha256K[i] + w[i]) >>> 0;
        const s0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
        const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        const t2 = (s0 + maj) >>> 0;
        h = g; g = f; f = e;
        e = (d + t1) >>> 0;
        d = c; c = b; b = a;
        a = (t1 + t2) >>> 0;
    }

    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
}

// 可续写的摘要状态：PBKDF2 要用 ipad / opad 压缩后的中间态反复起头。
// absorbed 是已经吃进去的字节数（预压缩的填充块），填充里的比特长度要把它算上
function secretSha256Create(initial, absorbed = 0) {
    return {
        h: (initial || secretSha256H0).slice(),
        block: new Uint8Array(64),
        used: 0,
        total: absorbed
    };
}

function secretSha256Update(ctx, bytes) {
    ctx.total += bytes.length;
    let offset = 0;

    if (ctx.used) {
        const take = Math.min(64 - ctx.used, bytes.length);
        ctx.block.set(bytes.subarray(0, take), ctx.used);
        ctx.used += take;
        offset = take;
        if (ctx.used === 64) {
            secretSha256Block(ctx.h, ctx.block, 0);
            ctx.used = 0;
        }
    }

    while (offset + 64 <= bytes.length) {
        secretSha256Block(ctx.h, bytes, offset);
        offset += 64;
    }

    if (offset < bytes.length) {
        ctx.block.set(bytes.subarray(offset), 0);
        ctx.used = bytes.length - offset;
    }
    return ctx;
}

function secretSha256Final(ctx) {
    const bits = ctx.total * 8;
    const high = Math.floor(bits / 4294967296);
    const low = bits >>> 0;
    let used = ctx.used;

    ctx.block[used++] = 0x80;
    if (used > 56) {
        while (used < 64) ctx.block[used++] = 0;
        secretSha256Block(ctx.h, ctx.block, 0);
        used = 0;
    }
    while (used < 56) ctx.block[used++] = 0;
    ctx.block[56] = (high >>> 24) & 0xff;
    ctx.block[57] = (high >>> 16) & 0xff;
    ctx.block[58] = (high >>> 8) & 0xff;
    ctx.block[59] = high & 0xff;
    ctx.block[60] = (low >>> 24) & 0xff;
    ctx.block[61] = (low >>> 16) & 0xff;
    ctx.block[62] = (low >>> 8) & 0xff;
    ctx.block[63] = low & 0xff;
    secretSha256Block(ctx.h, ctx.block, 0);

    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
        out[i * 4] = (ctx.h[i] >>> 24) & 0xff;
        out[i * 4 + 1] = (ctx.h[i] >>> 16) & 0xff;
        out[i * 4 + 2] = (ctx.h[i] >>> 8) & 0xff;
        out[i * 4 + 3] = ctx.h[i] & 0xff;
    }
    return out;
}

function secretSha256Bytes(bytes) {
    return secretSha256Final(secretSha256Update(secretSha256Create(), bytes));
}

/* HMAC-SHA256：ipad / opad 那一块压缩完就固定了，PBKDF2 的上万次迭代共用这两个中间态，
   省掉每轮各压一遍两头。 */
function secretHmacCreate(keyBytes) {
    const key = keyBytes.length > 64 ? secretSha256Bytes(keyBytes) : keyBytes;
    const block = new Uint8Array(64);
    block.set(key);
    const inner = new Uint8Array(64);
    const outer = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
        inner[i] = block[i] ^ 0x36;
        outer[i] = block[i] ^ 0x5c;
    }
    const innerState = secretSha256Create().h;
    secretSha256Block(innerState, inner, 0);
    const outerState = secretSha256Create().h;
    secretSha256Block(outerState, outer, 0);
    return { innerState, outerState };
}

function secretHmacDigest(context, message) {
    // 两头各已经吃进一个填充块（64 字节），填充里的比特长度从 64 起算
    const inner = secretSha256Create(context.innerState, 64);
    secretSha256Update(inner, message);
    const outer = secretSha256Create(context.outerState, 64);
    secretSha256Update(outer, secretSha256Final(inner));
    return secretSha256Final(outer);
}

// PBKDF2-HMAC-SHA256：本轮只用 32 字节密钥，也就是单块（hLen = 32）
function secretPbkdf2(password, salt, iterations, keyBytes = 32) {
    const hmac = secretHmacCreate(password);
    const message = new Uint8Array(salt.length + 4);
    message.set(salt, 0);
    message[salt.length] = 0;
    message[salt.length + 1] = 0;
    message[salt.length + 2] = 0;
    message[salt.length + 3] = 1;

    let u = secretHmacDigest(hmac, message);
    const acc = u.slice();
    for (let i = 1; i < iterations; i++) {
        u = secretHmacDigest(hmac, u);
        for (let k = 0; k < 32; k++) acc[k] ^= u[k];
    }
    return acc.subarray(0, keyBytes);
}

/* ---------------- AES-256 与 GCM ----------------
   只要加密方向：GCM 的加密与解密都是「AES 加密同一套计数块」，不做 AES 逆变换。
   轮常量与 S 盒同样按定义算出来（S 盒由 GF(2^8) 求逆 + 仿射变换生成）。 */

function secretGf8Mul(a, b) {
    let product = 0;
    let left = a & 0xff;
    let right = b & 0xff;
    for (let i = 0; i < 8; i++) {
        if (right & 1) product ^= left;
        const carry = left & 0x80;
        left = (left << 1) & 0xff;
        if (carry) left ^= 0x1b;
        right >>= 1;
    }
    return product & 0xff;
}

const secretAesSbox = (() => {
    const exp = new Uint8Array(255);
    const log = new Uint8Array(256);
    let value = 1;
    for (let i = 0; i < 255; i++) {
        exp[i] = value;
        log[value] = i;
        value = secretGf8Mul(value, 3);
    }
    const box = new Uint8Array(256);
    const rot = (v, n) => ((v << n) | (v >>> (8 - n))) & 0xff;
    for (let a = 0; a < 256; a++) {
        // 指数表只有 255 项，a = 1 时 255 - log[a] 正好越界一格，因此对它取模
        const inverse = a === 0 ? 0 : exp[(255 - log[a]) % 255];
        box[a] = (inverse ^ rot(inverse, 1) ^ rot(inverse, 2) ^ rot(inverse, 3) ^ rot(inverse, 4) ^ 0x63) & 0xff;
    }
    return box;
})();

// 轮密钥展开成 240 字节：第 r 轮的 16 字节落在 rk[16r ... 16r+15]
function secretAesExpandKey(key) {
    const words = new Uint32Array(60);
    for (let i = 0; i < 8; i++) {
        words[i] = ((key[i * 4] << 24) | (key[i * 4 + 1] << 16) | (key[i * 4 + 2] << 8) | key[i * 4 + 3]) >>> 0;
    }
    const subWord = (word) => (
        (secretAesSbox[(word >>> 24) & 0xff] << 24)
        | (secretAesSbox[(word >>> 16) & 0xff] << 16)
        | (secretAesSbox[(word >>> 8) & 0xff] << 8)
        | secretAesSbox[word & 0xff]
    ) >>> 0;

    let rcon = 1;
    for (let i = 8; i < 60; i++) {
        let temp = words[i - 1];
        if (i % 8 === 0) {
            temp = ((temp << 8) | (temp >>> 24)) >>> 0;
            temp = (subWord(temp) ^ (rcon << 24)) >>> 0;
            rcon = secretGf8Mul(rcon, 2);
        } else if (i % 8 === 4) {
            temp = subWord(temp);
        }
        words[i] = (words[i - 8] ^ temp) >>> 0;
    }

    const roundKeys = new Uint8Array(240);
    for (let i = 0; i < 60; i++) {
        roundKeys[i * 4] = (words[i] >>> 24) & 0xff;
        roundKeys[i * 4 + 1] = (words[i] >>> 16) & 0xff;
        roundKeys[i * 4 + 2] = (words[i] >>> 8) & 0xff;
        roundKeys[i * 4 + 3] = words[i] & 0xff;
    }
    return roundKeys;
}

// 列优先排布：state[r + 4c] 是第 c 列第 r 行
function secretAesSubBytes(state) {
    for (let i = 0; i < 16; i++) state[i] = secretAesSbox[state[i]];
}

function secretAesShiftRows(state) {
    const copy = state.slice();
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            state[r + 4 * c] = copy[r + 4 * ((c + r) % 4)];
        }
    }
}

function secretAesMixColumns(state) {
    for (let c = 0; c < 4; c++) {
        const i = c * 4;
        const a0 = state[i];
        const a1 = state[i + 1];
        const a2 = state[i + 2];
        const a3 = state[i + 3];
        state[i] = secretGf8Mul(a0, 2) ^ secretGf8Mul(a1, 3) ^ a2 ^ a3;
        state[i + 1] = a0 ^ secretGf8Mul(a1, 2) ^ secretGf8Mul(a2, 3) ^ a3;
        state[i + 2] = a0 ^ a1 ^ secretGf8Mul(a2, 2) ^ secretGf8Mul(a3, 3);
        state[i + 3] = secretGf8Mul(a0, 3) ^ a1 ^ a2 ^ secretGf8Mul(a3, 2);
    }
}

function secretAesEncryptBlock(roundKeys, input) {
    const state = input.slice();
    for (let i = 0; i < 16; i++) state[i] ^= roundKeys[i];
    for (let round = 1; round <= 13; round++) {
        secretAesSubBytes(state);
        secretAesShiftRows(state);
        secretAesMixColumns(state);
        for (let i = 0; i < 16; i++) state[i] ^= roundKeys[round * 16 + i];
    }
    secretAesSubBytes(state);
    secretAesShiftRows(state);
    for (let i = 0; i < 16; i++) state[i] ^= roundKeys[14 * 16 + i];
    return state;
}

/* GF(2^128) 乘法：按 SP 800-38D 的定义逐位做（128 次一位），
   文档一次只有几十个分块，不值得为它上 4 位表。 */
function secretGhashMultiply(x, h) {
    const z = new Uint8Array(16);
    const v = x.slice();
    for (let i = 0; i < 128; i++) {
        if ((h[i >> 3] >>> (7 - (i & 7))) & 1) {
            for (let k = 0; k < 16; k++) z[k] ^= v[k];
        }
        const lsb = v[15] & 1;
        for (let k = 15; k > 0; k--) v[k] = ((v[k] >>> 1) | ((v[k - 1] & 1) << 7)) & 0xff;
        v[0] >>>= 1;
        if (lsb) v[0] ^= 0xe1;
    }
    return z;
}

// GHASH：无附加认证数据，长度块只写密文的比特长度
function secretGhash(h, ciphertext) {
    const y = new Uint8Array(16);
    const block = new Uint8Array(16);
    for (let offset = 0; offset < ciphertext.length; offset += 16) {
        const size = Math.min(16, ciphertext.length - offset);
        block.fill(0);
        block.set(ciphertext.subarray(offset, offset + size), 0);
        for (let k = 0; k < 16; k++) block[k] ^= y[k];
        y.set(secretGhashMultiply(block, h), 0);
    }

    const lengths = new Uint8Array(16);
    const bits = ciphertext.length * 8;
    const high = Math.floor(bits / 4294967296) & 0xffffffff;
    const low = bits >>> 0;
    lengths[8] = (high >>> 24) & 0xff;
    lengths[9] = (high >>> 16) & 0xff;
    lengths[10] = (high >>> 8) & 0xff;
    lengths[11] = high & 0xff;
    lengths[12] = (low >>> 24) & 0xff;
    lengths[13] = (low >>> 16) & 0xff;
    lengths[14] = (low >>> 8) & 0xff;
    lengths[15] = low & 0xff;
    for (let k = 0; k < 16; k++) lengths[k] ^= y[k];
    return secretGhashMultiply(lengths, h);
}

// 计数器块：J0 = IV || 0x00000001，数据块从 2 起
function secretGcmCounterBlock(iv, counter) {
    const block = new Uint8Array(16);
    block.set(iv, 0);
    block[12] = (counter >>> 24) & 0xff;
    block[13] = (counter >>> 16) & 0xff;
    block[14] = (counter >>> 8) & 0xff;
    block[15] = counter & 0xff;
    return block;
}

// 用同一把密钥做流加密：加密与解密都走这里
function secretGcmXorStream(roundKeys, iv, input) {
    const out = new Uint8Array(input.length);
    let counter = 2;
    for (let offset = 0; offset < input.length; offset += 16) {
        const stream = secretAesEncryptBlock(roundKeys, secretGcmCounterBlock(iv, counter));
        counter += 1;
        const size = Math.min(16, input.length - offset);
        for (let i = 0; i < size; i++) out[offset + i] = input[offset + i] ^ stream[i];
    }
    return out;
}

// 密文尾部接 16 字节认证标签，与桌面版 node:crypto 的输出同构
function secretGcmSeal(key, iv, plaintext) {
    const roundKeys = secretAesExpandKey(key);
    const ciphertext = secretGcmXorStream(roundKeys, iv, plaintext);
    const auth = secretAesEncryptBlock(roundKeys, secretGcmCounterBlock(iv, 1));
    const tag = secretGhash(secretAesEncryptBlock(roundKeys, new Uint8Array(16)), ciphertext);
    const sealed = new Uint8Array(ciphertext.length + 16);
    sealed.set(ciphertext, 0);
    for (let i = 0; i < 16; i++) sealed[ciphertext.length + i] = tag[i] ^ auth[i];
    return sealed;
}

// 解不开（口令不对或密文被改动）返回 null，调用方不得使用任何半成品明文
function secretGcmOpen(key, iv, sealed) {
    if (sealed.length < 16) return null;
    const size = sealed.length - 16;
    const ciphertext = sealed.subarray(0, size);
    const tag = sealed.subarray(size);

    const roundKeys = secretAesExpandKey(key);
    const auth = secretAesEncryptBlock(roundKeys, secretGcmCounterBlock(iv, 1));
    const expected = secretGhash(secretAesEncryptBlock(roundKeys, new Uint8Array(16)), ciphertext);

    let diff = 0;
    for (let i = 0; i < 16; i++) diff |= (expected[i] ^ auth[i]) ^ tag[i];
    if (diff !== 0) return null;
    return secretGcmXorStream(roundKeys, iv, ciphertext);
}

/* ---------------- 编码与信封 ---------------- */

const SECRET_BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function secretBytesToBase64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += SECRET_BASE64_CHARS[b0 >> 2];
        out += SECRET_BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
        out += i + 1 < bytes.length ? SECRET_BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
        out += i + 2 < bytes.length ? SECRET_BASE64_CHARS[b2 & 63] : '=';
    }
    return out;
}

// 认不出的字符一律当作没有：信封解析失败会按「无法识别」处理，不抛错
function secretBase64ToBytes(text) {
    const clean = String(text || '').replace(/[^A-Za-z0-9+/]/g, '');
    const length = Math.floor((clean.length * 3) / 4);
    const out = new Uint8Array(length);
    let acc = 0;
    let bits = 0;
    let index = 0;
    for (let i = 0; i < clean.length; i++) {
        const value = SECRET_BASE64_CHARS.indexOf(clean[i]);
        if (value < 0) continue;
        acc = (acc << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (index < length) out[index++] = (acc >>> bits) & 0xff;
        }
    }
    return out.subarray(0, index);
}

function secretUtf8Bytes(text) {
    return new TextEncoder().encode(String(text == null ? '' : text));
}

function secretUtf8Text(bytes) {
    return new TextDecoder().decode(bytes);
}

function secretRandomBytes(length) {
    const bytes = new Uint8Array(length);
    if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(bytes);
        return bytes;
    }
    // 没有 CSPRNG 就不许加密：给一个确定性来源等于把口令变成摆设
    throw new Error('浏览器没有可用的随机数源，无法加密');
}

const SECRET_ENVELOPE_HEAD = '-----ESPRIN SECRET-----';
const SECRET_ENVELOPE_TAIL = '-----END ESPRIN SECRET-----';
const SECRET_KDF = 'PBKDF2-SHA256';
const SECRET_CIPHER = 'AES-256-GCM';
// 口令派生轮数：与桌面版一致；解密时以信封里记录的值为准，日后调高不影响旧文档
const SECRET_ITERATIONS = 250000;
const SECRET_KEY_BYTES = 32;
const SECRET_SALT_BYTES = 16;
const SECRET_IV_BYTES = 12;
const SECRET_TAG_BYTES = 16;
const SECRET_PASSWORD_MIN = 4;

function isSecretEnvelope(text) {
    return typeof text === 'string' && text.startsWith(SECRET_ENVELOPE_HEAD);
}

// 解析信封：返回 { iterations, salt, iv, ct }（均为 Uint8Array），格式不认识时返回 null
function parseSecretEnvelope(text) {
    if (!isSecretEnvelope(text)) return null;
    const end = text.lastIndexOf(SECRET_ENVELOPE_TAIL);
    if (end < 0) return null;
    const body = text.slice(SECRET_ENVELOPE_HEAD.length, end).trim();
    if (!body) return null;
    try {
        const payload = JSON.parse(body);
        const iterations = Number(payload && payload.iter);
        if (!Number.isFinite(iterations) || iterations < 1000) return null;
        if (payload.cipher && payload.cipher !== SECRET_CIPHER) return null;
        if (payload.kdf && payload.kdf !== SECRET_KDF) return null;
        const salt = secretBase64ToBytes(payload.salt);
        const iv = secretBase64ToBytes(payload.iv);
        const ct = secretBase64ToBytes(payload.ct);
        // 空正文的密文也正好是一个认证标签的长度，因此这里只要求不小于标签长度
        if (salt.length < 8 || iv.length !== SECRET_IV_BYTES || ct.length < SECRET_TAG_BYTES) return null;
        return { iterations: Math.round(iterations), salt, iv, ct };
    } catch (error) {
        return null;
    }
}

function deriveSecretKey(password, salt, iterations) {
    return secretPbkdf2(secretUtf8Bytes(password), salt, iterations, SECRET_KEY_BYTES);
}

// 加密：认证标签接在密文尾部后整体 base64，与桌面版 node:crypto 的输出同构
function sealSecretContent(key, iv, plaintext, salt, iterations = SECRET_ITERATIONS) {
    const payload = {
        v: 1,
        kdf: SECRET_KDF,
        iter: iterations,
        salt: salt ? secretBytesToBase64(salt) : '',
        cipher: SECRET_CIPHER,
        iv: secretBytesToBase64(iv),
        ct: secretBytesToBase64(secretGcmSeal(key, iv, secretUtf8Bytes(plaintext)))
    };
    return `${SECRET_ENVELOPE_HEAD}\n${JSON.stringify(payload)}\n${SECRET_ENVELOPE_TAIL}`;
}

function encryptSecretContent(password, plaintext) {
    const salt = secretRandomBytes(SECRET_SALT_BYTES);
    const iv = secretRandomBytes(SECRET_IV_BYTES);
    const key = deriveSecretKey(password, salt, SECRET_ITERATIONS);
    return { envelope: sealSecretContent(key, iv, plaintext, salt), key, salt };
}

// 用口令解开信封：口令不对或密文被改动都返回 { ok: false }
function openSecretEnvelope(password, envelopeText) {
    const parsed = parseSecretEnvelope(envelopeText);
    if (!parsed) return { ok: false, error: '密文格式无法识别' };

    const key = deriveSecretKey(password, parsed.salt, parsed.iterations);
    const plaintext = secretGcmOpen(key, parsed.iv, parsed.ct);
    if (!plaintext) return { ok: false, error: '密码不正确' };
    return {
        ok: true,
        text: secretUtf8Text(plaintext),
        key,
        salt: parsed.salt,
        iterations: parsed.iterations
    };
}

/* ---------------- 会话密钥与落盘 ---------------- */

/* 已解开的条目：itemId -> { key, salt, iterations, source, envelope }。
   key 只活在这一轮会话里；source 是解开时用的明文，envelope 是它对应的密文，
   两者一起用来避免「正文没变也重新加密」——保存路径被置顶、勾选待办这类动作频繁调用，
   每次都换一个随机 IV 的话，文件内容会不停变化并推一轮同步。 */
const secretUnlocked = new Map();

function rememberSecretSession(itemId, session, source, envelope) {
    secretUnlocked.set(itemId, { ...session, source, envelope });
}

/* 落盘时使用的正文：条目带密码且本轮已解开时，按当前正文取密文；
   正文与上次落盘时相同就沿用上次那份（文件字节不变，同步队列也就不会多出一条）。
   未解开时 content 本身就是上次落下的密文，原样写回。 */
function serializeSecretBody(item) {
    const content = String((item && item.content) || '');
    if (!item || item.locked !== true) return content;
    const session = secretUnlocked.get(item.id);
    if (!session) return content;
    if (session.source === content && session.envelope) return session.envelope;
    const envelope = sealSecretContent(session.key, secretRandomBytes(SECRET_IV_BYTES), content, session.salt, session.iterations);
    session.source = content;
    session.envelope = envelope;
    return envelope;
}

/* ---------------- 状态判定 ---------------- */

// 已设置密码但本轮还没解开：正文在内存里是密文，只读
function isSecretLocked(item) {
    return !!(item && item.locked === true && item.unlocked !== true);
}

function isSecretHidden(item) {
    return !!(item && item.isHidden === true);
}

function isSecretItem(item) {
    return !!(item && (item.locked === true || item.isHidden === true));
}

function secretStateLabel(item) {
    const parts = [itemKindLabel(item)];
    if (isSecretHidden(item)) parts.push('已隐藏');
    if (item.locked === true) parts.push(item.unlocked === true ? '已加密 · 已解锁' : '已加密 · 未解锁');
    return parts.join(' · ');
}

function secretBytesEqual(left, right) {
    if (!left || !right || left.length !== right.length) return false;
    let diff = 0;
    for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
    return diff === 0;
}

/* 远端覆盖了本地文本之后保住已解锁的状态：同一口令重封的密文只换了 IV，
   会话里的密钥仍然能解开；解不开（对端换了口令）就把密钥丢掉，退回未解锁。 */
function restoreSecretSession(item) {
    if (!item) return;
    const session = secretUnlocked.get(item.id);
    if (!session) return;
    if (item.locked !== true) {
        secretUnlocked.delete(item.id);
        return;
    }

    const parsed = parseSecretEnvelope(item.content);
    if (!parsed || !secretBytesEqual(parsed.salt, session.salt)) {
        secretUnlocked.delete(item.id);
        return;
    }

    const plaintext = secretGcmOpen(session.key, parsed.iv, parsed.ct);
    if (!plaintext) {
        secretUnlocked.delete(item.id);
        return;
    }

    session.source = secretUtf8Text(plaintext);
    session.envelope = item.content;
    item.content = session.source;
    item.unlocked = true;
}

function clearSecretSession() {
    secretUnlocked.clear();
}

function forgetSecretKey(itemId) {
    secretUnlocked.delete(itemId);
}

/* ---------------- 操作 ---------------- */

/* 派生 25 万轮在纯 JS 里要跑一会儿（本机约一秒内，手机上更久），
   而它是同步计算、会占住主线程：先让状态行与提示条渲染出来，再开始算。 */
function secretYieldToPaint() {
    return new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
        else setTimeout(resolve, 0);
    });
}

async function askNewSecretPassword() {
    const password = await showPasswordPrompt('设置密码后正文将加密保存', {
        title: '设置密码',
        icon: 'lock',
        label: `密码（至少 ${SECRET_PASSWORD_MIN} 位）`,
        placeholder: '输入密码...',
        confirmLabel: '下一步',
        detail: '密码不会被保存，也无法找回：忘记密码后这篇文档的正文无法恢复。'
            + '标题、文件夹、标签与时间等元数据保持明文，正文以 AES-256-GCM 加密后落盘。'
    });
    if (password === null) return null;
    if (password.length < SECRET_PASSWORD_MIN) {
        showToast(`设置失败：密码至少 ${SECRET_PASSWORD_MIN} 位`);
        return null;
    }

    const repeat = await showPasswordPrompt('请再次输入同一密码', {
        title: '设置密码',
        icon: 'lock',
        label: '确认密码',
        placeholder: '再次输入密码...',
        confirmLabel: '设置密码'
    });
    if (repeat === null) return null;
    if (repeat !== password) {
        showToast('设置失败：两次输入的密码不一致');
        return null;
    }
    return password;
}

// 隐藏 / 取消隐藏：条目仍留在本地副本与服务端日志里，只是不再进入各处的列表
function toggleItemHidden(itemId) {
    const item = getItemById(itemId);
    if (!item) return;
    item.isHidden = !isSecretHidden(item);
    saveItem(item);
    renderApp();
    syncSecretSettingsUI();
    showToast(item.isHidden ? '已隐藏：可在「设置 → 秘密本」中找回' : '已取消隐藏');
}

async function setItemPassword(itemId) {
    const item = getItemById(itemId);
    if (!item || item.locked === true) return;

    // 正在编辑的条目可能还有没落盘的输入：先写进内存，免得把旧正文加密进去
    if (State.activeNoteId === itemId) flushPendingSave();

    const password = await askNewSecretPassword();
    if (password === null) return;

    await secretYieldToPaint();
    const sealed = encryptSecretContent(password, item.content || '');
    const plaintext = item.content || '';

    // 先按「已加密且未解锁」落盘一份密文，再把内存切回明文与已解锁状态：
    // 保存走的序列化函数只看 locked 与会话密钥，因此本地副本与同步队列里留下的永远是密文
    item.locked = true;
    item.unlocked = false;
    item.content = sealed.envelope;
    saveItem(item);

    rememberSecretSession(item.id, { key: sealed.key, salt: sealed.salt, iterations: SECRET_ITERATIONS }, plaintext, sealed.envelope);
    item.content = plaintext;
    item.unlocked = true;

    renderApp();
    syncSecretSettingsUI();
    showToast('已设置密码：正文以密文保存，关闭页面后需要重新输入密码');
}

async function unlockItem(itemId) {
    const item = getItemById(itemId);
    if (!item || !isSecretLocked(item)) return false;

    const password = await showPasswordPrompt(`输入《${itemDisplayTitle(item)}》的密码`, {
        title: '解锁文档',
        icon: 'lock_open',
        label: '密码',
        placeholder: '输入密码...',
        confirmLabel: '解锁'
    });
    if (password === null) return false;

    await secretYieldToPaint();
    const envelope = item.content;
    const opened = openSecretEnvelope(password, envelope);
    if (!opened.ok) {
        showToast(`解锁失败：${opened.error}`);
        return false;
    }

    rememberSecretSession(item.id, { key: opened.key, salt: opened.salt, iterations: opened.iterations }, opened.text, envelope);
    item.content = opened.text;
    item.unlocked = true;

    renderApp();
    syncSecretSettingsUI();
    showToast('已解锁：关闭页面或点「立即锁定」后重新上锁');
    return true;
}

// 重新上锁：按当前正文再加密一份落盘，内存里的明文与密钥一并丢弃
function lockItemNow(itemId) {
    const item = getItemById(itemId);
    if (!item || item.locked !== true) return;
    if (State.activeNoteId === itemId) flushPendingSave();

    const session = secretUnlocked.get(item.id);
    if (session) {
        item.content = sealSecretContent(
            session.key,
            secretRandomBytes(SECRET_IV_BYTES),
            item.content || '',
            session.salt,
            session.iterations
        );
    }
    item.unlocked = false;
    secretUnlocked.delete(item.id);
    saveItem(item);
    renderApp();
    syncSecretSettingsUI();
    showToast('已锁定');
}

async function removeItemPassword(itemId) {
    const item = getItemById(itemId);
    if (!item || item.locked !== true) return;
    if (State.activeNoteId === itemId) flushPendingSave();

    let plaintext = '';
    if (item.unlocked === true) {
        // 本轮已解锁：会话密钥已经证明过口令，不再问第二遍
        plaintext = item.content || '';
    } else {
        const password = await showPasswordPrompt(`解除《${itemDisplayTitle(item)}》的密码`, {
            title: '解除密码',
            icon: 'key_off',
            label: '密码',
            placeholder: '输入密码...',
            confirmLabel: '解除密码',
            detail: '验证通过后正文恢复为明文保存，该文档不再需要密码即可打开。'
        });
        if (password === null) return;

        await secretYieldToPaint();
        const opened = openSecretEnvelope(password, item.content);
        if (!opened.ok) {
            showToast(`解除失败：${opened.error}`);
            return;
        }
        plaintext = opened.text;
    }

    item.content = plaintext;
    item.locked = false;
    item.unlocked = false;
    secretUnlocked.delete(item.id);
    saveItem(item);
    renderApp();
    syncSecretSettingsUI();
    showToast('已解除密码：正文恢复为明文保存');
}

// 需要正文明文的动作（导出 Markdown 等）先走这里：未解锁时先弹密码框
async function ensureItemRevealed(itemId) {
    const item = getItemById(itemId);
    if (!item || !isSecretLocked(item)) return !!item;
    return unlockItem(itemId);
}

/* ---------------- 设置页：秘密本 ---------------- */

function secretActionButton(label, title, variant, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `settings-btn${variant ? ` ${variant}` : ''}`;
    button.textContent = label;
    if (title) button.title = title;
    button.onclick = onClick;
    return button;
}

function createSecretRow(item) {
    const row = document.createElement('div');
    row.className = 'secret-item';

    const main = document.createElement('div');
    main.className = 'secret-item-main';

    const icon = document.createElement('span');
    icon.className = 'ms-icon sm';
    icon.textContent = item.locked === true ? (item.unlocked === true ? 'lock_open' : 'lock') : 'visibility_off';

    const text = document.createElement('div');
    text.className = 'secret-item-text';

    const title = document.createElement('span');
    title.className = 'secret-item-title';
    title.textContent = itemDisplayTitle(item);

    const meta = document.createElement('span');
    meta.className = 'secret-item-meta';
    meta.textContent = `${secretStateLabel(item)} · 修改于 ${formatDate(item.updatedAt)}`;

    text.append(title, meta);
    main.append(icon, text);

    const actions = document.createElement('div');
    actions.className = 'settings-actions';

    actions.appendChild(secretActionButton('打开', '在标签页打开该文档', '', () => {
        flushPendingSave();
        openTab(item.id);
        renderApp();
    }));

    if (isSecretHidden(item)) {
        actions.appendChild(secretActionButton('取消隐藏', '重新出现在列表与搜索中', '', () => toggleItemHidden(item.id)));
    }

    if (isSecretLocked(item)) {
        actions.appendChild(secretActionButton('解锁', '输入密码后查看与编辑正文', 'primary', () => unlockItem(item.id)));
    } else if (item.locked === true) {
        actions.appendChild(secretActionButton('立即锁定', '清除内存里的明文与密钥', '', () => lockItemNow(item.id)));
    }

    actions.appendChild(item.locked === true
        ? secretActionButton('解除密码', '验证密码后改为明文保存', '', () => removeItemPassword(item.id))
        : secretActionButton('设置密码', '加密正文，打开时需要输入密码', '', () => setItemPassword(item.id)));

    row.append(main, actions);
    return row;
}

function syncSecretSettingsUI() {
    const container = document.getElementById('secret-list');
    if (!container) return;

    const items = [...State.notes, ...State.todos]
        .filter(isSecretItem)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    container.innerHTML = '';
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'secret-empty';
        empty.textContent = '暂无隐藏或已加密的文档：在列表里右键一篇笔记或待办即可设置。';
        container.appendChild(empty);
    } else {
        items.forEach((item) => container.appendChild(createSecretRow(item)));
    }

    const status = document.getElementById('secret-status');
    if (status) {
        const hidden = items.filter(isSecretHidden).length;
        const locked = items.filter((item) => item.locked === true).length;
        const opened = items.filter((item) => item.locked === true && item.unlocked === true).length;
        status.textContent = `共 ${items.length} 条：隐藏 ${hidden} 条 · 加密 ${locked} 条（本轮已解锁 ${opened} 条）`;
    }
}

/* 设置页的「秘密本」面板：面板由 settings.js 每次重建，
   这里同时负责绑定顶部那枚刷新键与列出条目 */
function bindSecretPanel() {
    const refreshBtn = document.getElementById('btn-secret-refresh');
    if (refreshBtn) {
        refreshBtn.onclick = () => {
            syncSecretSettingsUI();
            showToast('已刷新秘密本');
        };
    }
    syncSecretSettingsUI();
}

/* ---------------- 编辑器：加密条目的锁面板 ----------------
   加密且未解锁的条目：编辑区盖上锁面板，正文与统计一并让位给「输入密码」这一个动作。 */

function applySecretLockUI(item) {
    const overlay = document.getElementById('secret-lock-overlay');
    if (!overlay) return;

    const locked = isSecretLocked(item);
    overlay.classList.toggle('hidden', !locked);
    if (!locked) return;

    const title = document.getElementById('secret-lock-title');
    if (title) title.textContent = `《${itemDisplayTitle(item)}》的正文已加密`;

    const unlockBtn = document.getElementById('btn-secret-unlock');
    if (unlockBtn) unlockBtn.onclick = () => unlockItem(item.id);
}

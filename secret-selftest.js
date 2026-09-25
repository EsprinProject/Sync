#!/usr/bin/env node
/* 网页版秘密本自测：web/scripts/secret.js 的加解密与信封格式。
   信封是两端共用的契约，这里逐个用例与 node:crypto（桌面版的实现）对拆：
   本文件产出的密文交给 node 解、node 产出的密文交给本文件解，两边都必须还原出同一份正文。

   运行：node secret-selftest.js（在仓库根目录） */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');

const SECRET_JS = path.join(__dirname, 'web', 'scripts', 'secret.js');

function log(level, component, message) {
    const line = `[${level}] [${component}] ${message}`;
    if (level === 'ERROR' || level === 'WARN') console.error(line);
    else console.log(line);
}

let failed = 0;
let passed = 0;

function check(name, fn) {
    try {
        fn();
        passed += 1;
        log('INFO', 'Selftest', `用例通过: ${name}`);
    } catch (error) {
        failed += 1;
        log('ERROR', 'Selftest', `用例失败: ${name} (detail=${error.message})`);
    }
}

/* ---------------- 装载被测脚本 ----------------
   web/scripts/secret.js 是给浏览器写的经典脚本，顶层只有常量与函数声明，
   这里补一个 window 壳（取随机盐与 IV 用得到 crypto.getRandomValues）后再求值。 */

globalThis.window = globalThis.window || { crypto: globalThis.crypto };

// secret.js 里少数函数会回用到 store.js / ui.js 的助手（状态文案、时间格式），
// 本文件只测加解密与信封，这两者补一份最小实现就够
globalThis.itemKindLabel = (item) => (item && item.isTodo === true ? '待办' : '笔记');
globalThis.formatDate = (stamp) => new Date(Number(stamp) || Date.now()).toISOString();

const EXPORTS = [
    'secretSha256Bytes', 'secretPbkdf2', 'secretHmacCreate', 'secretHmacDigest',
    'secretAesExpandKey', 'secretGcmSeal', 'secretGcmOpen', 'secretAesSbox',
    'secretBytesToBase64', 'secretBase64ToBytes',
    'sealSecretContent', 'openSecretEnvelope', 'encryptSecretContent', 'parseSecretEnvelope', 'isSecretEnvelope',
    'serializeSecretBody', 'isSecretLocked', 'isSecretHidden', 'secretStateLabel',
    'SECRET_ITERATIONS', 'SECRET_ENVELOPE_HEAD', 'secretUnlocked'
];

const source = fs.readFileSync(SECRET_JS, 'utf8');
vm.runInThisContext(`${source}\nglobalThis.__secret = { ${EXPORTS.join(', ')} };`, { filename: SECRET_JS });
const S = globalThis.__secret;

/* ---------------- 桌面版的实现（node:crypto） ---------------- */

const HEAD = '-----ESPRIN SECRET-----';
const TAIL = '-----END ESPRIN SECRET-----';

function desktopDerive(password, salt, iterations) {
    return nodeCrypto.pbkdf2Sync(String(password), salt, iterations, 32, 'sha256');
}

function desktopSeal(password, plaintext, salt, iv, iterations) {
    const key = desktopDerive(password, salt, iterations);
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const payload = {
        v: 1,
        kdf: 'PBKDF2-SHA256',
        iter: iterations,
        salt: salt.toString('base64'),
        cipher: 'AES-256-GCM',
        iv: iv.toString('base64'),
        ct: Buffer.concat([data, cipher.getAuthTag()]).toString('base64')
    };
    return `${HEAD}\n${JSON.stringify(payload)}\n${TAIL}`;
}

function desktopOpen(password, envelope) {
    const body = envelope.slice(HEAD.length, envelope.lastIndexOf(TAIL)).trim();
    const payload = JSON.parse(body);
    const key = desktopDerive(password, Buffer.from(payload.salt, 'base64'), payload.iter);
    const raw = Buffer.from(payload.ct, 'base64');
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8');
}

/* ---------------- 摘要与派生 ---------------- */

log('INFO', 'Selftest', 'section=sha256-and-pbkdf2');

check('SHA-256 与 node:crypto 一致', () => {
    const samples = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000),
        '秘密本：口令与密文都留在这里', 'x'.repeat(300000)];
    samples.forEach((sample) => {
        const expected = nodeCrypto.createHash('sha256').update(sample, 'utf8').digest('hex');
        const actual = Buffer.from(S.secretSha256Bytes(new TextEncoder().encode(sample))).toString('hex');
        assert.strictEqual(actual, expected, `输入长度 ${sample.length} 的摘要不符`);
    });
});

check('S 盒按定义生成正确', () => {
    const expected = [0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76];
    expected.forEach((value, index) => assert.strictEqual(S.secretAesSbox[index], value, `S 盒第 ${index} 项不符`));
    assert.strictEqual(S.secretAesSbox[255], 0x16);
});

check('PBKDF2-HMAC-SHA256 与 node:crypto 一致', () => {
    [[1, 16], [2, 16], [1000, 16], [4096, 24]].forEach(([iterations, saltLength]) => {
        const password = 'esprin-口令-2026';
        const salt = nodeCrypto.randomBytes(saltLength);
        const expected = desktopDerive(password, salt, iterations).toString('hex');
        const actual = Buffer.from(S.secretPbkdf2(new TextEncoder().encode(password), salt, iterations, 32)).toString('hex');
        assert.strictEqual(actual, expected, `轮数 ${iterations} 的派生密钥不符`);
    });
});

/* ---------------- AES-256-GCM ---------------- */

log('INFO', 'Selftest', 'section=aes-gcm');

check('AES-256-GCM 与 node:crypto 双向一致', () => {
    const lengths = [0, 1, 15, 16, 17, 31, 32, 33, 128, 1024];
    lengths.forEach((length) => {
        const key = nodeCrypto.randomBytes(32);
        const iv = nodeCrypto.randomBytes(12);
        const plaintext = Buffer.from('中文段落与 ascii 混合 '.repeat(80), 'utf8').subarray(0, length);

        // 本文件加密 → node 解密
        const sealed = Buffer.from(S.secretGcmSeal(key, iv, plaintext));
        const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(sealed.subarray(sealed.length - 16));
        const opened = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
        assert.ok(opened.equals(plaintext), `长度 ${length} 的密文在 node 侧解不出原文`);

        // node 加密 → 本文件解密
        const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
        const produced = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
        const back = S.secretGcmOpen(key, iv, new Uint8Array(produced));
        assert.ok(back && Buffer.from(back).equals(plaintext), `长度 ${length} 的密文在本文件里解不出原文`);
    });
});

check('认证标签对不上时拒绝解密', () => {
    const key = nodeCrypto.randomBytes(32);
    const iv = nodeCrypto.randomBytes(12);
    const sealed = S.secretGcmSeal(key, iv, new TextEncoder().encode('正文'));

    const tamperedTag = sealed.slice();
    tamperedTag[tamperedTag.length - 1] ^= 0x01;
    assert.strictEqual(S.secretGcmOpen(key, iv, tamperedTag), null, '标签被改动时仍解出了内容');

    const tamperedData = sealed.slice();
    tamperedData[0] ^= 0x80;
    assert.strictEqual(S.secretGcmOpen(key, iv, tamperedData), null, '密文被改动时仍解出了内容');

    assert.strictEqual(S.secretGcmOpen(nodeCrypto.randomBytes(32), iv, sealed), null, '换一把密钥仍解出了内容');
});

/* ---------------- 信封（两端契约） ---------------- */

log('INFO', 'Selftest', 'section=envelope');

const TEST_ITERATIONS = 4096;
const TEST_SALT = nodeCrypto.randomBytes(16);

check('本文件产出的信封能被桌面版实现解开', () => {
    ['', '短正文', '多行\n正文\n\n带 中文 与 ascii'].forEach((plaintext) => {
        const envelope = S.sealSecretContent(desktopDerive('口令-abc', TEST_SALT, TEST_ITERATIONS), nodeCrypto.randomBytes(12),
            plaintext, TEST_SALT, TEST_ITERATIONS);
        assert.strictEqual(desktopOpen('口令-abc', envelope), plaintext, '桌面版解出的正文不符');
    });
});

check('桌面版产出的信封能被本文件解开', () => {
    ['', '短正文', '多行\n正文\n\n带 中文 与 ascii'].forEach((plaintext) => {
        const envelope = desktopSeal('口令-abc', plaintext, TEST_SALT, nodeCrypto.randomBytes(12), TEST_ITERATIONS);
        const opened = S.openSecretEnvelope('口令-abc', envelope);
        assert.strictEqual(opened.ok, true, `解不开：${opened.error}`);
        assert.strictEqual(opened.text, plaintext, '解出的正文不符');
        assert.strictEqual(opened.iterations, TEST_ITERATIONS, '信封里的轮数没有带回来');
    });
});

check('口令不对或信封被改动时报失败', () => {
    const envelope = desktopSeal('口令-abc', '机密正文', TEST_SALT, nodeCrypto.randomBytes(12), TEST_ITERATIONS);
    assert.deepStrictEqual(S.openSecretEnvelope('口令-abd', envelope), { ok: false, error: '密码不正确' });

    const tampered = envelope.replace(/"ct":".{8}/, '"ct":"AAAAAAAA');
    assert.strictEqual(S.openSecretEnvelope('口令-abc', tampered).ok, false, '密文被改动仍解开了');

    assert.strictEqual(S.openSecretEnvelope('口令-abc', '这不是信封').ok, false, '非信封文本被当成信封处理');
    assert.strictEqual(S.parseSecretEnvelope(`${HEAD}\n{"iter":10}\n${TAIL}`), null, '轮数低于下限仍被接受');
});

check('encryptSecretContent 产出的信封能自解且盐为 16 字节', () => {
    const sealed = S.encryptSecretContent('口令-xyz', '正文内容');
    const opened = S.openSecretEnvelope('口令-xyz', sealed.envelope);
    assert.strictEqual(opened.ok, true, `解不开：${opened.error}`);
    assert.strictEqual(opened.text, '正文内容');
    assert.strictEqual(sealed.salt.length, 16);
    assert.ok(Buffer.from(sealed.key).equals(Buffer.from(opened.key)), '两次派生的密钥不一致');
});

check('base64 编解码往返无损', () => {
    [0, 1, 2, 3, 16, 17, 4096].forEach((length) => {
        const bytes = nodeCrypto.randomBytes(length);
        const roundTrip = Buffer.from(S.secretBase64ToBytes(S.secretBytesToBase64(bytes)));
        assert.ok(roundTrip.equals(bytes), `长度 ${length} 的往返结果不符`);
        assert.strictEqual(S.secretBytesToBase64(bytes), bytes.toString('base64'), `长度 ${length} 的编码与 node 不一致`);
    });
});

/* ---------------- 落盘正文 ---------------- */

log('INFO', 'Selftest', 'section=serialize');

check('已解锁条目的落盘正文是密文，正文未变时不重新加密', () => {
    // 会话里的轮数必须与其密钥一致（这里直接用加密时实际用的轮数），
    // 否则重新加密会用一把错密钥封装，桌面版收到后就解不开了
    const sealed = S.encryptSecretContent('口令-abc', '第一版正文');
    const session = { key: sealed.key, salt: sealed.salt, iterations: S.SECRET_ITERATIONS };
    S.secretUnlocked.set('itemCache', { ...session, source: '第一版正文', envelope: sealed.envelope });

    const item = { id: 'itemCache', locked: true, unlocked: true, content: '第一版正文' };
    const first = S.serializeSecretBody(item);
    assert.strictEqual(first, sealed.envelope, '正文未变时应当沿用上次那份密文');
    assert.ok(S.openSecretEnvelope('口令-abc', first).text === '第一版正文');

    item.content = '第二版正文';
    const second = S.serializeSecretBody(item);
    assert.notStrictEqual(second, first, '正文变了应当重新加密');
    assert.strictEqual(desktopOpen('口令-abc', second), '第二版正文', '重加密后桌面版应能解开');

    // 再调一次：正文没变，应当稳定复用第二份密文（否则每次保存都会推一轮同步）
    assert.strictEqual(S.serializeSecretBody(item), second);
    S.secretUnlocked.clear();
});

check('未解锁的条目按原样写回密文，明文条目不动', () => {
    const envelope = desktopSeal('口令-abc', '机密', TEST_SALT, nodeCrypto.randomBytes(12), TEST_ITERATIONS);
    assert.strictEqual(S.serializeSecretBody({ id: 'x', locked: true, unlocked: false, content: envelope }), envelope);
    assert.strictEqual(S.serializeSecretBody({ id: 'y', content: '普通正文' }), '普通正文');
    assert.strictEqual(S.isSecretLocked({ locked: true, unlocked: false }), true);
    assert.strictEqual(S.isSecretLocked({ locked: true, unlocked: true }), false);
    assert.strictEqual(S.isSecretHidden({ isHidden: true }), true);
    assert.strictEqual(S.secretStateLabel({ locked: true, unlocked: false, isHidden: true }), '笔记 · 已隐藏 · 已加密 · 未解锁');
});

/* ---------------- 经典脚本的命名空间 ----------------
   web/scripts/*.js 共享同一个全局作用域：顶层 const / let / class 重名会让「后载入的那一份」
   整份脚本解析失败（node --check 查不出来，它按单文件解析）。加脚本之后顺手扫一遍。 */

log('INFO', 'Selftest', 'section=namespace');

check('各脚本的顶层声明不重名', () => {
    const dir = path.join(__dirname, 'web', 'scripts');
    const declaration = /^(?:const|let|class|function|async function)\s+([A-Za-z_$][\w$]*)/;
    const owners = new Map();
    fs.readdirSync(dir).filter((name) => name.endsWith('.js')).sort().forEach((name) => {
        fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/).forEach((line) => {
            const matched = line.match(declaration);
            if (!matched) return;
            const symbol = matched[1];
            if (!owners.has(symbol)) owners.set(symbol, []);
            owners.get(symbol).push(name);
        });
    });
    const clashes = [...owners.entries()]
        .filter(([, files]) => files.length > 1)
        .map(([symbol, files]) => `${symbol}(${files.join(', ')})`);
    assert.deepStrictEqual(clashes, [], `顶层声明重名：${clashes.join('；')}`);
});

/* ---------------- 真实轮数的耗时 ---------------- */

log('INFO', 'Selftest', 'section=timing');

check('25 万轮派生在可接受范围内完成', () => {
    const started = Date.now();
    const key = S.secretPbkdf2(new TextEncoder().encode('口令-abc'), TEST_SALT, S.SECRET_ITERATIONS, 32);
    const elapsed = Date.now() - started;
    assert.strictEqual(key.length, 32);
    assert.ok(elapsed < 8000, `派生耗时 ${elapsed}ms，超过 8 秒`);
    log('INFO', 'Selftest', `25 万轮 PBKDF2 耗时 ${elapsed}ms`);
});

log('INFO', 'Selftest', `section=summary passed=${passed} failed=${failed}`);
process.exitCode = failed ? 1 : 0;

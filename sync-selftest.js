#!/usr/bin/env node
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function findSyncModule() {
  const candidates = [
    path.join(__dirname, '..', 'src', 'main', 'sync_server.js'),
    path.join(__dirname, '..', 'main', 'sync_server.js')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 src/main/sync_server.js，请在项目根目录运行本脚本');
}

const sync = require(findSyncModule());

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

log('INFO', 'Selftest', 'section=path-hash');
check('越界与空路径被拒绝', () => {
  assert.strictEqual(sync.normalizeRelative('../evil.md'), '');
  assert.strictEqual(sync.normalizeRelative('/abs.md'), '');
  assert.strictEqual(sync.normalizeRelative('notes/../x.md'), '');
  assert.strictEqual(sync.normalizeRelative(''), '');
});
check('反斜杠归一成正斜杠', () => {
  assert.strictEqual(sync.normalizeRelative('notes\\sub\\a.md'), 'notes/sub/a.md');
});
check('哈希基于字节', () => {
  assert.strictEqual(sync.hashBytes(Buffer.from('abc')), sync.hashBytes(Buffer.from('abc')));
  assert.notStrictEqual(sync.hashBytes(Buffer.from('abc')), sync.hashBytes(Buffer.from('abd')));
});

log('INFO', 'Selftest', 'section=decide-apply');
check('远端删除 + 本地没有该文件 → 什么都不做（不会凭空写回）', () => {
  assert.strictEqual(sync.decideApply({ op: 'del', path: 'notes/a.md' }, { localExists: false }), 'skip');
});
check('远端删除 + 本地还有该文件 → 删掉它', () => {
  assert.strictEqual(sync.decideApply({ op: 'del', path: 'notes/a.md' }, { localExists: true }), 'apply');
});
check('远端写入 + 内容一致 → 跳过写盘', () => {
  assert.strictEqual(sync.decideApply({ op: 'put', hash: 'h1' }, { localExists: true, localHash: 'h1' }), 'skip');
});
check('远端写入 + 内容不同 → 写入', () => {
  assert.strictEqual(sync.decideApply({ op: 'put', hash: 'h1' }, { localExists: true, localHash: 'h2' }), 'apply');
});
check('本地有更晚的未推送改动 → 保留本地', () => {
  assert.strictEqual(
    sync.decideApply({ op: 'put', hash: 'h1', time: 100 }, { localNewerPending: true, localExists: true, localHash: 'h2' }),
    'keep-local'
  );
});

log('INFO', 'Selftest', 'section=outbox');
check('同一路径的连续改动合并成一条', () => {
  let list = [];
  list = sync.mergeOutboxOp(list, { opId: '1', path: 'notes/a.md', op: 'put', time: 1 });
  list = sync.mergeOutboxOp(list, { opId: '2', path: 'notes/a.md', op: 'put', time: 2 });
  list = sync.mergeOutboxOp(list, { opId: '3', path: 'notes/a.md', op: 'del', time: 3 });
  list = sync.mergeOutboxOp(list, { opId: '4', path: 'notes/b.md', op: 'put', time: 4 });
  assert.deepStrictEqual(list.map((op) => op.opId), ['3', '4']);
});

log('INFO', 'Selftest', 'section=journal-file');
check('逐行解析日志：合法行留下，坏行只计数', () => {
  const parsed = sync.parseJournalText([
    '{"seq":1,"op":"put","path":"notes/a.md","data":"第一篇","device":"dev-a"}',
    '',
    'not json',
    '{"seq":2,"op":"del","path":"notes/a.md","device":"dev-b"}',
    '{"seq":3,"op":"put","path":"../evil.md","data":"x"}',
    '{"seq":4,"op":"put","path":"notes/b.md"}',
    '{"seq":5,"op":"rename","path":"notes/c.md"}'
  ].join('\n'));
  assert.strictEqual(parsed.entries.length, 2);
  assert.strictEqual(parsed.invalid, 4);
  assert.strictEqual(parsed.latestSeq, 2);
  assert.deepStrictEqual(parsed.devices, ['dev-a', 'dev-b']);
});
check('没有序号的日志按文件顺序重放', () => {
  const entries = [{ op: 'put', path: 'notes/a.md' }, { op: 'del', path: 'notes/a.md' }];
  assert.deepStrictEqual(sync.orderJournalEntries(entries), entries);
});
check('都带序号时按序号重排', () => {
  const ordered = sync.orderJournalEntries([
    { seq: 3, op: 'put', path: 'notes/c.md' },
    { seq: 1, op: 'put', path: 'notes/a.md' },
    { seq: 2, op: 'del', path: 'notes/a.md' }
  ]);
  assert.deepStrictEqual(ordered.map((entry) => entry.seq), [1, 2, 3]);
});
check('最终状态：删除过的路径不留下，后写的内容覆盖先前', () => {
  const final = sync.journalFinalState([
    { seq: 1, op: 'put', path: 'notes/a.md', data: '第一版' },
    { seq: 2, op: 'put', path: 'notes/b.md', data: '第二篇' },
    { seq: 3, op: 'del', path: 'notes/b.md' },
    { seq: 4, op: 'put', path: 'notes/a.md', data: '第二版' }
  ]);
  assert.deepStrictEqual([...final.keys()], ['notes/a.md']);
  assert.strictEqual(final.get('notes/a.md').data, '第二版');
});
check('重放：写入、删除，以及在本地不存在时的跳过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esprin-journal-'));
  try {
    const applied = sync.applyJournalEntries([
      { op: 'put', path: 'notes/a.md', data: '第一篇', encoding: 'utf8' },
      { op: 'put', path: 'notes/sub/b.md', data: '第二篇', encoding: 'utf8' },
      { op: 'del', path: 'notes/sub/b.md' },
      { op: 'del', path: 'notes/gone.md' }
    ], dir);
    assert.strictEqual(applied.written, 2);
    assert.strictEqual(applied.deleted, 1);
    assert.strictEqual(applied.skipped, 1);
    assert.deepStrictEqual(applied.errors, []);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'notes', 'a.md'), 'utf8'), '第一篇');
    assert.ok(!fs.existsSync(path.join(dir, 'notes', 'sub', 'b.md')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
check('导出目标不允许落在数据目录内', () => {
  const dataDir = path.join(__dirname, 'tmp-data');
  assert.strictEqual(sync.isSameOrInside(dataDir, dataDir), true);
  assert.strictEqual(sync.isSameOrInside(path.join(dataDir, 'notes'), dataDir), true);
  assert.strictEqual(sync.isSameOrInside(path.join(dataDir, '..', 'out'), dataDir), false);
  assert.strictEqual(sync.isSameOrInside(path.join(dataDir, '..', 'tmp-data-2'), dataDir), false);
});

function createServer() {
  const log = [];
  const files = new Map();
  const deleted = new Set();
  return {
    log,
    files,
    deleted,
    push(device, ops) {
      return ops.map((op) => {
        const seq = log.length + 1;
        const entry = { ...op, seq, device };
        log.push(entry);
        if (op.op === 'del') {
          files.delete(op.path);
          deleted.add(op.path);
        } else {
          files.set(op.path, op.hash);
          deleted.delete(op.path);
        }
        return { opId: op.opId, seq };
      });
    },
    since(seq) {
      return log.filter((op) => op.seq > seq);
    }
  };
}

function createDevice(name) {
  return { name, lastSeq: 0, outbox: [], disk: new Map() };
}

function localPut(dev, filePath, content, time) {
  dev.disk.set(filePath, sync.hashBytes(Buffer.from(content)));
  dev.outbox = sync.mergeOutboxOp(dev.outbox, {
    opId: `${dev.name}-${time}`,
    op: 'put',
    path: filePath,
    time,
    hash: sync.hashBytes(Buffer.from(content)),
    data: content,
    encoding: 'utf8'
  });
}

function localDel(dev, filePath, time) {
  dev.disk.delete(filePath);
  dev.outbox = sync.mergeOutboxOp(dev.outbox, {
    opId: `${dev.name}-${time}`,
    op: 'del',
    path: filePath,
    time
  });
}

function syncOnce(dev, server) {
  for (const op of server.since(dev.lastSeq)) {
    const pending = dev.outbox.find((item) => item.path === op.path) || null;
    const decision = sync.decideApply(op, {
      localNewerPending: !!pending && (pending.time || 0) > (op.time || 0),
      localExists: dev.disk.has(op.path),
      localHash: dev.disk.get(op.path) || '',
      opHash: op.hash || ''
    });

    if (decision === 'apply') {
      if (op.op === 'del') dev.disk.delete(op.path);
      else dev.disk.set(op.path, op.hash);
      dev.outbox = dev.outbox.filter((item) => item.path !== op.path);
    }
    dev.lastSeq = Math.max(dev.lastSeq, op.seq);
  }

  if (dev.outbox.length) {
    server.push(dev.name, dev.outbox);
    dev.outbox = [];
  }
}

log('INFO', 'Selftest', 'section=two-devices');

check('A 新建笔记 → B 同步后拿到', () => {
  const server = createServer();
  const a = createDevice('dev-a');
  const b = createDevice('dev-b');

  localPut(a, 'notes/a.md', '第一篇', 1000);
  syncOnce(a, server);
  syncOnce(b, server);
  assert.strictEqual(b.disk.get('notes/a.md'), sync.hashBytes(Buffer.from('第一篇')));
});

check('A 删除笔记 → B 同步后本地被删，且不会产生补写操作', () => {
  const server = createServer();
  const a = createDevice('dev-a');
  const b = createDevice('dev-b');

  localPut(a, 'notes/a.md', '第一篇', 1000);
  syncOnce(a, server);
  syncOnce(b, server);

  localDel(a, 'notes/a.md', 2000);
  syncOnce(a, server);
  syncOnce(b, server);

  assert.ok(!b.disk.has('notes/a.md'), 'B 本地应当已删除');
  assert.deepStrictEqual(b.outbox, [], 'B 不应产生任何“把它补回来”的操作');
  assert.ok(server.deleted.has('notes/a.md'), '服务端应保留删除记录');
});

check('B 再同步一次也不会把笔记复活', () => {
  const server = createServer();
  const a = createDevice('dev-a');
  const b = createDevice('dev-b');

  localPut(a, 'notes/a.md', '第一篇', 1000);
  syncOnce(a, server);
  syncOnce(b, server);
  localDel(a, 'notes/a.md', 2000);
  syncOnce(a, server);
  syncOnce(b, server);

  syncOnce(b, server);
  syncOnce(b, server);
  assert.ok(!b.disk.has('notes/a.md'));
  assert.deepStrictEqual(b.outbox, []);
  assert.strictEqual(b.lastSeq, server.log.length);
});

check('B 在删除之后又改了那篇笔记（更晚）→ 保留 B 的版本并推上去', () => {
  const server = createServer();
  const a = createDevice('dev-a');
  const b = createDevice('dev-b');

  localPut(a, 'notes/a.md', '第一篇', 1000);
  syncOnce(a, server);
  syncOnce(b, server);

  localDel(a, 'notes/a.md', 2000);
  syncOnce(a, server);

  localPut(b, 'notes/a.md', 'B 的新内容', 3000);
  syncOnce(b, server);

  assert.strictEqual(b.disk.get('notes/a.md'), sync.hashBytes(Buffer.from('B 的新内容')));
  assert.ok(server.files.has('notes/a.md'), 'B 的版本应当被推上去');

  syncOnce(a, server);
  assert.strictEqual(a.disk.get('notes/a.md'), sync.hashBytes(Buffer.from('B 的新内容')));
});

check('远端更新的内容会覆盖本地没有再改过的文件', () => {
  const server = createServer();
  const a = createDevice('dev-a');
  const b = createDevice('dev-b');

  localPut(a, 'notes/a.md', '第一版', 1000);
  syncOnce(a, server);
  syncOnce(b, server);

  localPut(a, 'notes/a.md', '第二版', 2000);
  syncOnce(a, server);
  syncOnce(b, server);

  assert.strictEqual(b.disk.get('notes/a.md'), sync.hashBytes(Buffer.from('第二版')));
});

if (failed) {
  log('ERROR', 'Selftest', `failed=${failed} passed=${passed}`);
  process.exit(1);
}
log('INFO', 'Selftest', `passed=${passed} failed=0`);

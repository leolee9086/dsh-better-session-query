import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openMemoryStore, MEMORY_TOOL } from "../lib/memory.js";
const block = (id, args, time = 1000) => ({ id, type: "tool-call", seq: 1, time, surface: "log-only", text: MEMORY_TOOL + " " + JSON.stringify(args) });

test("变更与正文同事务、幂等、删除墓碑及重启游标", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-memory-sync-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "memory.sqlite");
  let store = await openMemoryStore({ path });
  const blocks = [block("b1", { q: "hello", a: "world" }), block("b2", { q: "keep", a: "me" })];
  try {
    store.ingest({ sessionId: "s", blocks });
    const identity = store.identity();
    const hash = store.get("b1").contentHash;
    assert.equal(identity.revision, 2);
    store.ingest({ sessionId: "s", blocks });
    assert.equal(store.identity().revision, identity.revision, "重复索引不重复排向量任务");
    // 已删b2再写非法数据会失败；整轮应回滚，包括删除和触发器产生的墓碑。
    assert.throws(() => store.ingest({ sessionId: "s", blocks: [{ ...blocks[0], time: NaN }] }));
    assert.equal(store.stats().memories, 2);
    assert.equal(store.identity().revision, 2);
    store.ingest({ sessionId: "s", blocks: [block("b1", { q: "hello", a: "new" })] });
    assert.notEqual(store.get("b1").contentHash, hash);
    assert.equal(store.get("b2"), undefined);
    assert.deepEqual(store.changes({ after: 2 }).map(({ blockId, deleted }) => ({ blockId, deleted })), [
      { blockId: "b2", deleted: true }, { blockId: "b1", deleted: false },
    ]);
    const checkpoint = store.identity();
    store.close();
    store = await openMemoryStore({ path });
    assert.deepEqual(store.identity(), checkpoint);
    assert.equal(store.hasSession("s"), true);
    store.deleteSession("s");
    assert.equal(store.hasSession("s"), false);
    assert.equal(store.stats().memories, 0);
    assert.equal(store.changes({ after: checkpoint.revision })[0].deleted, true);
  } finally { store.close(); }
});

test("v2库原地迁移、不丢记忆，自动建立回填记录", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-memory-migration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "old.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`PRAGMA application_id = 1296387377; PRAGMA user_version = 2;
    CREATE TABLE memory(id INTEGER PRIMARY KEY, block_id TEXT UNIQUE NOT NULL, session_id TEXT NOT NULL,
      cwd TEXT, seq INTEGER NOT NULL, time INTEGER NOT NULL, surface TEXT, q TEXT NOT NULL, a TEXT NOT NULL,
      tag TEXT, expires TEXT, perspective TEXT, qa TEXT NOT NULL);
    CREATE VIRTUAL TABLE memory_fts USING fts5(qa, tokenize='unicode61');
    INSERT INTO memory VALUES(1, 'legacy', 's', NULL, 1, 1000, 'log-only', 'hello', 'world', NULL, NULL, 'ego', 'hello world');
    INSERT INTO memory_fts(rowid, qa) VALUES(1, 'hello world');`);
  old.close();
  const store = await openMemoryStore({ path });
  try {
    assert.equal(store.stats().memories, 1);
    assert.equal(store.recall({ keywords: ["hello"] }).items[0].a, "world");
    assert.match(store.get("legacy").contentHash, /^[a-f0-9]{64}$/);
    assert.equal(store.changes()[0].blockId, "legacy");
    assert.equal(store.scan({ limit: 1 })[0].blockId, "legacy");
    assert.equal(store.scan({ after: "legacy" }).length, 0);
  } finally { store.close(); }
});

test("过滤先于候选截断，新鲜分层和附件内容hash", async () => {
  const store = await openMemoryStore();
  try {
    const noise = Array.from({ length: 100 }, (_, i) => block("n" + i, { q: "苹果", a: "苹果", tag: "noise" }, 100));
    const wanted = block("wanted", { q: "苹果水果", a: "现在可以买", tag: "wanted", attachments: [{ type: "image", path: "D:/photo.png", sha256: "a".repeat(64) }] }, 9999);
    store.ingest({ sessionId: "s", blocks: [...noise, wanted] });
    assert.equal(store.recall({ keywords: ["苹果"], tag: "wanted", now: 10000, ttlMs: 10, limit: 1 }).items[0].blockId, "wanted");
    assert.equal(store.recall({ keywords: ["苹果"], now: 10000, ttlMs: 10, limit: 1 }).items[0].blockId, "wanted");
    const before = store.get("wanted");
    assert.equal(before.attachments.length, 1);
    const args = { q: before.q, a: before.a, tag: before.tag, attachments: [{ ...before.attachments[0], sha256: "b".repeat(64) }] };
    store.ingest({ sessionId: "s", blocks: [block("wanted", args, 9999)] });
    assert.notEqual(store.get("wanted").contentHash, before.contentHash);
  } finally { store.close(); }
});

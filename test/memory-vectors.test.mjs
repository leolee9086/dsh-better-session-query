import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryStore, MEMORY_TOOL } from "../lib/memory.js";
import { openMemoryVectors } from "../lib/memory-vectors.js";
import { openTestVectorStore } from "./helpers/vector-store.ts";

function source(id = "local-text", revision = "one", dimension = 2) {
  return { id, spaceId: id + "-" + revision, field: "v_" + id.replaceAll("-", "_") + "_" + revision,
    dimension, local: id.startsWith("local"), modalities: ["text"], queryable: true, weight: 1 };
}
function provider(sources = [source(), source("remote", "one", 3)]) {
  const counts = new Map();
  const api = {
    failing: new Set(), calls: counts, list: () => sources,
    async embed(id, { inputs, task }) {
      const key = id + ":" + task;
      counts.set(key, (counts.get(key) ?? 0) + inputs.length);
      if (api.failing.has(id)) throw new Error("模拟来源掉线");
      const descriptor = sources.find((entry) => entry.id === id);
      return { spaceId: descriptor.spaceId, vectors: inputs.map((input) => {
        const text = input.text ?? "";
        const vector = Array(descriptor.dimension).fill(0);
        if (/database|锁|数据/.test(text)) vector[0] = 1; else vector[1] = 1;
        return Float32Array.from(vector);
      }) };
    },
  };
  return api;
}
function block(id, q, a, time = Date.now()) {
  return { id, seq: 1, time, surface: "log-only", type: "tool-call", text: MEMORY_TOOL + " " + JSON.stringify({ q, a }) };
}
async function setup(t, embeddings = provider()) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-memory-vector-"));
  const memory = await openMemoryStore({ path: join(dir, "memory.sqlite") });
  let vectors = await openTestVectorStore(join(dir, "vectors"));
  let sync;
  t.after(async () => { await sync?.close(); await vectors.close(); memory.close(); await rm(dir, { recursive: true, force: true }); });
  const reopen = async (next = embeddings, restartVectorStore = false) => {
    await sync?.close();
    if (restartVectorStore) { await vectors.close(); vectors = await openTestVectorStore(join(dir, "vectors")); }
    sync = await openMemoryVectors({ memory, embeddings: next, vectorStore: vectors, path: join(dir, "sync.sqlite"), options: { retryBaseMs: 100000 } });
    return sync;
  };
  return { memory, embeddings, reopen, vectors: () => vectors };
}

test("真实Dataset：多来源字段保留、语义查找、改删立即屏蔽旧向量及重启恢复", async (t) => {
  const env = await setup(t);
  env.memory.ingest({ sessionId: "s", blocks: [block("lock", "数据库锁", "另一个进程占用"), block("fruit", "苹果", "水果")] });
  let sync = await env.reopen();
  const state = await sync.drain();
  assert.equal(state.pending, 0);
  assert.equal(state.entities, 2);
  assert.ok(state.coverage.every((item) => item.indexed === 2));
  const hit = await sync.search({ query: "database", limit: 1 });
  assert.equal(hit.items[0].blockId, "lock");
  assert.equal(hit.items[0].vectorSources.length, 2, "后补远端不能丢掉本地字段");
  const calls = env.embeddings.calls.get("local-text:document");
  sync = await env.reopen(env.embeddings, true);
  await sync.drain();
  assert.equal(env.embeddings.calls.get("local-text:document"), calls, "重启复用持久缓存");
  assert.equal((await sync.search({ query: "database", limit: 1 })).items[0].blockId, "lock");
  env.memory.ingest({ sessionId: "s", blocks: [block("lock", "改成无关", "橘子")] });
  assert.equal((await sync.search({ query: "database" })).items.length, 0, "同步前就拒绝hash变更和已删除命中");
  await sync.drain();
  assert.equal((await sync.search({ query: "水果" })).items[0].a, "橘子");
  env.memory.deleteSession("s");
  assert.equal((await sync.search({ query: "水果" })).items.length, 0);
  await sync.drain();
  assert.equal(sync.status().entities, 0);
});

test("远端失效本地仍可用，持久失败任务重启后重试，不重算已成功本地", async (t) => {
  const env = await setup(t);
  env.embeddings.failing.add("remote");
  env.memory.ingest({ sessionId: "s", blocks: [block("a", "数据库", "锁")] });
  let sync = await env.reopen();
  const state = await sync.drain();
  assert.equal(state.pending, 1);
  assert.equal(state.coverage.find((item) => item.sourceId === "local-text").indexed, 1);
  const hit = await sync.search({ query: "database" });
  assert.equal(hit.items[0].blockId, "a");
  assert.ok(hit.failures.some((item) => item.sourceId === "remote"));
  env.embeddings.failing.clear();
  sync = await env.reopen();
  assert.equal(sync.status().pending, 1);
  sync.retry();
  assert.equal((await sync.drain()).pending, 0);
  assert.equal(env.embeddings.calls.get("local-text:document"), 1);
  assert.equal((await sync.search({ query: "database" })).items[0].vectorSources.length, 2);
});

test("模型换代复用兼容缓存，迁移未就绪时能查旧代兼容字段", async (t) => {
  const first = provider([source()]);
  const env = await setup(t, first);
  env.memory.ingest({ sessionId: "s", blocks: [block("a", "数据库", "锁")] });
  let sync = await env.reopen();
  const old = await sync.drain();
  const next = provider([source(), source("remote", "two", 3)]);
  sync = await env.reopen(next);
  assert.notEqual(sync.status().generation, old.generation);
  assert.equal((await sync.search({ query: "database" })).items[0].blockId, "a");
  await sync.drain();
  assert.equal(next.calls.get("local-text:document"), undefined, "兼容空间无需重新嵌入");
  assert.equal(next.calls.get("remote:document"), 1);
  assert.equal((await sync.search({ query: "database" })).items[0].vectorSources.length, 2);
});

// 三包真实组合的冒烟验收：真侧车 + 真本地模型（禁网）+ 真SQLite。不 mock 任何东西。
//
// **它不是召回率基准，也不是阈值标定依据。**
// 这里的“正确答案”是下面手写的期望断言：出题和判卷是同一方，样本是 3 条自造记忆与 4 个查询，
// 算不出任何召回率；拿它上面读到的余弦去定阈值更是循环论证。
// 它只能回答三件事：链路通不通、排序方向对不对、明显不相关的东西会不会冒头。
// 真正的召回率需要独立标注（哪些记忆对某条查询算相关，由使用者而非本脚本判定）、
// 真实分布的语料（长文本/代码/中英混排/专有名词，不是编出来的短句）、
// 以及调参集与评估集分开。在那之前，阈值只能当作可配置的保守默认值，不是“正确值”。
//
// 跑法（在 dsh-better-session-query 目录下）：node scripts/acceptance-vector-memory.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openMemoryStore, MEMORY_TOOL } from "../lib/memory.js";
import { openMemoryVectors } from "../lib/memory-vectors.js";
import { hybridRecall } from "../lib/hybrid-recall.js";
// 跨包引真实实现：模型侧与向量库侧都是宿主共享服务，这里当进程内消费者用。
import { createEmbeddingService } from "../../dsh-embeddings/src/service.js";
import { createVectorStore } from "../../dsh-vectordb/src/host.js";

const photoURL = new URL("../../dsh-embeddings/test/fixtures/cats.png", import.meta.url);
const photoBytes = await readFile(photoURL);
const photoSha = createHash("sha256").update(photoBytes).digest("hex");

const evidence = [];
const record = (name, detail) => {
  evidence.push({ name, detail });
  console.log("· " + name + " → " + JSON.stringify(detail));
};
const block = (id, args, time = Date.now()) => ({
  id, seq: 1, time, surface: "log-only", type: "tool-call",
  text: MEMORY_TOOL + " " + JSON.stringify(args),
});
const fakeCtx = () => ({ logger: { info() {}, warn() {} }, get: () => undefined, provide() {}, effect() {} });
const requestsOf = (status, id) => status.sources.find((s) => s.id === id)?.requests ?? 0;

const dir = await mkdtemp(join(tmpdir(), "dsh-vector-acceptance-"));
const paths = {
  memory: join(dir, "memory.sqlite"),
  sync: join(dir, "sync.sqlite"),
  vectors: join(dir, "vectors"),
};
let memory;
let embeddings;
let vectors;
let sync;
let closed = false;
try {
  // ── 1. 真实组件上线 ─────────────────────────────────────────────────
  embeddings = createEmbeddingService({ local: { offlineVerify: true } });
  const listed = embeddings.list().map((s) => ({ id: s.id, dimension: s.dimension, local: s.local }));
  record("嵌入来源", listed);
  assert.equal(listed.filter((s) => s.local).length, 2, "本地兜底应当始终有两路");

  vectors = createVectorStore(fakeCtx(), { path: paths.vectors });
  memory = await openMemoryStore({ path: paths.memory });

  // ── 2. 写入三条记忆（一条带真实照片附件） ─────────────────────
  memory.ingest({
    sessionId: "acceptance",
    cwd: dir,
    blocks: [
      block("lock", { q: "数据库文件被锁住打不开怎么办", a: "先确认没有别的进程占着，再查文件权限", tag: "踩坑", perspective: "superego" }),
      // 这条的文本故意与图片无关：能召回它就只能是图片分片起了作用。
      block("photo", { q: "以前存档的那张胶片", a: "原图在附件里，别删", tag: "附件", perspective: "ego",
        attachments: [{ type: "image", path: photoURL.pathname.slice(1).replaceAll("/", "\\"), sha256: photoSha }] }),
      block("birthday", { q: "哥哥生日是几号", a: "十月十二", tag: "人", perspective: "id" }),
    ],
  });
  record("记忆写入", memory.stats());

  const openSync = async () => openMemoryVectors({
    memory, embeddings, vectorStore: vectors, path: paths.sync,
    options: { intervalMs: 60000, retryBaseMs: 100, localTimeoutMs: 120000 },
    log: (m) => console.log("  [sync] " + m),
  });
  sync = await openSync();

  // ── 3. 回填：entries 分段、每个空间各算一份、拼成完整实体 ──
  const drained = await sync.drain({ maxRounds: 200 });
  record("回填完成", { cursor: drained.cursor, entities: drained.entities, pending: drained.pending, coverage: drained.coverage.map((c) => ({ field: c.field, modality: c.modality, indexed: c.indexed })) });
  assert.equal(drained.pending, 0, "回填后不该还有待办任务");
  assert.ok(drained.entities >= 4, "三条记忆至少切成四个实体（含图片分片）");

  // ── 4. 语义召回：查询与原文没有字面重合 ──────────────────────
  const semantic = await sync.search({ query: "数据库被别的进程占用", limit: 3 });
  record("语义召回", semantic.items.map((i) => ({ blockId: i.blockId, q: i.q,
    similarity: Number(i.similarity.toFixed(4)), rrf: Number(i.vectorScore.toFixed(4)),
    bySource: i.vectorSources.map((s) => s.sourceId + "=" + Number(s.similarity.toFixed(4))) })));
  assert.equal(semantic.items[0]?.blockId, "lock", "语义最近的一条应当是数据库锁那条");
  assert.ok(semantic.items[0].vectorSources.some((s) => s.sourceId === "local-text"), "文本检索的语义应当来自纯文本模型");
  assert.ok(semantic.items[0].similarity > 0.5, "语义命中必须有明显高的余弦，而不是大家都差不多");
  assert.ok(semantic.items[0].similarity > semantic.items[1].similarity + 0.3, "正确的第一名要和次选拉开距离");

  // ── 5. 图文跳转：用文字找回一张“文本与图无关”的照片 ──
  const crossModal = await sync.search({ query: "两只猫在草地上", limit: 3 });
  record("图文召回", crossModal.items.map((i) => ({ blockId: i.blockId, q: i.q, modality: i.matchedModality })));
  assert.ok(crossModal.items.some((i) => i.blockId === "photo"), "文字必须能冲图片分片找回那张照片");

  // ── 6. 以图搜记忆 ─────────────────────────────────────────────────
  const byImage = await sync.search({ image: { path: photoURL.pathname.slice(1).replaceAll("/", "\\"), sha256: photoSha }, limit: 3 });
  record("以图搜记忆", { items: byImage.items.map((i) => ({ blockId: i.blockId, modality: i.matchedModality, similarity: Number(i.similarity?.toFixed?.(4) ?? 0) })),
    failures: byImage.failures, truncated: byImage.truncated });
  assert.ok(byImage.items.some((i) => i.blockId === "photo"), "用同一张图应当能找回带它的记忆");

  // ── 7. 混合召回：关键词 + 向量融合，且看得到各自依据 ──
  const hybrid = await hybridRecall({ memory, vectors: sync }, { query: "生日", limit: 3 });
  record("混合召回", { mode: hybrid.mode, items: hybrid.items.map((i) => ({ blockId: i.blockId, sources: i.recallSources })) });
  assert.equal(hybrid.mode, "hybrid");
  assert.equal(hybrid.items[0]?.blockId, "birthday");

  // ── 8. 重启：侧车与记忆库重开，已算过的向量不重算 ────
  const before = requestsOf(await embeddings.status(), "local-text");
  await sync.close();
  await vectors.close();
  memory.close();
  memory = await openMemoryStore({ path: paths.memory });
  vectors = createVectorStore(fakeCtx(), { path: paths.vectors });
  sync = await openSync();
  await sync.drain({ maxRounds: 200 });
  const after = requestsOf(await embeddings.status(), "local-text");
  const reopened = await sync.search({ query: "数据库被别的进程占用", limit: 1 });
  record("重启后", { embedCallsBefore: before, embedCallsAfter: after, stillFound: reopened.items[0]?.blockId });
  assert.equal(reopened.items[0]?.blockId, "lock", "重启后向量库内容应当还在");
  assert.equal(after, before, "重启不该重新计算已经因为内容缓存而算过的向量");

  // ── 9. 删除：原文一没，旧向量立刻不能用 ──────────────────────
  memory.deleteSession("acceptance");
  const afterDelete = await sync.search({ query: "数据库被别的进程占用", limit: 3 });
  assert.equal(afterDelete.items.length, 0, "删掉原文后不该还能召回");
  await sync.drain({ maxRounds: 200 });
  record("删除后", { entities: sync.status().entities, items: afterDelete.items.length });
  assert.equal(sync.status().entities, 0, "后台应当把实体也清掉");

  // ── 10. 故障降级：嵌入服务整体掉线，关键词仍能召回 ─────
  memory.ingest({ sessionId: "acceptance", cwd: dir, blocks: [block("birthday2", { q: "哥哥生日是几号", a: "十月十二", tag: "人", perspective: "id" })] });
  const broken = {
    list: () => embeddings.list(),
    embed: async () => { throw new Error("模拟嵌入服务不可用"); },
    status: () => embeddings.status(),
  };
  const degraded = await hybridRecall({ memory, vectors: { search: async () => { throw new Error("模拟向量不可用"); } } }, { query: "生日", limit: 3 });
  record("降级召回", { mode: degraded.mode, items: degraded.items.map((i) => i.blockId), failures: degraded.failures });
  assert.ok(degraded.items.some((i) => i.blockId === "birthday2"), "向量不可用时关键词路径仍要能召回");
  assert.ok(degraded.failures.length > 0, "降级原因要如实报出来，不能假装正常");
  void broken;

  console.log("\n全部通过：" + evidence.length + " 项证据");
  console.log(JSON.stringify({ passed: true, evidence }, null, 2));
  closed = true;
} finally {
  await sync?.close().catch(() => {});
  await vectors?.close().catch(() => {});
  memory?.close();
  await embeddings?.close().catch(() => {});
  if (closed) await rm(dir, { recursive: true, force: true }).catch(() => {});
  else console.error("验收未完成，临时目录留在：" + dir);
}

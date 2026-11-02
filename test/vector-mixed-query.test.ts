// test/vector-mixed-query.test.ts — 阶段 A 的三条机制：混合查询、通道能力声明、按排名融合。
//
// 这三条以前都是"能跑但语义不对"：
//   1. 有图就只算图片查询向量，文字线索被丢掉；
//   2. 通道能力靠"是不是多模态模型"一句话推断，图文来源的 text→text 被一律关掉；
//   3. 候选按跨空间原始余弦排序，不同模型、不同空间的相似度被拿去比大小。
// 这里用确定性假嵌入 + 真 Dataset 把正确行为固定住；真实模型那一路由
// scripts/acceptance-vector-memory.mjs 负责。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openVectorDB } from "@leolee9086/vectordb";
import { openMemoryStore, MEMORY_TOOL } from "../lib/memory.js";
import { openMemoryVectors } from "../lib/memory-vectors.js";

type Vector = number[];

const textSource = { id: "local-text", spaceId: "local-text@1", field: "v_text", dimension: 2, local: true, modalities: ["text"], queryable: true, weight: 1 };
const multiSource = { id: "local-multimodal", spaceId: "local-multimodal@1", field: "v_multi", dimension: 2, local: true, modalities: ["text", "image"], queryable: true, weight: 1 };

function memoryBlock(id: string, q: string, a: string, extra: any = {}) {
  return { id, seq: 1, time: Date.now(), surface: "log-only", type: "tool-call",
    text: MEMORY_TOOL + " " + JSON.stringify({ q, a, ...extra }) };
}

/**
 * 起一套真 Dataset + 确定性假嵌入。
 *
 * 键的形状：`来源id|输入`。文档输入是 memoryDocuments 拼出来的 "问题\n答复" 或图片绝对路径；
 * 查询输入是 query 文本或图片绝对路径。缺键直接抛错——不静默给默认向量，
 * 否则"某一路根本没被调用"会被伪装成通过。
 */
async function setup(t: any, options: {
  sources: any[];
  docVectors: Record<string, Vector>;
  queryVectors: Record<string, Vector>;
  blocks: any[];
  cwd: string;
}) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-vector-mixed-"));
  const memory = await openMemoryStore({ path: join(dir, "memory.sqlite") });
  const real = await openVectorDB({ path: join(dir, "vectors") });
  /** 每次 fuseSearch 实际发出去的通道字段名，用来断言"哪些通道参与了本次查询"。 */
  const lanes: string[][] = [];
  const vectorStore = {
    async dataset(name: string, schema: any) {
      const existing = await real.listDatasets();
      const handle = await (existing.some((item: any) => item.name === name)
        ? real.openDataset(name)
        : real.createDataset(name, schema));
      return {
        upsertEntities: (entities: any, writeOptions: any) => handle.upsertEntities(entities, writeOptions),
        deleteEntities: (ids: any, writeOptions: any) => handle.deleteEntities(ids, writeOptions),
        fuseSearch: (queries: any, searchOptions: any) => {
          lanes.push(queries.map((query: any) => query.index));
          return handle.fuseSearch(queries, searchOptions);
        },
      };
    },
    close: () => real.close(),
  };
  const embeddings = {
    list: () => options.sources,
    async embed(id: string, request: any) {
      const source = options.sources.find((item) => item.id === id);
      const input = request.inputs[0];
      const kind = input.image !== undefined ? input.image : input.text;
      const table = request.task === "query" ? options.queryVectors : options.docVectors;
      const vector = table[id + "|" + kind];
      if (vector === undefined) throw new Error("测试没有准备向量：" + id + "|" + kind);
      return { spaceId: source.spaceId, vectors: [Float32Array.from(vector)] };
    },
  };
  const sync = await openMemoryVectors({
    memory, embeddings: embeddings as any, vectorStore: vectorStore as any,
    path: join(dir, "sync.sqlite"), options: { retryBaseMs: 100000 },
  });
  t.after(async () => {
    await sync.close();
    await vectorStore.close();
    memory.close();
    await rm(dir, { recursive: true, force: true });
  });
  memory.ingest({ sessionId: "s", cwd: options.cwd, blocks: options.blocks });
  const state = await sync.drain();
  assert.equal(state.pending, 0, "回填不该留下待办：缺向量会让所有断言失去意义");
  return { sync, lanes, memory, dir };
}

test("混合查询：图文一起给时，文字线索不再被丢掉", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-vector-photo-"));
  const bytes = Buffer.from("photo bytes");
  const imagePath = join(dir, "photo.bin");
  await writeFile(imagePath, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const env = await setup(t, {
    sources: [textSource, multiSource],
    docVectors: {
      // 正文是 "问题\n答复"，两条记忆的文本会同时进纯文本来源和图文来源的文本塔。
      "local-text|先查锁\n再重启": [1, 0],
      "local-text|存档的胶片\n别删": [0, 1],
      "local-multimodal|先查锁\n再重启": [1, 0],
      "local-multimodal|存档的胶片\n别删": [0, 1],
      ["local-multimodal|" + imagePath]: [0, 1],
    },
    queryVectors: {
      "local-text|先查锁": [1, 0],
      "local-multimodal|先查锁": [0, 1],
      ["local-multimodal|" + imagePath]: [0, 1],
    },
    cwd: dir,
    blocks: [
      memoryBlock("lock", "先查锁", "再重启"),
      memoryBlock("photo", "存档的胶片", "别删", { attachments: [{ type: "image", path: imagePath, sha256 }] }),
    ],
  });

  env.lanes.length = 0;
  const outcome = await env.sync.search({ query: "先查锁", image: { path: imagePath, sha256 }, limit: 3 });
  const ids = outcome.items.map((item: any) => item.blockId);
  assert.ok(ids.includes("lock"), "文字线索必须把文字那条带回来");
  assert.ok(ids.includes("photo"), "图片线索必须把带图那条带回来");
  const photo = outcome.items.find((item: any) => item.blockId === "photo");
  assert.ok(photo.vectorSources.some((entry: any) => entry.queryModality === "image"), "带图那条要有图片查询的命中证据");
  const lock = outcome.items.find((item: any) => item.blockId === "lock");
  assert.ok(lock, "文字那条要出现在结果里");
  assert.ok(lock.vectorSources.some((entry: any) => entry.queryModality === "text"), "它必须带着文字查询的命中证据");
  assert.ok(env.lanes.length >= 2, "两种查询模态各要查一次");
});

test("通道能力：图文来源默认不接 text→text，声明后接", async (t) => {
  const defaultRun = await setup(t, {
    sources: [textSource, multiSource],
    docVectors: { "local-text|甲\n一": [1, 0], "local-multimodal|甲\n一": [1, 0] },
    queryVectors: { "local-text|甲": [1, 0], "local-multimodal|甲": [1, 0] },
    cwd: tmpdir(),
    blocks: [memoryBlock("a", "甲", "一")],
  });
  defaultRun.lanes.length = 0;
  await defaultRun.sync.search({ query: "甲", limit: 3 });
  const defaultFields = defaultRun.lanes.flat();
  assert.ok(defaultFields.includes("v_text_t"), "纯文本来源的文本通道要参与");
  assert.ok(!defaultFields.includes("v_multi_t"), "图文来源的文本通道默认不参与文字查询");

  const declaredRun = await setup(t, {
    sources: [textSource, { ...multiSource, capabilities: { "text->text": true } }],
    docVectors: { "local-text|甲\n一": [1, 0], "local-multimodal|甲\n一": [1, 0] },
    queryVectors: { "local-text|甲": [1, 0], "local-multimodal|甲": [1, 0] },
    cwd: tmpdir(),
    blocks: [memoryBlock("a", "甲", "一")],
  });
  declaredRun.lanes.length = 0;
  await declaredRun.sync.search({ query: "甲", limit: 3 });
  assert.ok(declaredRun.lanes.flat().includes("v_multi_t"), "来源显式声明 text->text 后，文本通道要参与");
  const coverage = declaredRun.sync.status().coverage.map((entry: any) => entry.field);
  assert.ok(coverage.includes("v_multi_t"), "声明之后这条通道要真的建出来");
});

test("每路内部归一化：只有一条候选的那一路不白拿名次", async (t) => {
  // 图片通道里只有一个候选，它的原始相似度很高（0.9）；但"这一路只有它自己"没有任何分辨力，
  // 归一化之后记 0。真正靠前的是文字通道里的第一名——它在这一路内部的相对位置才是有效信息。
  const dir = await mkdtemp(join(tmpdir(), "dsh-vector-fusion-"));
  const bytes = Buffer.from("image only");
  const imagePath = join(dir, "only.bin");
  await writeFile(imagePath, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const env = await setup(t, {
    sources: [textSource, multiSource],
    docVectors: {
      "local-text|文字那条\n一": [0.7, 0.7141428429],
      "local-text|图片那条\n一": [0.2, 0.9797958971],
      "local-multimodal|文字那条\n一": [0.7, 0.7141428429],
      "local-multimodal|图片那条\n一": [0.2, 0.9797958971],
      ["local-multimodal|" + imagePath]: [0.9, 0.4358898944],
    },
    queryVectors: {
      "local-text|文字那条": [1, 0],
      "local-multimodal|文字那条": [1, 0],
    },
    cwd: dir,
    blocks: [
      memoryBlock("text-doc", "文字那条", "一"),
      memoryBlock("image-only", "图片那条", "一", { attachments: [{ type: "image", path: imagePath, sha256 }] }),
    ],
  });

  const outcome = await env.sync.search({ query: "文字那条", limit: 3 });
  assert.equal(outcome.items[0].blockId, "text-doc", "文字通道里的第一名排最前");
  const imageOnly = outcome.items.find((item: any) => item.blockId === "image-only");
  assert.ok(imageOnly, "带图那条仍然要出现在结果里");
  assert.ok(imageOnly.similarity > 0.85, "它的原始余弦确实很高");
  assert.equal(imageOnly.relevance, 0, "但单候选的一路没有分辨力，归一化结果是 0");
  assert.equal(outcome.items[0].relevance, 1, "文字通道第一名在它那一路里是最靠前的");
});

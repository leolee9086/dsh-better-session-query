// test/vector-config.test.ts — 没有数据支撑的常量与策略都是配置项，改了要真的生效。
//
// 这里锁三件事：
//   1. 文本分片长度/重叠可配（含不切坏代理对）；
//   2. 图片大小上限可配；
//   3. 排序策略可切换：lane-normalized 看"每路内部的位置"，fusion 看"有多少路支持它"。
//      两种都没有基线支撑，所以默认值只是占位，必须能换。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openVectorDB } from "@leolee9086/vectordb";
import { memoryDocuments, imageInput } from "../lib/vector-documents.js";
import { openMemoryStore, MEMORY_TOOL } from "../lib/memory.js";
import { openMemoryVectors } from "../lib/memory-vectors.js";

const textSource = { id: "local-text", spaceId: "local-text@1", field: "v_text", dimension: 2, local: true, modalities: ["text"], queryable: true, weight: 1 };
const multiSource = { id: "local-multimodal", spaceId: "local-multimodal@1", field: "v_multi", dimension: 2, local: true, modalities: ["text", "image"], queryable: true, weight: 1 };

test("分片大小与重叠可配，且不切坏代理对", () => {
  const item = { blockId: "b", q: "1234567890", a: "abcdefghij", attachments: [] };
  const tight = memoryDocuments(item, { chunkChars: 10, chunkOverlap: 0 });
  assert.equal(tight.length, 3, "21 个单元按 10 切，得到 3 片");
  assert.deepEqual(tight.map((doc: any) => doc.input.text.length), [10, 10, 1]);

  const overlapped = memoryDocuments(item, { chunkChars: 10, chunkOverlap: 5 });
  assert.equal(overlapped.length, 5, "步长 5 时得到 5 片");
  assert.equal(overlapped[0].input.text, "1234567890");
  // 步长 5、长度 10：第二片从第 5 个单元起，和前一片重叠 5 个单元。
  assert.equal(overlapped[1].input.text, "67890\nabcd");

  // 第 9 个单元是 emoji 的高位代理；把切片边界放在这里必须往回收一格。
  const emoji = { blockId: "e", q: "a".repeat(9) + "\u{1F600}", a: "", attachments: [] };
  const [first] = memoryDocuments(emoji, { chunkChars: 10, chunkOverlap: 0 });
  assert.equal(first.input.text.length, 9, "不能把一个代理对切成两半");
  assert.equal(first.input.text, "a".repeat(9));
});

test("图片大小上限可配", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-vector-bytes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from("1234");
  const file = join(dir, "tiny.bin");
  await writeFile(file, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  await assert.doesNotReject(() => imageInput({ image: file, sha256 }, { maxBytes: 8 }));
  await assert.rejects(() => imageInput({ image: file, sha256 }, { maxBytes: 2 }), /超过大小上限/);
});

async function setup(t: any, options: any) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-vector-mode-"));
  const memory = await openMemoryStore({ path: join(dir, "memory.sqlite") });
  const real = await openVectorDB({ path: join(dir, "vectors") });
  const vectorStore = {
    async dataset(name: string, schema: any) {
      const existing = await real.listDatasets();
      const handle = await (existing.some((item: any) => item.name === name)
        ? real.openDataset(name)
        : real.createDataset(name, schema));
      return {
        upsertEntities: (entities: any, writeOptions: any) => handle.upsertEntities(entities, writeOptions),
        deleteEntities: (ids: any, writeOptions: any) => handle.deleteEntities(ids, writeOptions),
        fuseSearch: (queries: any, searchOptions: any) => handle.fuseSearch(queries, searchOptions),
      };
    },
    close: () => real.close(),
  };
  const embeddings = {
    list: () => [textSource, multiSource],
    async embed(id: string, request: any) {
      const source = [textSource, multiSource].find((item) => item.id === id);
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
    path: join(dir, "sync.sqlite"), options: { retryBaseMs: 100000, ...(options.vectors || {}) },
  });
  t.after(async () => {
    await sync.close();
    await vectorStore.close();
    memory.close();
    await rm(dir, { recursive: true, force: true });
  });
  memory.ingest({ sessionId: "s", cwd: dir, blocks: options.blocks });
  const state = await sync.drain();
  assert.equal(state.pending, 0, "回填不该留下待办");
  return sync;
}

const memoryBlock = (id: string, q: string, a: string, extra: any = {}) => ({
  id, seq: 1, time: Date.now(), surface: "log-only", type: "tool-call",
  text: MEMORY_TOOL + " " + JSON.stringify({ q, a, ...extra }),
});

test("排序策略可切换：lane-normalized 与 fusion 会给出不同顺序", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-vector-mode-img-"));
  const bytes = Buffer.from("image bytes");
  const imagePath = join(dir, "b.bin");
  await writeFile(imagePath, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const build = (relevanceMode: string) => setup(t, {
    vectors: { relevanceMode },
    docVectors: {
      "local-text|文字那条\n一": [0.99, 0.1410673598],
      "local-text|图片那条\n一": [0.95, 0.3122498999],
      "local-multimodal|文字那条\n一": [0.99, 0.1410673598],
      "local-multimodal|图片那条\n一": [0.95, 0.3122498999],
      ["local-multimodal|" + imagePath]: [0.1, 0.9949874371],
    },
    queryVectors: {
      "local-text|文字那条": [1, 0],
      "local-multimodal|文字那条": [1, 0],
    },
    blocks: [
      memoryBlock("text-doc", "文字那条", "一"),
      memoryBlock("image-doc", "图片那条", "一", { attachments: [{ type: "image", path: imagePath, sha256 }] }),
    ],
  });

  const normalized = await build("lane-normalized");
  const normalizedItems = await normalized.search({ query: "文字那条", limit: 3 });
  assert.equal(normalizedItems.items[0].blockId, "text-doc", "按路内位置：文字通道第一名胜出");

  const fused = await build("fusion");
  const fusedItems = await fused.search({ query: "文字那条", limit: 3 });
  assert.equal(fusedItems.items[0].blockId, "image-doc",
    "按融合排名：一路名次靠前 + 另一路也有命中，合计名次更高");
  assert.notEqual(normalizedItems.items[0].blockId, fusedItems.items[0].blockId, "两种策略确实不同");
});

// test/vector-image-query.test.ts — 以图搜记忆：外部 {path, sha256} 必须能一路走到查询向量。
//
// 锁住的是计划文档 2026-10-02 记过、2026-11-02 仍在复现的那个缺口：
// 工具与验收脚本传 {path, sha256}，底层 imageInput 读 {image, sha256}，
// 于是查询向量算不出来，召回静默返回空（失败原因只写 query-embedding-unavailable）。
// scripts/acceptance-vector-memory.mjs 用真模型能验到这条，但要 540MiB 模型；
// 这里用确定性假嵌入 + 真 Dataset，把同一段契约固定在单测里。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openVectorDB } from "@leolee9086/vectordb";
import { openMemoryStore, MEMORY_TOOL } from "../lib/memory.js";
import { openMemoryVectors } from "../lib/memory-vectors.js";

/** 记录查询阶段真正发给嵌入来源的输入。 */
const queryInputs: Array<{ id: string; input: any }> = [];

/**
 * 两个本地来源：纯文本一个、图文一个（与生产默认配置同形）。
 * 图片输入与"照片/胶片"文字都落到同一方向，于是同一张图应当以 similarity≈1 找回自己。
 */
function provider() {
  const sources = [
    { id: "local-text", spaceId: "local-text@1", field: "v_text", dimension: 2, local: true, modalities: ["text"], queryable: true, weight: 1 },
    { id: "local-multimodal", spaceId: "local-multimodal@1", field: "v_multi", dimension: 2, local: true, modalities: ["text", "image"], queryable: true, weight: 1 },
  ];
  return {
    list: () => sources,
    async embed(id: string, request: any) {
      const source = sources.find((item) => item.id === id)!;
      const [input] = request.inputs;
      if (request.task === "query") queryInputs.push({ id, input });
      const photo = input.image !== undefined || /照片|胶片/.test(input.text ?? "");
      return { spaceId: source.spaceId, vectors: [Float32Array.from(photo ? [1, 0] : [0, 1])] };
    },
  };
}

/** 真 Dataset：和测试用的辅助模块同一份基础库，只是不复用未提交的 helper 文件。 */
async function openVectors(path: string) {
  const db = await openVectorDB({ path });
  return {
    async dataset(name: string, options: any) {
      const existing = await db.listDatasets();
      return existing.some((item: any) => item.name === name) ? db.openDataset(name) : db.createDataset(name, options);
    },
    close: () => db.close(),
  };
}

test("以图搜记忆：外部 {path, sha256} 能算查询向量并找回该记忆", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-vector-image-"));
  // imageInput 只校验字节身份，不解码图片，所以这里用任意字节就够。
  const bytes = Buffer.from("fixture bytes, not a real png");
  const imagePath = join(dir, "photo.bin");
  await writeFile(imagePath, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const memory = await openMemoryStore({ path: join(dir, "memory.sqlite") });
  const vectors = await openVectors(join(dir, "vectors"));
  const sync = await openMemoryVectors({
    memory,
    embeddings: provider() as any,
    vectorStore: vectors as any,
    path: join(dir, "sync.sqlite"),
    options: { retryBaseMs: 100000 },
  });
  t.after(async () => {
    await sync.close();
    await vectors.close();
    memory.close();
    await rm(dir, { recursive: true, force: true });
  });

  memory.ingest({
    sessionId: "s",
    blocks: [
      { id: "photo", seq: 1, time: Date.now(), surface: "log-only", type: "tool-call",
        text: MEMORY_TOOL + " " + JSON.stringify({ q: "以前存档的那张胶片", a: "原图在附件里",
          attachments: [{ type: "image", path: imagePath, sha256 }] }) },
      { id: "lock", seq: 1, time: Date.now(), surface: "log-only", type: "tool-call",
        text: MEMORY_TOOL + " " + JSON.stringify({ q: "数据库被别的进程占着", a: "先查权限再重启" }) },
    ],
  });
  const state = await sync.drain();
  assert.equal(state.pending, 0, "回填不该留下待办");

  queryInputs.length = 0;
  const outcome = await sync.search({ image: { path: imagePath, sha256 }, limit: 3 });
  assert.ok(queryInputs.length > 0, "图片查询必须真的去算查询向量");
  for (const entry of queryInputs) {
    assert.equal(entry.input.image, imagePath, "查询向量要拿到本地路径");
    assert.equal(entry.input.text, undefined, "图片查询不该混进空文本");
  }
  assert.deepEqual(outcome.failures, [], "不该有查询向量失败");
  assert.equal(outcome.items[0]?.blockId, "photo", "同一张图应当找回带它的记忆");
  assert.ok(outcome.items[0].similarity > 0.99, "同一张图的余弦应当接近 1");

  // 缺 path 的线索在入口就拒绝；不能变成"算不出来 → 空结果"。
  await assert.rejects(() => sync.search({ image: { sha256 } }), /需提供 path 或 image/);
});

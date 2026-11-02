// test/integration.test.mjs — 真实链路：真日志文件 + 真 rebec + 真索引库。
//
// 其它测试都注入 logReader，等于把"定位文件、分帧解压、按窗口读"这条生产路径整段跳过。
// 这里反过来：只把 rebec 的实现交给日志源，文件系统、分帧、surfaceOp、写库、搜索全走真的。
//
// 没有 rebec 时整组 skip（它由 npm 包提供，不在源码树里）。
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";

import { openStore } from "../lib/store.js";
import { createIndexer } from "../lib/indexer.js";
import { locateSessionLog } from "../lib/log-source.js";

const require = createRequire(import.meta.url);

/** 优先用环境变量指的本地产物，其次用已安装的包。 */
function loadRebec() {
  const candidates = [process.env.DSH_REBEC_PATH, "@leolee9086/rebec"].filter(
    (value) => typeof value === "string" && value !== "",
  );
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}

const rebec = loadRebec();
const skip = rebec === undefined
  ? "没有可用的 rebec（设置 DSH_REBEC_PATH 指向 rebec.node，或先 pnpm add @leolee9086/rebec）"
  : false;

/**
 * 拼一份合法的 v4 日志：多帧 zstd，每帧是若干完整 JSONL 行。
 * 帧边界落在行之间——真实写入就是这么切的。
 * @param frames - 每个子数组是一帧的行。
 * @returns 文件字节。
 */
function buildLog(frames) {
  return Buffer.concat(
    frames.map((lines) => zstdCompressSync(Buffer.from(lines.join("\n") + "\n", "utf8"))),
  );
}

function userEvent(seq, text, time = 1000 + seq) {
  return JSON.stringify({
    type: "user/message", seq, time, surfaceOp: "append",
    data: { content: [{ type: "text", text }] },
  });
}

function assistantEvent(seq, text, time = 1000 + seq) {
  return JSON.stringify({
    type: "assistant/message", seq, time, surfaceOp: "append",
    data: { message: { content: [{ type: "text", text }] } },
  });
}

/** 日志源：定位走生产实现，分批读走真 rebec。 */
function realLogReader() {
  const calls = { stat: 0, batch: 0 };
  return {
    calls,
    locateSessionLog: (id) => locateSessionLog(id, { force: true }),
    statSessionLog: (path) => {
      calls.stat += 1;
      const info = statSync(path);
      return { size: info.size, mtimeMs: Math.trunc(info.mtimeMs) };
    },
    readSessionBatch: (path, offset, limit) => {
      calls.batch += 1;
      return JSON.parse(rebec.sessionScanLog(path, offset, limit));
    },
  };
}

/** 起一个临时 DSH_HOME，返回清理函数。 */
function withHome(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  return {
    home,
    done() {
      rmSync(home, { recursive: true, force: true });
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    },
  };
}

/** 在临时 home 里写一份日志，返回路径。 */
function writeSessionLog(home, sessionId, frames) {
  const dir = join(home, "sessions", "--D-dev--", sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "session.v4.jsonl.zstd");
  writeFileSync(path, buildLog(frames));
  return path;
}

/**
 * 真实的会话清单:扫 sessions 目录,用 rebec 读每个日志的 header。
 *
 * 这不是假数据:目录结构、文件名、header 内容都来自磁盘上真实写的日志。
 * 索引器只调 listSessions 拿 id/cwd,其余全走文件。
 */
function realConversation(home) {
  return {
    async listSessions() {
      const root = join(home, "sessions");
      const records = [];
      for (const project of readdirSync(root)) {
        const projectDir = join(root, project);
        for (const session of readdirSync(projectDir)) {
          const file = join(projectDir, session, "session.v4.jsonl.zstd");
          try {
            const win = JSON.parse(rebec.sessionScanLog(file, 0, 1));
            if (win.header !== undefined && win.header !== null) {
              records.push({ header: { id: win.header.id, cwd: win.header.cwd }, live: false, persisted: true });
            }
          } catch {
            continue;
          }
        }
      }
      return records;
    },
  };
}
function headerLine(sessionId) {
  return JSON.stringify({
    type: "session", version: 4, id: sessionId, createdAt: 1, cwd: "D:\\dev",
  });
}

test("真实链路：造 v4 日志 → 定位 → 分批读 → 索引 → 搜索", { skip }, async () => {
  const env = withHome("bsq-integration-");
  const sessionId = "session-real-1";
  writeSessionLog(env.home, sessionId, [
    [headerLine(sessionId), userEvent(0, "第一问"), assistantEvent(1, "第一答")],
    [userEvent(2, "第二问"), assistantEvent(3, "第二答")],
  ]);

  const store = await openStore({ path: ":memory:" });
  try {
    const logReader = realLogReader();
    const indexer = createIndexer({ conversation: realConversation(env.home), logReader, store, options: { recheckMs: 0 }, log: () => {} });

    const first = await indexer.reconcile({ force: true });
    assert.equal(first.errors, 0, "不该有失败");
    assert.equal(first.updated, 1, "真日志应该被索引进去");

    const row = store.getSession(sessionId);
    assert.ok(row !== undefined, "簿记里要有这个会话");
    assert.equal(row.cwd, "D:\\dev", "cwd 来自真实 header");
    assert.equal(row.events, 4, "四条事件");
    assert.equal(store.search({ query: "第二答" }).items.length, 1, "真实内容要能搜到");
    assert.ok(Number(row.log_offset) > 0, "续读位置要落库");
  } finally {
    store.close();
    env.done();
  }
});

test("真实链路：只追加一帧时只读新帧", { skip }, async () => {
  const env = withHome("bsq-integration-inc-");
  const sessionId = "session-real-2";
  const path = writeSessionLog(env.home, sessionId, [[headerLine(sessionId), userEvent(0, "旧问题")]]);

  const store = await openStore({ path: ":memory:" });
  try {
    const logReader = realLogReader();
    const indexer = createIndexer({ conversation: realConversation(env.home), logReader, store, options: { recheckMs: 0 }, log: () => {} });
    await indexer.reconcile({ force: true });
    assert.ok(Number(store.getSession(sessionId).log_offset) > 0);

    writeFileSync(path, Buffer.concat([
      buildLog([[headerLine(sessionId), userEvent(0, "旧问题")]]),
      buildLog([[userEvent(1, "新追问"), assistantEvent(2, "新回答")]]),
    ]));

    const before = logReader.calls.batch;
    const second = await indexer.reconcile();
    assert.equal(second.updated, 1, "文件变长要续读");
    assert.equal(logReader.calls.batch, before + 1, "只读新长出来的那一帧");
    assert.equal(store.search({ query: "新回答" }).items.length, 1, "新内容要能搜到");
    assert.equal(store.search({ query: "旧问题" }).items.length, 1, "旧块要还在");
    assert.equal(store.getSession(sessionId).events, 3, "事件数累加");
  } finally {
    store.close();
    env.done();
  }
});

test("真实链路：surfaceOp=replace 把旧块降为 log-only", { skip }, async () => {
  const env = withHome("bsq-integration-surface-");
  const sessionId = "session-real-3";
  writeSessionLog(env.home, sessionId, [[headerLine(sessionId)], [
    userEvent(0, "会被压缩掉的一问"),
    assistantEvent(1, "会被压缩掉的一答"),
    JSON.stringify({
      type: "assistant/message",
      seq: 2,
      time: 2000,
      surfaceOp: { op: "replace", startSeq: 0, endSeq: 1 },
      sourceEventSeqs: [0, 1],
      data: { message: { content: [{ type: "text", text: "压缩摘要" }] } },
    }),
  ]]);

  const store = await openStore({ path: ":memory:" });
  try {
    const indexer = createIndexer({ conversation: realConversation(env.home), logReader: realLogReader(), store, options: { recheckMs: 0 }, log: () => {} });
    const summary = await indexer.reconcile({ force: true });
    assert.equal(summary.errors, 0);

    const bySeq = new Map();
    for (const row of store.queryBlocks({ sessionIds: [sessionId] }).items) bySeq.set(row.seq, row.surface);
    assert.equal(bySeq.get(0), "log-only", "被 replace 覆盖的 seq 0 降为 log-only");
    assert.equal(bySeq.get(1), "log-only", "被覆盖的 seq 1 降为 log-only");
    assert.equal(bySeq.get(2), "current", "替换者在表层");
    assert.equal(store.search({ query: "压缩摘要" }).items.length, 1);
  } finally {
    store.close();
    env.done();
  }
});

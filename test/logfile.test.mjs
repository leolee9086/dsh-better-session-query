// test/logfile.test.mjs — 落盘诊断日志:写入、单代轮换、显式关闭、目录自动创建,以及插件接线后失败原因可见。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileLog } from "../lib/logfile.js";
import { resolveLogFile } from "../lib/index.js";
import { apply } from "../lib/index.js";
import { LogFixture, loadRebec } from "./real-log.mjs";

const DIR = join(tmpdir(), `bsq-logfile-test-${process.pid}`);
const cleanup = () => rmSync(DIR, { recursive: true, force: true });

test("createFileLog:写入带时间戳,目录自动创建", () => {
  const path = join(DIR, "nested", "session-blocks.log");
  const log = createFileLog({ path, maxBytes: 1024 * 1024 });
  log.write("第一行");
  log.write("第二行");
  const text = readFileSync(path, "utf8");
  assert.match(text, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z 第一行\n/, "每行带 ISO 时间戳");
  assert.match(text, /第二行$/m);
  cleanup();
});

test("createFileLog:超过上限后单代轮换(.1),当前文件重新计数", () => {
  const path = join(DIR, "rotate.log");
  const log = createFileLog({ path, maxBytes: 100 });
  for (let i = 0; i < 6; i += 1) log.write(`第 ${i} 条足够长的诊断信息,撑大文件用。`);
  const current = readFileSync(path, "utf8");
  assert.ok(current.length <= 100 + 200, `当前文件在轮换线附近:${current.length}`);
  const archived = readFileSync(`${path}.1`, "utf8");
  assert.ok(archived.length > 0, "上一代归档存在");
  cleanup();
});

test("createFileLog:path 为空串是显式关闭,write 是空操作", () => {
  const log = createFileLog({ path: "" });
  assert.equal(log.path, "");
  assert.doesNotThrow(() => log.write("不应落盘"));
});

test("resolveLogFile:默认 <DSH_HOME>/logs,off 关闭,显式路径透传", () => {
  process.env.DSH_HOME = join(DIR, "home");
  assert.equal(resolveLogFile(""), join(DIR, "home", "logs", "session-blocks.log"));
  assert.equal(resolveLogFile(undefined), join(DIR, "home", "logs", "session-blocks.log"));
  assert.equal(resolveLogFile("off"), "");
  assert.equal(resolveLogFile("D:\\custom\\log.txt"), "D:\\custom\\log.txt");
  delete process.env.DSH_HOME;
});

// 这一例走真实日志:两个会话都真的落在临时 DSH_HOME 里,其中一个的日志被写成坏魔数。
// 失败因此发生在 rebec 分帧解压那条生产路径上,原因要落进诊断日志、由状态工具报出来。
const rebec = loadRebec();
const skipNoRebec = rebec === undefined ? "需要可用的 rebec(设置 DSH_REBEC_PATH 或安装 @leolee9086/rebec)" : false;

test("接线:对账失败的原因落盘,状态工具能报出来", { skip: skipNoRebec }, async () => {
  // fixture 自己接管 DSH_HOME(指向它的临时目录),会话目录与诊断日志都落在它下面。
  const fixture = new LogFixture("bsq-logfile-");
  try {
    fixture.write("session-ok", {
      cwd: "D:\\dev",
      events: [{ seq: 0, type: "user/message", time: 1, surfaceOp: "append", data: { content: [{ type: "text", text: "正文" }] } }],
    });
    // 坏魔数:定位和 stat 都成功,失败只会发生在 rebec 解帧时——也就是索引的第二相。
    fixture.corrupt("session-broken");
    const logPath = join(fixture.home, "logs", "session-blocks.log");
    const conversation = fixture.conversation();
    const tools = new Map();
    const ctx = {
      get: (name) => (name === "sessionQuery" ? conversation : undefined),
      tools: { register: (def) => { tools.set(def.name, def); } },
      provide: () => {},
      effect: (callback) => { callback(); },
      inject: () => ({ dispose() {} }),
      logger: { info() {} },
    };
    // 记忆库也要显式指到内存:它的默认路径落在 DSH_HOME 下,否则会在临时目录里
    // 留下一个被锁住的 session-memory.db,让 fixture.done() 删不掉目录。
    await apply(ctx, { path: ":memory:", memoryPath: ":memory:", logFile: logPath, logReader: fixture.logReader() });
    const status = await tools.get("session_blocks_status").execute({ reindex: true }, {});
    assert.match(status, /已索引 1 个会话/, "正常会话照常进索引");
    assert.match(status, /失败样例/);
    assert.match(status, /\[write\] session-broken/, "失败发生在读日志那一相,不是清单");
    assert.match(status, /不是 zstd 帧头/);
    const onDisk = readFileSync(logPath, "utf8");
    assert.match(onDisk, /索引会话 session-broken 失败:字节 0 处不是 zstd 帧头/, "失败原因必须落盘,stdout 不算数");
  } finally {
    fixture.done();
  }
});

// test/plugin.test.mjs — 插件入口测试:假 ctx + 假 conversation 服务 + :memory: 库,端到端跑工具。
//
// 不 import 任何 DSH 包:ctx 只用 apply 真正会碰到的那几个面(get/provide/tools.register/effect/logger)。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
// 测试不碰真实用户目录:DSH_HOME 指到临时目录,库与诊断日志路径随之隔离。
process.env.DSH_HOME = path.join(os.tmpdir(), `bsq-test-home-${process.pid}`);

import {
  SERVICE_NAME,
  apply,
  formatHits,
  formatMessages,
  normalizeOptions,
  toEpochMs,
} from "../lib/index.js";
import { DEFAULT_INCLUDE } from "../lib/blocks.js";
import { LogFixture } from "./real-log.mjs";

// 每个用例都会开一个临时 DSH_HOME,跑完统一删。
const fixtures = [];
after(() => {
  for (const item of fixtures) item.done();
});

// 假的工作区路径:只是测试数据,不指向本机任何真实目录。
const WORKSPACE = "C:\\fake\\alpha";
const SESSION_ID = "s-1";

const T = {
  ask: 1700000000000,
  answer: 1700000010000,
  follow: 1700000020000,
  final: 1700000030000,
};

/** 与任务书给出的一致:只实现 apply 真正用到的 ctx 面。 */
function fakeCtx(conversation, options = {}) {
  const tools = new Map(); const provided = new Map(); const effects = []; const injected = [];
  return {
    get: (n) => n === "sessionQuery" ? conversation : undefined,
    tools: { register: (def) => { tools.set(def.name, def); } },
    provide: (n, v) => { provided.set(n, v); },
    effect: (cb, label) => { effects.push({ disposer: cb(), label }); },
    // 可选服务用 ctx.inject 延迟取得:给出 persistence 时立刻"可用",否则永不回调。
    inject: (deps, callback) => {
      injected.push([...deps]);
      if (options.persistence !== undefined && deps.includes("sessionPersistence")) {
        callback({
          sessionPersistence: options.persistence,
          effect: (cb, label) => { effects.push({ disposer: cb(), label }); },
        });
      }
      return { dispose() {} };
    },
    logger: { info() {} },
    _tools: tools, _provided: provided, _effects: effects, _injected: injected,
  };
}

/** 会话事件:seq0 用户、seq1 agent(思考 + 正文)、seq2 用户、seq3 agent。 */
function sessionEvents() {
  return [
    { seq: 0, type: "user/message", time: T.ask, surfaceOp: "append", data: { content: [{ type: "text", text: "苹果 帮我看看" }] } },
    {
      seq: 1,
      type: "assistant/message",
      time: T.answer,
      surfaceOp: "append",
      data: { message: { content: [{ type: "reasoning", text: "先想一下关键词" }, { type: "text", text: "苹果 在这里" }] } },
    },
    { seq: 2, type: "user/message", time: T.follow, surfaceOp: "append", data: { content: [{ type: "text", text: "还有别的吗" }] } },
    { seq: 3, type: "assistant/message", time: T.final, surfaceOp: "append", data: { message: { content: [{ type: "text", text: "橘子 不在这里" }] } } },
  ];
}

/** 假 conversation 服务:只实现本插件调用到的四个方法。 */
function fakeConversation() {
  const events = sessionEvents();
  const calls = { listSessions: 0, listEvents: 0, readSession: 0, readEvent: 0, readTitleSnapshots: 0 };
  // 事件真的写进临时 DSH_HOME:索引读的是文件,不是这份数组。
  const fixture = new LogFixture("bsq-plugin-");
  fixture.write(SESSION_ID, { cwd: WORKSPACE, events });
  fixtures.push(fixture);
  const listing = fixture.conversation();
  const reader = fixture.logReader();
  return {
    events,
    logReader: reader,
    calls,
    fixture,
    async listSessions() {
      calls.listSessions += 1;
      return listing.listSessions();
    },
    async listEvents(id) {
      calls.listEvents += 1;
      assert.equal(id, SESSION_ID);
      return events.map((event) => ({ seq: event.seq, type: event.type, time: event.time, surface: "current" }));
    },
    async readSession(id) {
      calls.readSession += 1;
      assert.equal(id, SESSION_ID);
      return { session: { id }, inheritedEventCount: 0, events };
    },
    async readEvent({ sessionId, seq }) {
      calls.readEvent += 1;
      assert.equal(sessionId, SESSION_ID);
      return { target: events.find((event) => event.seq === seq) };
    },
    async readTitleSnapshots(ids) {
      calls.readTitleSnapshots += 1;
      return ids.map((id) => (id === SESSION_ID
        ? { status: "fulfilled", value: { title: { title: "苹果会话" } } }
        : { status: "rejected", reason: new Error("没这个会话的标题") }));
    },
  };
}

/** 起一个插件实例,返回跑工具的小工具函数。 */
async function setup(rawConfig = {}) {
  const conversation = fakeConversation();
  const ctx = fakeCtx(conversation);
  // 两个库都指到内存:单元测试不该在 DSH_HOME 下留真实文件——记忆库的默认路径是真实文件,
  // 会被临时目录的清理撞上(EBUSY)。
  await apply(ctx, { path: ":memory:", memoryPath: ":memory:", logReader: conversation.logReader, ...rawConfig });
  const tool = (toolName) => {
    const def = ctx._tools.get(toolName);
    assert.ok(def !== undefined, `没有注册工具 ${toolName}`);
    return def;
  };
  return {
    conversation,
    logReader: conversation.logReader,
    ctx,
    tool,
    run: (toolName, args = {}, exec = {}) => tool(toolName).execute(args, exec),
  };
}

/** 起一个插件实例并先对账一轮(端到端用例的统一起点)。 */
async function setupIndexed(rawConfig = {}) {
  const app = await setup(rawConfig);
  const status = await app.run("session_blocks_status", { reindex: true });
  assert.match(status, /已索引 1 个会话、5 个块/, status);
  return app;
}

test("apply:注册块索引的 9 个工具,形状都合法", async () => {
  const { ctx, tool } = await setup();
  assert.deepEqual([...ctx._tools.keys()].sort(), [
    "session_blocks_list",
    "session_blocks_query",
    "session_blocks_read",
    "session_blocks_recall",
    "session_blocks_remember",
    "session_blocks_search",
    "session_blocks_sql",
    "session_blocks_status",
    "session_blocks_workspaces",
  ]);
  for (const name of ctx._tools.keys()) {
    const def = tool(name);
    assert.equal(def.name, name);
    assert.equal(typeof def.execute, "function", `${name} 要有 execute`);
    assert.equal(def.parameters.type, "object", `${name} 的参数是 JSON Schema 对象`);
    assert.equal(def.output.schema.type, "string", `${name} 的 output 是字符串`);
    assert.equal(typeof def.description, "string");
    assert.ok(def.description.length > 0);
  }
  assert.equal(ctx._effects.length, 1, "卸载时要能关库");
  assert.equal(ctx._effects[0].label, "betterSessionQuery.close");
  assert.equal(typeof ctx._effects[0].disposer, "function");
});

// 伪工具的重点恰恰是"什么都不做":它不该碰索引库,也不该因为库打不开而失败。
// 断言落在两处——返回值回显了参数,而索引规模一点没变。
test("session_blocks_remember:伪工具只回显,不落库、不碰索引", async () => {
  const app = await setupIndexed(); // 先索引一轮,"没变"才是真的有东西可不变
  const service = app.ctx._provided.get(SERVICE_NAME);
  const before = await service.stats();
  assert.ok(before.blocks > 0, "前置:索引里已经有块了");

  const out = await app.run("session_blocks_remember", {
    q: "包管理器用哪个",
    a: "pnpm",
    tag: "环境",
    expires: "换了项目就作废",
  });
  assert.match(out, /已标记在会话流中/);
  assert.match(out, /Q: 包管理器用哪个/);
  assert.match(out, /A: pnpm/);
  assert.match(out, /tag: 环境/);
  assert.match(out, /失效条件: 换了项目就作废/);
  // "调用成功≠以后一定被读到"是这条工具的意义所在,不该在实现里丢掉。
  assert.match(out, /memos/);

  const after = await service.stats();
  assert.equal(after.blocks, before.blocks, "伪工具不该往索引里写任何块");
  assert.equal(after.generation, before.generation, "伪工具不该触发任何写入");
  await service.close();
});

test("session_blocks_remember:q/a 必填,tag/expires 可省", async () => {
  const app = await setup();
  assert.match(await app.run("session_blocks_remember", {}), /ERROR: q 参数必填/);
  assert.match(await app.run("session_blocks_remember", { q: "只有问题" }), /ERROR: a 参数必填/);
  assert.match(await app.run("session_blocks_remember", { q: "   ", a: "答案" }), /ERROR: q 参数必填/);

  const minimal = await app.run("session_blocks_remember", { q: "最小用法", a: "只给问答对" });
  assert.match(minimal, /Q: 最小用法/);
  assert.doesNotMatch(minimal, /tag:/, "没给 tag 就不该回显 tag 行");
  assert.doesNotMatch(minimal, /失效条件:/, "没给 expires 就不该回显失效条件行");
  await app.ctx._provided.get(SERVICE_NAME).close();
});

// 图片附件:工具只校验"这些字节确实还在",不写库——记忆正文仍靠会话流承载。
test("session_blocks_remember:图片附件按字节校验,坏路径与坏哈希都拒收", async () => {
  const app = await setupIndexed();
  const service = app.ctx._provided.get(SERVICE_NAME);
  const before = await service.stats();
  // 1x1 透明 PNG:真实图片字节,用来走"读文件 + 比 SHA256"这条路径。
  const dir = await mkdtemp(path.join(os.tmpdir(), "bsq-attachment-"));
  const image = path.join(dir, "dot.png");
  const bytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
    "hex",
  );
  await writeFile(image, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    const out = await app.run("session_blocks_remember", {
      q: "附件测试",
      a: "只有这张图",
      attachments: [{ type: "image", path: image, sha256 }],
    });
    assert.match(out, /图片: /);
    assert.ok(out.includes(image), "回显要带上图片路径");
    const cases = [
      [{ type: "image", path: image, sha256: "0".repeat(64) }, "字节对不上"],
      [{ type: "image", path: "dot.png", sha256 }, "相对路径"],
      [{ type: "image", path: path.join(dir, "nope.png"), sha256 }, "文件不在"],
      [{ type: "image", path: image }, "缺 SHA256"],
    ];
    for (const [attachment, why] of cases) {
      const rejected = await app.run("session_blocks_remember", { q: "附件测试", a: "拒收", attachments: [attachment] });
      assert.match(rejected, /ERROR: 图片附件校验失败/, why);
    }
    const after = await service.stats();
    assert.equal(after.blocks, before.blocks, "记住一条带图的记忆不该往块索引里写东西");
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("apply:提供 sessionBlockQuery 服务且方法齐全", async () => {
  const { ctx } = await setup();
  const service = ctx._provided.get(SERVICE_NAME);
  assert.ok(service !== undefined, `provided 里要有 ${SERVICE_NAME}`);
  assert.deepEqual(Object.keys(service).sort(), [
    "attributeNamespaces",
    "close",
    "compact",
    "getBlock",
    "listAttributes",
    "listBlocks",
    "monitor",
    "putAttribute",
    "queryBlocks",
    "queryMessages",
    "querySessions",
    "queryWorkspaces",
    "readRawBlocks",
    "reconcile",
    "removeAttribute",
    "searchBlocks",
    "setPaused",
    "sqlQuery",
    "stats",
  ]);
  for (const [method, fn] of Object.entries(service)) {
    assert.equal(typeof fn, "function", `${method} 要是个函数`);
  }
  const stats = await service.stats();
  assert.equal(stats.enabled, true);
  assert.equal(stats.path, ":memory:");
  await service.close();
});

test("端到端:status(reindex) 报告规模与上次更新", async () => {
  const app = await setup();
  const output = await app.run("session_blocks_status", { reindex: true });
  assert.match(output, /索引库: :memory:/);
  assert.match(output, /已索引 1 个会话、5 个块\(其中 4 个进倒排,1 个正文另存\)/);
  // 摘要带批次构成:待补(从未索引)/实时/到期——这组数就是"进度卡住"那类问题的诊断入口。
  assert.match(output, /上次计划: 会话总数 1,计划处理 1\(待补 1、实时 0、到期 0\),更新 1,未变 0,失败 0/);
  assert.match(output, /工作区: 白名单 \(全部\);排除 \(无\);无 cwd 的会话 收/);
  assert.doesNotMatch(output, /会话 s-1: 修订 /, "没给 sessionId 就不报告单个会话");

  const perSession = await app.run("session_blocks_status", { sessionId: SESSION_ID });
  assert.match(perSession, /会话 s-1(「苹果会话」)?: 修订 \d+/);
  assert.match(perSession, /5 块\(4 可检索\)/);
  const absent = await app.run("session_blocks_status", { sessionId: "没这个会话" });
  assert.match(absent, /会话 没这个会话: 尚未索引/);
});

test("端到端:session_blocks_search 命中并给出 sessionId 与 seq", async () => {
  const app = await setupIndexed();
  const output = await app.run("session_blocks_search", { query: "苹果" });
  assert.match(output, /块检索「苹果」命中 2 条/);
  assert.match(output, new RegExp(SESSION_ID));
  assert.match(output, /seq=0/);
  assert.match(output, /seq=1/);
  assert.match(output, /「苹果会话」/, "默认附上会话标题");
  assert.match(output, /\[\[苹果\]\]/, "snippet 标出命中位置");
  assert.equal(app.conversation.calls.readTitleSnapshots, 1);

  const noHit = await app.run("session_blocks_search", { query: "不存在的词" });
  assert.match(noHit, /没有命中/);
  const noTitles = await app.run("session_blocks_search", { query: "苹果", titles: false });
  assert.doesNotMatch(noTitles, /「苹果会话」/);
});

test("端到端:query messages 只命中时间区间内的 agent 消息(epoch 毫秒)", async () => {
  const app = await setupIndexed();
  const output = await app.run("session_blocks_query", {
    granularity: "messages",
    eventTypes: ["assistant/message"],
    timeFrom: T.answer - 1000,
    timeTo: T.answer + 1000,
  });
  assert.match(output, /命中 1 条事件/);
  assert.match(output, /assistant\/message, seq=1/);
  assert.doesNotMatch(output, /seq=3/, "区间外的 agent 消息不该出现");
  assert.match(output, /2 块/, "seq=1 折成一条消息,带块数");

  const wide = await app.run("session_blocks_query", {
    granularity: "messages",
    eventTypes: ["assistant/message"],
  });
  assert.match(wide, /命中 2 条事件/);
});

test("端到端:query 的时间参数也接受 ISO 串", async () => {
  const app = await setupIndexed();
  const output = await app.run("session_blocks_query", {
    granularity: "messages",
    eventTypes: ["assistant/message"],
    timeFrom: new Date(T.answer - 1000).toISOString(),
    timeTo: new Date(T.answer + 1000).toISOString(),
  });
  assert.match(output, /命中 1 条事件/);
  assert.match(output, /seq=1/);
});

test("端到端:query blocks 命中思考块(不走倒排的元数据查询)", async () => {
  const app = await setupIndexed();
  const batchBefore = app.logReader.calls.batch;
  const output = await app.run("session_blocks_query", { blockTypes: ["reasoning"], lengthMin: 1, lengthMax: 20 });
  assert.match(output, /命中 1 个块/);
  assert.match(output, /reasoning/);
  assert.match(output, /未进倒排/);
  assert.match(output, new RegExp(`${SESSION_ID}#1#0`), "带上块 id,供下一步按块读正文");
  assert.equal(app.logReader.calls.batch, batchBefore, "二次查询不该再读日志:物理身份没变");

  const outOfRange = await app.run("session_blocks_query", { blockTypes: ["reasoning"], lengthMin: 100 });
  assert.match(outOfRange, /没有符合条件的块/);
});

test("端到端:read 按 blockId 取回正文(含 block_text 里的思考块)", async () => {
  const app = await setupIndexed();
  const listed = await app.run("session_blocks_query", { blockTypes: ["reasoning"] });
  const blockId = listed.match(/([^\s#]+#\d+#[\d.]+)/)[1];
  assert.equal(blockId, `${SESSION_ID}#1#0`);

  const output = await app.run("session_blocks_read", { blockId });
  assert.match(output, /reasoning/);
  assert.match(output, /先想一下关键词/);
  assert.match(output, /7 字/);
  assert.match(output, /未进倒排/);
});

test("端到端:read 按 sessionId+seq 走官方 readEvent", async () => {
  const app = await setupIndexed();
  const output = await app.run("session_blocks_read", { sessionId: SESSION_ID, seq: 1 });
  assert.match(output, /会话 s-1 seq=1 的块\(2 个\)/);
  assert.match(output, /path=0 type=reasoning/);
  assert.match(output, /先想一下关键词/);
  assert.match(output, /path=1 type=text/);
  assert.match(output, /苹果 在这里/);
  assert.equal(app.conversation.calls.readEvent, 1, "这条路不依赖索引,走 conversation.readEvent");

  const onlyReasoning = await app.run("session_blocks_read", { sessionId: SESSION_ID, seq: 1, path: "0" });
  assert.match(onlyReasoning, /块\(1 个\)/);
  assert.doesNotMatch(onlyReasoning, /苹果 在这里/);
});

test("端到端:list 列出会话的块(含无正文块)", async () => {
  const app = await setupIndexed();
  const output = await app.run("session_blocks_list", { sessionId: SESSION_ID });
  assert.match(output, /会话 s-1 的块\(5 个\)/);
  assert.match(output, new RegExp(`${SESSION_ID}#0#0`));
  assert.match(output, new RegExp(`${SESSION_ID}#1#0`));
  assert.match(output, /不入倒排/, "思考块要标出来");

  const unknown = await app.run("session_blocks_list", { sessionId: "没这个会话" });
  assert.match(unknown, /没有块/, "列表里没有的会话列不出块,也不该抛");
});

test("端到端:workspaces 工具按工作区清点会话", async () => {
  const app = await setupIndexed();
  const byWorkspace = await app.run("session_blocks_workspaces", {});
  assert.match(byWorkspace, /索引覆盖 1 个工作区/);
  assert.match(byWorkspace, /C:\\fake\\alpha/);
  assert.match(byWorkspace, /1 个会话/);
  assert.match(byWorkspace, /5 块/);

  const bySession = await app.run("session_blocks_workspaces", { groupBy: "session" });
  assert.match(bySession, /命中 1 个已索引会话/);
  assert.match(bySession, new RegExp(SESSION_ID));
  assert.match(bySession, /4 事件/);
  assert.match(bySession, /5 块/);
});

test("端到端:参数缺失或非法时返回 ERROR 字符串而不是抛异常", async () => {
  const app = await setupIndexed();
  const cases = [
    ["session_blocks_search", {}, "ERROR: query 参数必填"],
    ["session_blocks_search", { query: "   " }, "ERROR: query 参数必填"],
    ["session_blocks_list", {}, "ERROR: sessionId 参数必填"],
    ["session_blocks_read", {}, "ERROR: 需要 sessionId + seq,或直接给 blockId"],
    ["session_blocks_read", { sessionId: SESSION_ID }, "ERROR: seq 参数必填(整数)"],
    ["session_blocks_read", { sessionId: SESSION_ID, seq: 1.5 }, "ERROR: seq 参数必填(整数)"],
  ];
  for (const [toolName, args, expected] of cases) {
    const outcome = await app.run(toolName, args);
    assert.equal(typeof outcome, "string", `${toolName} 应当返回字符串`);
    assert.ok(outcome.startsWith("ERROR: "), `${toolName} 的返回值要以 "ERROR: " 开头,实际:${outcome}`);
    assert.equal(outcome, expected);
  }

  const missing = await app.run("session_blocks_read", { blockId: `${SESSION_ID}#99#0` });
  assert.ok(missing.startsWith("ERROR: 索引里没有块"), missing);

  // 会话查询服务缺席时,读事件这条路要说不清楚原因,而不是崩。
  const ctx = fakeCtx(undefined);
  await apply(ctx, { path: ":memory:" });
  const noService = await ctx._tools.get("session_blocks_read").execute({ sessionId: SESSION_ID, seq: 1 }, {});
  assert.equal(noService, "ERROR: 没有可用的会话查询服务(ctx.sessionQuery)");
  const noServiceSearch = await ctx._tools.get("session_blocks_search").execute({ query: "苹果" }, {});
  assert.ok(noServiceSearch.startsWith("ERROR: 没有可用的会话查询服务"), noServiceSearch);
});

test("normalizeOptions:默认库路径落在 DSH_HOME 下", () => {
  const original = process.env.DSH_HOME;
  const fakeHome = path.join(os.tmpdir(), "bsq-fake-dsh-home");
  try {
    process.env.DSH_HOME = fakeHome;
    assert.equal(normalizeOptions({}).path, path.join(fakeHome, "session-blocks.db"));
    assert.equal(normalizeOptions({ path: "  " }).path, path.join(fakeHome, "session-blocks.db"), "空白路径等于没配");
    assert.equal(normalizeOptions({ path: "  D:/tmp/x.db  " }).path, "D:/tmp/x.db", "显式路径优先并去掉首尾空白");

    delete process.env.DSH_HOME;
    assert.equal(normalizeOptions({}).path, path.join(os.homedir(), ".dsh", "session-blocks.db"), "拿不到 DSH_HOME 就退到用户主目录");
  } finally {
    if (original === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = original;
  }
});

test("normalizeOptions:非法 journalMode 落回默认;不再有 openAt 这个旋钮", () => {
  assert.equal(normalizeOptions({}).journalMode, "wal");
  assert.equal(normalizeOptions({ journalMode: "delete" }).journalMode, "delete");
  assert.equal(normalizeOptions({ journalMode: "bogus" }).journalMode, "wal");
  // openAt 是官方 session-query-sqlite 的配置词汇,本插件不抄它:
  // 传进来也当没看见,绝不会出现在归一化结果里。
  assert.equal("openAt" in normalizeOptions({ openAt: "never" }), false);
  assert.equal("openAt" in normalizeOptions(null), false);
});

test("normalizeOptions:maxLimit / defaultLimit 夹取正确", () => {
  assert.equal(normalizeOptions({}).maxLimit, 100);
  assert.equal(normalizeOptions({ maxLimit: 5000 }).maxLimit, 1000);
  assert.equal(normalizeOptions({ maxLimit: 0 }).maxLimit, 1);
  assert.equal(normalizeOptions({ maxLimit: "abc" }).maxLimit, 100);

  assert.equal(normalizeOptions({}).defaultLimit, 20);
  assert.equal(normalizeOptions({ defaultLimit: 500, maxLimit: 50 }).defaultLimit, 50, "defaultLimit 不能超过 maxLimit");
  assert.equal(normalizeOptions({ defaultLimit: 0 }).defaultLimit, 1);
  assert.equal(normalizeOptions({ defaultLimit: "abc" }).defaultLimit, 20);

  assert.equal(normalizeOptions({ recheckMs: -5 }).recheckMs, 0);
  assert.equal(normalizeOptions({ recheckMs: 1e12 }).recheckMs, 86400000);
  assert.equal(normalizeOptions({ maxSessionsPerReconcile: 999999 }).maxSessionsPerReconcile, 100000);
  assert.equal(normalizeOptions({ snippetTokens: 999 }).snippetTokens, 200);
});

test("normalizeOptions:include 与 DEFAULT_INCLUDE 合并,工作区开关有默认值", () => {
  assert.deepEqual(normalizeOptions({}).include, DEFAULT_INCLUDE);
  assert.deepEqual(
    normalizeOptions({ include: { reasoning: true } }).include,
    { ...DEFAULT_INCLUDE, reasoning: true },
    "只覆盖给出来的开关,其余保持默认",
  );
  assert.deepEqual(normalizeOptions({ include: "text" }).include, DEFAULT_INCLUDE, "include 不是对象就退回默认");
  assert.equal(normalizeOptions({}).includeCold, true);
  assert.equal(normalizeOptions({ includeCold: false }).includeCold, false);
  // reconcileOnSearch 是三态:background(默认,检索永不等待) / await(检索等这一轮) / off。
  // 回退值必须与 DEFAULTS 同源——默认值改了而回退没改,等于没改(踩过的坑)。
  assert.equal(normalizeOptions({}).reconcileOnSearch, "background");
  assert.equal(normalizeOptions({ reconcileOnSearch: "await" }).reconcileOnSearch, "await");
  assert.equal(normalizeOptions({ reconcileOnSearch: "background" }).reconcileOnSearch, "background");
  assert.equal(normalizeOptions({ reconcileOnSearch: false }).reconcileOnSearch, "off");
  assert.equal(normalizeOptions({ reconcileOnSearch: "off" }).reconcileOnSearch, "off");
  assert.equal(normalizeOptions({ reconcileOnSearch: "别的东西" }).reconcileOnSearch, "background", "认不出来就当默认");
  assert.match(normalizeOptions({}).logFile, /logs[/\\]session-blocks\.log$/, "诊断日志默认落 DSH_HOME/logs");
  assert.equal(normalizeOptions({ logFile: "off" }).logFile, "");
  assert.equal(normalizeOptions({}).backgroundReconcileMs, 30000);
  assert.equal(normalizeOptions({ backgroundReconcileMs: 0 }).backgroundReconcileMs, 0, "0 = 关掉后台定时,靠检索触发");
  assert.equal(normalizeOptions({ backgroundReconcileMs: 5 }).backgroundReconcileMs, 5);
  assert.equal(normalizeOptions({}).yieldEverySessions, 1);
  assert.equal(normalizeOptions({ yieldEverySessions: 0 }).yieldEverySessions, 0, "0 = 不让出");
  assert.deepEqual(normalizeOptions({ includeWorkspaces: [" D:\\dev ", ""] }).includeWorkspaces, ["D:\\dev"]);
  assert.deepEqual(normalizeOptions({ excludeWorkspaces: "D:\\dev" }).excludeWorkspaces, [], "类型不对就当没配");
  assert.equal(normalizeOptions({}).includeWithoutWorkspace, true);
  assert.equal(normalizeOptions({ includeWithoutWorkspace: false }).includeWithoutWorkspace, false);
});

test("normalizeOptions:没有数据支撑的向量参数都是配置项", () => {
  const defaults = normalizeOptions({});
  assert.equal(defaults.memoryVectors.rrfConstant, 60);
  assert.equal(defaults.memoryVectors.candidateFactor, 4);
  assert.equal(defaults.memoryVectors.candidateFloor, 40);
  assert.equal(defaults.memoryVectors.relevanceMode, "lane-normalized");
  assert.equal(defaults.memoryVectors.chunkChars, 12000);
  assert.equal(defaults.memoryVectors.chunkOverlap, 200);
  assert.equal(defaults.memoryVectors.imageMaxBytes, 16 * 1024 * 1024);
  assert.equal(defaults.memoryRecall.order, "relevance-first");
  assert.deepEqual(defaults.passiveRecall.minSimilarityBySource, { "local-multimodal": 0.3 },
    "来源阈值只是默认表,不是写死的常量");

  const custom = normalizeOptions({
    memoryVectors: { rrfConstant: 30, candidateFactor: 2, candidateFloor: 10, relevanceMode: "fusion",
      chunkChars: 2000, chunkOverlap: 5000, imageMaxBytes: 4096 },
    memoryRecall: { order: "fresh-first" },
    passiveRecall: { minSimilarity: 0.2, minSimilarityBySource: { "remote-embed": 0.6 } },
  });
  assert.equal(custom.memoryVectors.rrfConstant, 30);
  assert.equal(custom.memoryVectors.candidateFactor, 2);
  assert.equal(custom.memoryVectors.relevanceMode, "fusion");
  assert.equal(custom.memoryVectors.chunkChars, 2000);
  assert.equal(custom.memoryVectors.chunkOverlap, 1999, "重叠必须小于分片");
  assert.equal(custom.memoryVectors.imageMaxBytes, 4096);
  assert.equal(custom.memoryRecall.order, "fresh-first");
  assert.equal(custom.passiveRecall.minSimilarity, 0.2);
  assert.deepEqual(custom.passiveRecall.minSimilarityBySource,
    { "local-multimodal": 0.3, "remote-embed": 0.6 }, "按来源的阈值是合并,不是整表替换");
  assert.equal(normalizeOptions({ memoryVectors: { relevanceMode: "别的东西" } }).memoryVectors.relevanceMode, "lane-normalized");
});

test("toEpochMs:毫秒数与 ISO 串都认,认不出来返回 undefined", () => {
  assert.equal(toEpochMs(1700000000000), 1700000000000);
  assert.equal(toEpochMs(1700000000000.7), 1700000000000, "小数毫秒取整");
  assert.equal(toEpochMs("1700000000000"), 1700000000000, "数字字符串也当毫秒");
  assert.equal(toEpochMs("2026-09-14T10:00:00Z"), Date.parse("2026-09-14T10:00:00Z"));
  assert.equal(toEpochMs("  2026-09-14T10:00:00Z  "), Date.parse("2026-09-14T10:00:00Z"));
  assert.equal(toEpochMs("不是时间"), undefined);
  assert.equal(toEpochMs(""), undefined);
  assert.equal(toEpochMs(undefined), undefined);
  assert.equal(toEpochMs(Number.NaN), undefined);
});

test("formatHits:命中、标题、翻页提示与空结果", () => {
  const outcome = {
    hasMore: true,
    items: [{
      sessionId: "s-1",
      blockType: "text",
      seq: 3,
      path: "0",
      surface: "current",
      time: undefined,
      snippet: "第一行\n第二行",
    }],
  };
  const output = formatHits("苹果", outcome, new Map([["s-1", "苹果会话"]]));
  assert.match(output, /命中 1 条\(还有更多,用 offset 翻页\)/);
  assert.match(output, /1\. s-1「苹果会话」 {2}\[text, seq=3, path=0, current\]/);
  assert.match(output, /第一行 第二行/, "snippet 里的换行要压成空格");
  assert.equal(formatHits("苹果", { items: [], hasMore: false }), "块检索「苹果」没有命中(索引里没有匹配的块)。");
  assert.doesNotMatch(formatHits("苹果", { items: [], hasMore: false }), /offset/);
});

test("formatMessages:命中与空结果", () => {
  const outcome = {
    hasMore: false,
    items: [{
      sessionId: "s-1",
      eventType: "assistant/message",
      seq: 1,
      surface: "current",
      time: undefined,
      blocks: 2,
      totalLength: 13,
    }],
  };
  const output = formatMessages(outcome, new Map([["s-1", "苹果会话"]]));
  assert.match(output, /命中 1 条事件:/);
  assert.match(output, /1\. s-1「苹果会话」 {2}\[assistant\/message, seq=1, 2 块, 13 字, current\]/);
  assert.doesNotMatch(output, /翻页/);
  assert.equal(formatMessages({ items: [], hasMore: false }), "没有符合条件的事件。");
});

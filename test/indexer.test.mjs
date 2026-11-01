// test/indexer.test.mjs — 对账逻辑测试:用假 conversation 服务 + :memory: 库,不碰 DSH 源码。
//
// 假服务只实现本插件真正调用的那几件事:listSessions / listEvents / readSession。
// 每个用例都靠调用计数器断言“有没有做多余的读取”,这是对账逻辑最要紧的性质。
import test from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../lib/store.js";
import { createIndexer, INDEXER_DEFAULTS } from "../lib/indexer.js";

const T0 = 1700000000000;

// 假的工作区路径:只是测试数据,不指向本机任何真实目录。
const WORKSPACE_A = "C:\\fake\\alpha";
const WORKSPACE_B = "C:\\fake\\beta";

/** 用户消息事件(正文在 data.content)。 */
function userEvent(seq, text, time = T0) {
  return { seq, type: "user/message", time, data: { content: [{ type: "text", text }] } };
}

/** 助手消息事件(正文在 data.message.content)。 */
function assistantEvent(seq, { reasoning, text } = {}, time = T0 + 1000) {
  const content = [];
  if (reasoning) content.push({ type: "reasoning", text: reasoning });
  if (text) content.push({ type: "text", text });
  return { seq, type: "assistant/message", time, data: { message: { content } } };
}

/** 由完整事件推出 listEvents 的轻量记录(seq/type/time/surface)。 */
function recordsOf(events, surface = "current") {
  return events.map((event) => ({ seq: event.seq, type: event.type, time: event.time, surface }));
}

/**
 * 造一个假 conversation 服务,并统计每个方法被调了几次。
 * @param entries - `[{ id, live, persisted, cwd, events, records, readError }]`。
 */
function createConversation(entries) {
  const state = new Map();
  for (const entry of entries) state.set(entry.id, { ...entry, events: [...(entry.events ?? [])] });
  const calls = { listSessions: 0, listEvents: 0, readSession: 0, listEventsById: new Map(), readSessionById: new Map() };
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  return {
    state,
    calls,
    async listSessions() {
      calls.listSessions += 1;
      return [...state.values()].map((entry) => ({
        header: { id: entry.id, cwd: entry.cwd },
        live: entry.live === true,
        persisted: entry.persisted !== false,
      }));
    },
    async listEvents(id) {
      calls.listEvents += 1;
      bump(calls.listEventsById, id);
      const entry = state.get(id);
      if (entry === undefined) throw new Error(`未知会话 ${id}`);
      return entry.records ?? recordsOf(entry.events);
    },
    async readSession(id) {
      calls.readSession += 1;
      bump(calls.readSessionById, id);
      const entry = state.get(id);
      if (entry?.readError) throw new Error(entry.readError);
      return { session: { id }, inheritedEventCount: 0, events: entry.events };
    },
  };
}

/**
 * 造一个假的日志源,接口与 lib/log-source.js 一致。
 *
 * 用事件数代替字节数当"文件大小":增量判据只看它涨没涨,量纲不重要。
 * 这里刻意不引入真实文件:索引逻辑该被测的是"读到哪、写了什么",不是文件 IO。
 * @param entries - [{ id, events, readError }]。
 */
function createLogReader(state) {
  const calls = { locate: 0, stat: 0, batch: 0, statById: new Map(), batchById: new Map() };
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  const idOf = (path) => path.replace("fake://", "");
  return {
    calls,
    locateSessionLog(id) {
      calls.locate += 1;
      const entry = state.get(id);
      if (entry === undefined || entry.noLog === true) return undefined;
      return "fake://" + id;
    },
    statSessionLog(path) {
      calls.stat += 1;
      bump(calls.statById, idOf(path));
      const entry = state.get(idOf(path));
      if (entry === undefined) throw new Error("没有这份日志 " + path);
      return { size: (entry.events ?? []).length };
    },
    readSessionBatch(path, offset, limit) {
      calls.batch += 1;
      bump(calls.batchById, idOf(path));
      const entry = state.get(idOf(path));
      if (entry === undefined) throw new Error("没有这份日志 " + path);
      if (entry.readError) throw new Error(entry.readError);
      const all = entry.events ?? [];
      const events = all.slice(offset, offset + limit);
      const nextOffset = offset + events.length;
      return { events, nextOffset, done: nextOffset >= all.length, torn: false };
    },
  };
}
/** 造一个对账器(自带内存库与日志收集)。 */
async function setupIndexer(entries, options = {}) {
  const conversation = createConversation(entries);
  const logReader = createLogReader(conversation.state);
  const store = await openStore({ path: ":memory:" });
  const logs = [];
  const indexer = createIndexer({ conversation, logReader, store, options, log: (message) => logs.push(message) });
  return { conversation, logReader, store, indexer, logs, options };
}

/** 摘要里与对账语义有关的那几个字段(库里可能还会加别的计数,这里只钉住这五个)。 */
function core(summary) {
  return {
    listed: summary.listed,
    planned: summary.planned,
    updated: summary.updated,
    unchanged: summary.unchanged,
    errors: summary.errors,
  };
}

test("reconcile:首次把会话索引进去,块数正确", async () => {
  const { logReader, store, indexer, logs } = await setupIndexer([{
    id: "c1",
    events: [userEvent(0, "第一问"), assistantEvent(1, { reasoning: "先想一下", text: "第一答" })],
  }]);

  assert.deepEqual(core(await indexer.reconcile()), { listed: 1, planned: 1, updated: 1, unchanged: 0, errors: 0 });
  const stats = store.stats();
  assert.equal(stats.sessions, 1);
  assert.equal(stats.blocks, 3, "2 个 text 块 + 1 个 reasoning 块");
  assert.equal(stats.searchable, 2, "思考块默认不进倒排");
  assert.equal(stats.storedTexts, 1, "思考块正文另存");
  assert.equal(store.getSession("c1").events, 2, "簿记里记的是轻量事件条数");
  assert.equal(store.search({ query: "第一答" }).items.length, 1);
  assert.equal(store.queryBlocks({ blockTypes: ["reasoning"], withText: true }).items[0].text, "先想一下");
  assert.ok(logs.some((line) => line.includes("已索引会话 c1")), "重建时要留一条日志");
  store.close();
});

test("reconcile:同样数据再跑一次是 unchanged,不重读 readSession", async () => {
  const { conversation, logReader, store, indexer } = await setupIndexer(
    [{ id: "c1", events: [userEvent(0, "第一问"), assistantEvent(1, { text: "第一答" })] }],
    { recheckMs: 0 },
  );
  await indexer.reconcile();
  const checked = Number(store.getSession("c1").checked_ms);

  const summary = await indexer.reconcile();
  assert.deepEqual(core(summary), { listed: 1, planned: 1, updated: 0, unchanged: 1, errors: 0 });
  assert.equal(summary.excluded, 0, "没有工作区排除规则时不该排除任何会话");
  assert.equal(logReader.calls.stat, 2, "每轮都要看一眼日志长度");
  assert.equal(logReader.calls.batch, 1, "长度没变就不该再读事件");
  assert.equal(store.generation(), 1, "markChecked 只更新时间戳,不推进世代");
  assert.ok(Number(store.getSession("c1").checked_ms) >= checked, "检查时间被刷新,TTL 因此重新计时");
  store.close();
});

test("reconcile:listEvents 的轻量记录变了就重建该会话", async () => {
  const { conversation, logReader, store, indexer } = await setupIndexer(
    [{ id: "c1", events: [userEvent(0, "第一问")] }],
    { recheckMs: 0 },
  );
  await indexer.reconcile();
  assert.equal(store.stats().blocks, 1);

  conversation.state.get("c1").events.push(userEvent(1, "第二问", T0 + 1000));
  const summary = await indexer.reconcile();
  assert.deepEqual(core(summary), { listed: 1, planned: 1, updated: 1, unchanged: 0, errors: 0 });
  assert.equal(logReader.calls.batch, 2);
  assert.equal(store.stats().blocks, 2, "旧块被整体替换");
  assert.equal(store.getSession("c1").events, 2);
  assert.equal(store.search({ query: "第二问" }).items.length, 1);
  store.close();
});

test("reconcile:实时会话忽略 TTL 每次都查,冷会话在 TTL 内不查", async () => {
  const { logReader, indexer } = await setupIndexer(
    [
      { id: "live", live: true, events: [userEvent(0, "实时会话")] },
      { id: "cold", live: false, events: [userEvent(0, "冷会话")] },
    ],
    { recheckMs: 10_000_000 },
  );

  assert.deepEqual(core(await indexer.reconcile()), { listed: 2, planned: 2, updated: 2, unchanged: 0, errors: 0 });
  assert.deepEqual(
    core(await indexer.reconcile()),
    { listed: 2, planned: 1, updated: 0, unchanged: 1, errors: 0 },
    "冷会话还在 TTL 内,只剩实时会话要查",
  );
  assert.equal(logReader.calls.statById.get("live"), 2);
  assert.equal(logReader.calls.statById.get("cold"), 1);
  assert.equal(logReader.calls.batch, 2, "两轮都没有真重建:日志长度一致");
});

test("reconcile:recheckMs 很大的冷会话在 TTL 内被整轮跳过(planned=0)", async () => {
  const { conversation, logReader, store, indexer } = await setupIndexer(
    [{ id: "cold", live: false, events: [userEvent(0, "冷会话")] }],
    { recheckMs: 10_000_000 },
  );
  await indexer.reconcile();

  assert.deepEqual(core(await indexer.reconcile()), { listed: 1, planned: 0, updated: 0, unchanged: 0, errors: 0 });
  assert.equal(logReader.calls.stat, 1, "跳过就一点都不读");
  assert.equal(store.generation(), 1);
  store.close();
});

test("reconcile:force 忽略修订指纹与 TTL", async () => {
  const { conversation, logReader, store, indexer } = await setupIndexer(
    [{ id: "cold", live: false, events: [userEvent(0, "冷会话")] }],
    { recheckMs: 10_000_000 },
  );
  await indexer.reconcile();
  assert.equal(logReader.calls.batch, 1);

  assert.deepEqual(
    core(await indexer.reconcile({ force: true })),
    { listed: 1, planned: 1, updated: 1, unchanged: 0, errors: 0 },
  );
  assert.equal(logReader.calls.batch, 2, "force 下即使长度没变也重读事件");
  assert.equal(store.generation(), 2);
  store.close();
});

test("reconcile:sessionIds 过滤只处理指定会话", async () => {
  const { conversation, logReader, store, indexer } = await setupIndexer([
    { id: "a", events: [userEvent(0, "会话甲")] },
    { id: "b", events: [userEvent(0, "会话乙")] },
  ]);

  const summary = await indexer.reconcile({ sessionIds: ["a"] });
  assert.deepEqual(
    core(summary),
    { listed: 2, planned: 1, updated: 1, unchanged: 0, errors: 0 },
    "listed 仍是列表总数",
  );
  assert.ok(store.getSession("a") !== undefined);
  assert.equal(store.getSession("b"), undefined);
  assert.equal(logReader.calls.batchById.get("b"), undefined);
  store.close();
});

test("reconcile:maxSessionsPerReconcile 限制本轮数量", async () => {
  const entries = [
    { id: "a", events: [userEvent(0, "会话甲")] },
    { id: "b", events: [userEvent(0, "会话乙")] },
    { id: "c", events: [userEvent(0, "会话丙")] },
  ];
  const { conversation, logReader, store, indexer } = await setupIndexer(entries, { maxSessionsPerReconcile: 1 });

  const first = await indexer.reconcile();
  assert.equal(first.planned, 3, "计划里是全部待查会话");
  assert.equal(first.updated, 1, "但本轮只做前 1 个");
  assert.equal(logReader.calls.batch, 1);

  const second = await indexer.reconcile({ maxSessions: 2, force: true });
  assert.equal(second.planned, 3);
  assert.equal(second.updated, 2, "请求参数可以覆盖配置");
  assert.equal(logReader.calls.batch, 3);
  assert.equal(store.stats().sessions, 2, "两轮各做一部分:第一轮 a,第二轮 a + b");

  const third = await indexer.reconcile({ maxSessions: 10, force: true });
  assert.equal(third.updated, 3);
  assert.deepEqual(store.querySessions({}).items.map((item) => item.sessionId).sort(), ["a", "b", "c"]);
  store.close();
});

test("reconcile:某个会话读正文失败时其他会话照常索引,errors 计数 +1", async () => {
  const { logReader, store, indexer, logs } = await setupIndexer([
    { id: "bad", readError: "读正文炸了", events: [userEvent(0, "坏会话")] },
    { id: "good", events: [userEvent(0, "好会话")] },
  ]);

  const summary = await indexer.reconcile();
  assert.deepEqual(core(summary), { listed: 2, planned: 2, updated: 1, unchanged: 0, errors: 1 });
  assert.equal(store.getSession("bad"), undefined, "失败的会话不进索引");
  assert.equal(store.getSession("good") !== undefined, true, "后面的会话不受影响");
  assert.equal(store.search({ query: "好会话" }).items.length, 1);
  assert.ok(logs.some((line) => line.includes("读正文炸了")), "失败原因要进日志");
  store.close();
});

test("reconcileOne:索引指定会话;列表里没有的会话会被清出索引", async () => {
  const { conversation, logReader, store, indexer } = await setupIndexer([{ id: "c1", events: [userEvent(0, "唯一会话")] }]);

  assert.equal(await indexer.reconcileOne("c1"), "updated", "默认 force:按 id 精确刷新就重读正文");
  assert.equal(store.stats().sessions, 1);
  assert.equal(store.search({ query: "唯一会话" }).items.length, 1);

  conversation.state.delete("c1");
  assert.equal(await indexer.reconcileOne("c1"), "skipped");
  assert.equal(store.getSession("c1"), undefined, "会话没了就删掉陈旧块");
  assert.equal(store.stats().blocks, 0);
  assert.equal(store.search({ query: "唯一会话" }).items.length, 0);

  assert.equal(await indexer.reconcileOne("从未索引过"), "skipped", "本来就没有索引也不报错");
  store.close();
});

test("reconcile:include 打开 reasoning 后思考块进倒排", async () => {
  const { logReader, store, indexer } = await setupIndexer(
    [{ id: "c1", events: [assistantEvent(0, { reasoning: "内部思考内容", text: "对外回答" })] }],
    { include: { reasoning: true } },
  );
  await indexer.reconcile();
  assert.equal(store.stats().searchable, 2);
  assert.equal(store.search({ query: "内部思考内容" }).items.length, 1);
  store.close();
});

test("reconcile:会话头的 cwd 写进索引,可按工作区查", async () => {
  const { logReader, store, indexer } = await setupIndexer([
    { id: "w1", cwd: WORKSPACE_A, events: [userEvent(0, "工作区甲 的会话")] },
    { id: "w2", cwd: WORKSPACE_B, events: [userEvent(0, "工作区乙 的会话")] },
    { id: "w3", events: [userEvent(0, "没有 cwd 的会话")] },
  ]);
  await indexer.reconcile();

  assert.equal(store.getSession("w1").cwd, WORKSPACE_A);
  assert.equal(store.getSession("w3").cwd, null, "header 里没有 cwd 就记 NULL");
  assert.equal(store.queryBlocks({ cwds: [WORKSPACE_A] }).items.length, 1);
  assert.deepEqual(store.querySessions({ cwds: [WORKSPACE_A] }).items.map((item) => item.sessionId), ["w1"]);
  assert.deepEqual(
    store.queryWorkspaces({}).items.map((item) => item.cwd).sort(),
    [WORKSPACE_A, WORKSPACE_B, null].sort(),
  );
  store.close();
});

test("reconcile:被排除的工作区不进索引,已索引的残留会被清掉", async () => {
  const { conversation, logReader, store, logs } = await setupIndexer([
    { id: "keep", cwd: WORKSPACE_A, events: [userEvent(0, "保留的会话")] },
    { id: "drop", cwd: WORKSPACE_B, events: [userEvent(0, "要排除的会话")] },
  ]);
  const all = createIndexer({ conversation, logReader, store, options: { recheckMs: 0 }, log: (message) => logs.push(message) });
  await all.reconcile();
  assert.ok(store.getSession("drop") !== undefined, "没配排除规则时两个会话都索引");

  const filtered = createIndexer({
    conversation,
    logReader,
    store,
    options: { recheckMs: 0, excludeWorkspaces: [WORKSPACE_B] },
    log: (message) => logs.push(message),
  });
  const summary = await filtered.reconcile();
  assert.equal(summary.excluded, 1, "被排除的会话计入 excluded");
  assert.equal(store.getSession("drop"), undefined, "已经在索引里的也要清掉,否则排除只对新会话生效");
  assert.ok(store.getSession("keep") !== undefined);
  assert.equal(store.search({ query: "要排除的会话" }).items.length, 0);
  store.close();
});

test("第一相:日志长度没变就整轮跳过,变长了才续读", async () => {
  const entries = [{ id: "t1", events: [userEvent(0, "第一版正文")] }];
  const { conversation, logReader, store, indexer } = await setupIndexer(entries, { recheckMs: 0 });

  await indexer.reconcile();
  const afterFirst = logReader.calls.batch;
  assert.equal(afterFirst, 1, "首次索引要读一次日志");

  const second = await indexer.reconcile();
  assert.equal(second.unchanged, 1, "日志长度没变 → unchanged");
  assert.equal(logReader.calls.batch, afterFirst, "长度没变就不许再读事件");
  assert.equal(logReader.calls.stat, 2, "但每轮都要看一次文件长度");

  conversation.state.get("t1").events.push(userEvent(1, "第二版正文", T0 + 1000));
  const third = await indexer.reconcile();
  assert.equal(third.updated, 1, "日志变长了 → 续读");
  assert.equal(logReader.calls.batch, afterFirst + 1, "只读新长出来的那一段");
  assert.equal(store.search({ query: "第二版正文" }).items.length, 1);
  store.close();
});
test("清单缓存:TTL 内复用,失效后重取,Ttl=0 时每轮都取", async () => {
  const { conversation, logReader, store, indexer } = await setupIndexer([
    { id: "c1", events: [userEvent(0, "正文")] },
  ], { recheckMs: 0, listingTtlMs: 60000 });
  await indexer.reconcile();
  const afterFirst = conversation.calls.listSessions;
  await indexer.reconcile();
  assert.equal(conversation.calls.listSessions, afterFirst, "TTL 内不重复取清单");
  indexer.invalidateListing();
  await indexer.reconcile();
  assert.equal(conversation.calls.listSessions, afterFirst + 1, "失效后必须重取");
  const fresh = createIndexer({
    conversation,
    store,
    options: { recheckMs: 0, listingTtlMs: 0 },
    log: () => {},
  });
  const before = conversation.calls.listSessions;
  await fresh.reconcile();
  assert.equal(conversation.calls.listSessions, before + 1, "TTL=0 = 每轮都取");
  store.close();
});

test("归档会话:默认不索引(已索引的会清掉),includeArchived 打开才收", async () => {
  const conversation = createConversation([
    { id: "keep", events: [userEvent(0, "正常会话")] },
    { id: "arch", events: [userEvent(0, "归档会话")] },
  ]);
  const store = await openStore({ path: ":memory:" });
  const logReader = createLogReader(conversation.state);
  let archived = ["arch"];
  const indexer = createIndexer({
    conversation,
    logReader,
    store,
    options: { recheckMs: 0 },
    log: () => {},
    archivedIds: () => archived,
  });

  const first = await indexer.reconcile();
  assert.equal(first.archived, 1, "摘要要报出被跳过的归档会话数");
  assert.equal(first.updated, 1, "只索引没归档的那个");
  assert.ok(store.getSession("keep") !== undefined);
  assert.equal(store.getSession("arch"), undefined, "归档的压根不进索引");
  assert.equal(logReader.calls.batchById.get("arch"), undefined, "归档的连日志都不读");

  // 先索引、再归档:下一轮要把已经进索引的清掉(取消归档后自然再回来)。
  archived = [];
  await indexer.reconcile();
  assert.ok(store.getSession("arch") !== undefined, "取消归档后重新进索引");
  archived = ["arch", "keep"];
  const third = await indexer.reconcile();
  assert.equal(third.archived, 2);
  assert.equal(store.getSession("arch"), undefined, "归档后已索引的也要清掉");
  assert.equal(store.getSession("keep"), undefined);

  const all = createIndexer({
    conversation,
    logReader,
    store,
    options: { recheckMs: 0, includeArchived: true },
    log: () => {},
    archivedIds: () => archived,
  });
  const fourth = await all.reconcile();
  assert.equal(fourth.archived, 0, "打开开关就不算归档跳过");
  assert.ok(store.getSession("arch") !== undefined && store.getSession("keep") !== undefined);
  store.close();
});

test("createIndexer:配置与默认值合并", async () => {
  const { indexer } = await setupIndexer([], { recheckMs: 1234 });
  assert.equal(indexer.config.recheckMs, 1234, "显式配置覆盖默认值");
  assert.equal(indexer.config.maxSessionsPerReconcile, INDEXER_DEFAULTS.maxSessionsPerReconcile);
  assert.equal(indexer.config.includeCold, INDEXER_DEFAULTS.includeCold);
  assert.equal(indexer.config.failureCooldownMs, INDEXER_DEFAULTS.failureCooldownMs);
});

test("计划:实时已索引会话再多,也得给从未索引的会话留名额(进度卡死在 111/1489 的根因)", async () => {
  // 六个实时会话:它们每轮都"到期",又排在列表头部——不保底就会把名额吃光。
  const live = Array.from({ length: 6 }, (_, i) => ({
    id: `live-${i}`,
    live: true,
    events: [userEvent(0, `实时会话 ${i} 的内容`)],
  }));
  const { conversation, logReader, store, indexer } = await setupIndexer(live, { maxSessionsPerReconcile: 4 });
  const first = await indexer.reconcile({ maxSessions: 10 });
  assert.equal(first.updated, 6, "先把六个实时会话都索引进去");

  // 再来两个从未索引过的冷会话(排在列表后面)。
  for (const id of ["cold-1", "cold-2"]) {
    conversation.state.set(id, { id, live: false, events: [userEvent(0, `${id} 的正文`)] });
  }
  indexer.invalidateListing(); // 刚建出来的会话要先让清单缓存失效,否则看不见
  const second = await indexer.reconcile();
  assert.equal(second.backlog, 2, "摘要要报出待补数量");
  assert.equal(second.updated, 2, "名额的一半必须留给从未索引的会话");
  assert.ok(store.getSession("cold-1") !== undefined && store.getSession("cold-2") !== undefined);
  assert.ok(logReader.calls.batchById.get("cold-1") >= 1, "冷会话真的被读了");
  store.close();
});

test("计划:backlog 清空后,名额全部回到实时与到期复查", async () => {
  const { logReader, store, indexer } = await setupIndexer([
    { id: "live-a", live: true, events: [userEvent(0, "实时会话")] },
    { id: "cold-a", live: false, events: [userEvent(0, "冷会话")] },
  ], { maxSessionsPerReconcile: 4, recheckMs: 0 });
  const first = await indexer.reconcile();
  assert.equal(first.backlog, 2, "首轮两个都是从未索引");
  assert.equal(first.updated, 2);
  // recheckMs 为 0:已索引的会话仍然到期,但 backlog 已经空了。
  const second = await indexer.reconcile();
  assert.equal(second.backlog, 0, "没有待补的会话了");
  assert.equal(second.planned, 2, "名额回到实时与到期复查");
  assert.equal(second.unchanged, 2);
  assert.equal(second.updated, 0);
  store.close();
});

test("失败冷却:读不出来的会话不会每轮重试;冷却为 0 时恢复每轮重试", async () => {
  const entries = [
    { id: "ok", events: [userEvent(0, "正常会话")] },
    { id: "bad", events: [userEvent(0, "读不出来的会话")], readError: "造的读失败" },
  ];

  const cooled = await setupIndexer(entries, { failureCooldownMs: 60000, recheckMs: 600000 });
  const first = await cooled.indexer.reconcile();
  assert.equal(first.errors, 1);
  assert.equal(first.cooled, 1, "失败会话进入冷却计数");
  const second = await cooled.indexer.reconcile();
  assert.equal(second.planned, 0, "冷却期内不再进计划(ok 已索引且未到期、bad 在冷却)");
  assert.equal(second.errors, 0);
  assert.equal(cooled.logReader.calls.batchById.get("bad"), 1, "坏会话只被读了一次");
  cooled.store.close();

  const always = await setupIndexer(entries, { failureCooldownMs: 0, recheckMs: 600000 });
  await always.indexer.reconcile();
  const retried = await always.indexer.reconcile();
  assert.equal(retried.errors, 1, "冷却关掉后每轮都会重试");
  assert.equal(always.logReader.calls.batchById.get("bad"), 2);
  always.store.close();
});

// lib/memory.js — 记忆库(独立于块索引库的一个小库)
//
// 为什么单独一个库:
//   块索引是全量派生、随时可以重建的;记忆却是稀疏的、要按关键词召回、还要按新鲜度分层。
//   放进同一个库,记忆查询会被十九万块的倒排拖着走,而且每动一次 schema 都要连带迁移块索引。
//   独立成库之后:块索引重建不影响记忆,记忆库损坏也不影响检索。
//
// 记忆从哪来:
//   session_blocks_remember 这个"伪工具"自己不存任何东西——它的调用参数作为 tool-call 块
//   进了会话日志。索引器抽块时顺路把这类块解析出来写进这里。所以本库是**派生索引**,
//   真相源仍然是会话日志:删库重建 = 重跑一遍索引。
//
// 召回的两条规矩(设计定的):
//   1) 新鲜度分层:默认 2 小时内算"新鲜",过期的只在数量不够时补齐——
//      **哪怕过期那条的字面相关性更高**。字面相关性对旧记忆有系统性偏好
//      (同一话题用词重合,FTS 分数天然高),不压制的话旧记忆会稳定挤占召回位。
//   2) 当前活跃上下文里已有的会话内记忆不再返回:已经在意识里的东西不需要被"想起"。

import { splitCjk } from "./store.js";
import { migrateMemorySync, createMemorySyncAccess, memoryContentHash, rowToMemory } from "./memory-sync.js";

/** 记忆块的识别标志:tool-call 块的正文以这个工具名开头。 */
export const MEMORY_TOOL = "session_blocks_remember";

const MEMORY_APPLICATION_ID = 0x4d454d31; // "MEM1"
const MEMORY_SCHEMA_VERSION = 3;

/**
 * 记忆的视角:**三选一,模糊判断即可,不需要准确**。
 *
 * 三贤人不是三个人格,是同一个灵魂(织)在三条神经通路上的切面——共享的是同一份
 * 人格底座 $P_{base}$(大五分数与显著子维度),隔离的只是视角焦点。所以一条记忆要标的
 * 是"它在哪个我眼里最要紧",而不是"它有多重要"这类可加权求和的标量。
 *
 *   superego  职业我(超我) —— "我做事的方式"        (Melchior)
 *   ego       关系我(自我) —— "我与人相处的方式"     (Balthazar)
 *   id        本真我(本我) —— "我本能的好恶和底线"   (Casper)
 *
 * 刻意保留的模糊:这是心理测量学意义上的意象,不是精确测量。三选一、允许标得不准、
 * 不必纠结边界——"模糊地找到最合适的那个"就是它的正确用法。
 */
export const MEMORY_PERSPECTIVES = ["superego", "ego", "id"];

/**
 * 从一块里解析出记忆。
 * @param block - 索引器抽出来的块(`{ id, seq, type, text, surface, time }`)。
 * @returns `{ q, a, tag, expires, perspective }`;不是记忆块、或参数解析不出来时返回 undefined。
 */
export function parseMemoryBlock(block) {
  if (block?.type !== "tool-call") return undefined;
  const text = typeof block.text === "string" ? block.text : "";
  if (!text.startsWith(MEMORY_TOOL)) return undefined;
  const rest = text.slice(MEMORY_TOOL.length).trim();
  if (!rest.startsWith("{")) return undefined;
  let args;
  try {
    args = JSON.parse(rest);
  } catch {
    // 正文被截断或参数不是合法 JSON——当作不是记忆块,不要让一条坏数据打断整轮索引。
    return undefined;
  }
  const q = typeof args?.q === "string" ? args.q.trim() : "";
  const a = typeof args?.a === "string" ? args.a.trim() : "";
  if (q === "" || a === "") return undefined;
  return {
    q,
    a,
    tag: typeof args?.tag === "string" ? args.tag.trim() : "",
    expires: typeof args?.expires === "string" ? args.expires.trim() : "",
    // 认不出来的取值当没标——工具层已经校验过枚举,这里再宽容一次,
    // 免得将来改了取值域之后,旧记忆整条读不出来。
    perspective: MEMORY_PERSPECTIVES.includes(args?.perspective) ? args.perspective : "",
    ...(Array.isArray(args?.attachments) ? { attachments: args.attachments.filter((item) =>
      item && typeof item.path === "string" && item.path.trim() && item.type === "image"
    ).slice(0, 8).map((item) => ({ type: "image", path: item.path.trim(), ...(typeof item.sha256 === "string" ? { sha256: item.sha256 } : {}) })) } : {}),
  };
}

/**
 * 打开(必要时创建)记忆库。
 * @param options - `{ path, journalMode }`;path 支持 `:memory:`。
 * @returns 记忆库句柄。
 */
export async function openMemoryStore(options = {}) {
  const path = typeof options.path === "string" && options.path.trim() ? options.path.trim() : ":memory:";
  const journalMode = options.journalMode ?? "wal";
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (error) {
    throw new Error(`当前 Node(${process.version})没有 node:sqlite,记忆库无法建立:${
      error && error.message ? error.message : String(error)}`);
  }
  const db = new DatabaseSync(path);
  try {
    const appId = Number(db.prepare("PRAGMA application_id").get().application_id);
    const version = Number(db.prepare("PRAGMA user_version").get().user_version);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*'")
      .all()
      .map((row) => String(row.name));
    if (appId !== 0 && appId !== MEMORY_APPLICATION_ID) {
      throw new Error(`记忆库 "${path}" 属于别的应用,拒绝打开`);
    }
    if (appId === 0 && tables.length > 0) {
      throw new Error(`记忆库 "${path}" 不是本插件的派生索引(已有未知表:${tables.join(", ")}),拒绝打开`);
    }
    if (version > MEMORY_SCHEMA_VERSION) throw new Error("记忆库版本较新，拒绝降级打开或清空");
    db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`);
    if (journalMode === "wal") {
      db.exec("PRAGMA wal_autocheckpoint = 256");
      db.exec("PRAGMA journal_size_limit = 1048576");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      // 已有库先补列，随后建索引；升级不清掉历史记忆。
      if (tables.includes("memory")) migrateMemorySync(db);
      ensureSchema(db);
      migrateMemorySync(db);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return createMemoryStore(db, path);
  } catch (error) {
    db.close();
    throw error;
  }
}

function ensureSchema(db) {
  db.exec("PRAGMA application_id = " + String(MEMORY_APPLICATION_ID));
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id          INTEGER PRIMARY KEY,
      block_id    TEXT UNIQUE NOT NULL,
      session_id  TEXT NOT NULL,
      cwd         TEXT,
      seq         INTEGER NOT NULL,
      time        INTEGER NOT NULL,
      surface     TEXT,
      q           TEXT NOT NULL,
      a           TEXT NOT NULL,
      tag         TEXT,
      expires     TEXT,
      perspective TEXT,
      qa          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_time ON memory(time);
    CREATE INDEX IF NOT EXISTS idx_memory_session ON memory(session_id);
    CREATE INDEX IF NOT EXISTS idx_memory_tag ON memory(tag);
    CREATE INDEX IF NOT EXISTS idx_memory_perspective ON memory(perspective);
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(qa, tokenize = 'unicode61');
  `);
  db.exec("PRAGMA user_version = " + String(MEMORY_SCHEMA_VERSION));
}

function createMemoryStore(db, path) {
  const selectBySession = db.prepare("SELECT block_id FROM memory WHERE session_id = ?");
  const selectIdByBlock = db.prepare("SELECT * FROM memory WHERE block_id = ?");
  const columns = ["session_id", "cwd", "seq", "time", "surface", "q", "a", "tag", "expires", "perspective", "qa", "attachments", "content_hash"];
  const insertMemory = db.prepare(`
    INSERT INTO memory (block_id, ${columns.join(", ")})
    VALUES (${Array(columns.length + 1).fill("?").join(", ")})
  `);
  const updateMemory = db.prepare(`
    UPDATE memory SET ${columns.map((column) => column + " = ?").join(", ")} WHERE block_id = ?
  `);
  const deleteMemory = db.prepare("DELETE FROM memory WHERE block_id = ?");
  const deleteFtsByRowid = db.prepare("DELETE FROM memory_fts WHERE rowid = ?");
  const insertFts = db.prepare("INSERT INTO memory_fts (rowid, qa) VALUES (?, ?)");
  const lastRowid = db.prepare("SELECT last_insert_rowid() AS id");

  /**
   * 把一个会话里解析出来的记忆写进记忆库(差量:消失的删掉,留下的更新)。
   * @param request - `{ sessionId, cwd, blocks }`。
   * @returns `{ found, inserted, updated, removed }`。
   */
  function ingest({ sessionId, cwd, blocks, deleted = false }) {
    db.exec("BEGIN IMMEDIATE");
    try {
    const incoming = [];
    for (const block of Array.isArray(blocks) ? blocks : []) {
      const memory = parseMemoryBlock(block);
      if (memory !== undefined) incoming.push({ block, memory });
    }
    const before = new Set(selectBySession.all(sessionId).map((row) => String(row.block_id)));
    const alive = new Set(incoming.map((item) => String(item.block.id)));
    let removed = 0;
    for (const blockId of before) {
      if (alive.has(blockId)) continue;
      const row = selectIdByBlock.get(blockId);
      if (row !== undefined) deleteFtsByRowid.run(row.id);
      deleteMemory.run(blockId);
      removed += 1;
    }
    let inserted = 0;
    let updated = 0;
    for (const { block, memory } of incoming) {
      const qa = splitCjk(`${memory.q}\n${memory.a}`);
      const fields = [
        sessionId,
        typeof cwd === "string" && cwd !== "" ? cwd : null,
        Number(block.seq ?? 0),
        Number(block.time ?? 0),
        typeof block.surface === "string" ? block.surface : null,
        memory.q,
        memory.a,
        memory.tag === "" ? null : memory.tag,
        memory.expires === "" ? null : memory.expires,
        memory.perspective === "" ? null : memory.perspective,
        qa,
        JSON.stringify(memory.attachments ?? []),
        memoryContentHash(memory.q, memory.a, memory.attachments ?? []),
      ];
      const existing = selectIdByBlock.get(block.id);
      if (existing === undefined) {
        insertMemory.run(String(block.id), ...fields);
        insertFts.run(Number(lastRowid.get().id), qa);
        inserted += 1;
      } else if (columns.some((column, index) => existing[column] !== fields[index])) {
        // 未变化的会话不重复写FTS，也不制造无意义的向量任务。
        updateMemory.run(...fields, String(block.id));
        // FTS5 没有 upsert,只能删掉旧行再插新行(同一个 rowid)。
        deleteFtsByRowid.run(existing.id);
        insertFts.run(existing.id, qa);
        updated += 1;
      }
    }
    if (deleted) db.prepare("DELETE FROM memory_sessions WHERE session_id = ?").run(sessionId);
    else db.prepare("INSERT OR REPLACE INTO memory_sessions(session_id, indexed_at) VALUES (?, ?)").run(sessionId, Date.now());
    db.exec("COMMIT");
    return { found: incoming.length, inserted, updated, removed };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  /**
   * 按关键词召回记忆。
   * @param request - `{ keywords, limit, ttlMs, sessionId, tag, perspective, now }`。
   * @returns 命中的记忆数组(新鲜的在前,过期的垫底)。
   */
  function recall({ keywords, limit = 5, ttlMs = 7200000, sessionId, tag, perspective, now = Date.now() } = {}) {
    const terms = (Array.isArray(keywords) ? keywords : [])
      .map((word) => String(word ?? "").trim())
      .filter((word) => word !== "")
      .slice(0, 8)
      .map((word) => `"${splitCjk(word).replaceAll('"', '""')}"`);
    if (terms.length === 0) return { items: [], total: 0, fresh: 0, stale: 0 };
    // 每个关键词独立成短语,彼此 OR——"给几个关键词"的意思是命中任意一个都算。
    const phrase = terms.join(" OR ");
    const cap = Math.max(1, Math.min(2000, Math.trunc(Number(limit) || 5)));
    const where = ["memory_fts MATCH ?"];
    const params = [phrase];
    if (sessionId !== undefined) { where.push("NOT (mem.session_id = ? AND COALESCE(mem.surface, '') = 'current')"); params.push(sessionId); }
    if (tag) { where.push("mem.tag = ?"); params.push(tag); }
    if (perspective) { where.push("mem.perspective = ?"); params.push(perspective); }
    // 先应用过滤，再分别取新鲜/过期候选。旧记忆再多也不能挤掉新鲜分层。
    // 两次仍使用FTS原生ORDER BY rank，不全量搬进JS后排序。
    const query = (fresh, count) => count === 0 ? [] : db.prepare(`
      SELECT mem.*, bm25(memory_fts) AS score
      FROM memory_fts JOIN memory mem ON mem.id = memory_fts.rowid
      WHERE ${where.join(" AND ")} AND mem.time ${fresh ? ">=" : "<"} ?
      ORDER BY rank LIMIT ?
    `).all(...params, now - ttlMs, count).map((row) => rowToMemory(row, { now, ttlMs }));
    const fresh = query(true, cap);
    const stale = query(false, cap - fresh.length);
    const items = [...fresh, ...stale];
    return { items, total: items.length, fresh: fresh.length, stale: stale.length };
  }

  /**
   * 列出记忆(给界面用,不做关键词过滤)。按时间倒序。
   * @param request - `{ limit, now, ttlMs }`。
   * @returns 记忆数组(带 fresh 标记)。
   */
  function list({ limit = 500, now = Date.now(), ttlMs = 7200000 } = {}) {
    const cap = Math.max(1, Math.min(Math.trunc(Number(limit) || 500), 2000));
    const rows = db
      .prepare(`
        SELECT block_id, session_id, cwd, seq, time, surface, q, a, tag, expires, perspective
        FROM memory ORDER BY time DESC LIMIT ?
      `)
      .all(cap);
    return rows.map((row) => ({
      blockId: String(row.block_id),
      sessionId: String(row.session_id),
      cwd: row.cwd === null ? undefined : String(row.cwd),
      seq: Number(row.seq),
      time: Number(row.time),
      tag: row.tag === null ? undefined : String(row.tag),
      expires: row.expires === null ? undefined : String(row.expires),
      perspective: row.perspective === null ? undefined : String(row.perspective),
      q: String(row.q),
      a: String(row.a),
      fresh: now - Number(row.time) <= ttlMs,
    }));
  }

  function stats() {
    const row = db.prepare("SELECT COUNT(*) AS n, MIN(time) AS oldest, MAX(time) AS newest FROM memory").get();
    return {
      path,
      memories: Number(row.n ?? 0),
      oldestMs: row.oldest === null ? undefined : Number(row.oldest),
      newestMs: row.newest === null ? undefined : Number(row.newest),
    };
  }

  function close() {
    try {
      db.close();
    } catch {
      // 关库失败没有补救动作,进程随后退出。
    }
  }

  return { ingest, recall, list, stats, close, ...createMemorySyncAccess(db),
    deleteSession: (sessionId) => ingest({ sessionId, blocks: [], deleted: true }),
  };
}

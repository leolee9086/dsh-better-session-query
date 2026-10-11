// 记忆索引的持久变更面。与记忆正文同一个 SQLite 事务提交，
// 向量库崩溃或服务暂缺时仍能追赶；不能用内存事件代替这份日志。
import { createHash, randomUUID } from "node:crypto";

export function memoryContentHash(q, a, attachments = []) {
  return createHash("sha256").update(JSON.stringify([q, a, attachments])).digest("hex");
}

export function migrateMemorySync(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(memory)").all().map((row) => row.name));
  if (!columns.has("perspective")) db.exec("ALTER TABLE memory ADD COLUMN perspective TEXT");
  if (!columns.has("attachments")) db.exec("ALTER TABLE memory ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
  if (!columns.has("content_hash")) db.exec("ALTER TABLE memory ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
  const update = db.prepare("UPDATE memory SET content_hash = ? WHERE id = ?");
  for (const row of db.prepare("SELECT id, q, a, attachments FROM memory WHERE content_hash = ''").all()) {
    update.run(memoryContentHash(row.q, row.a, JSON.parse(row.attachments)), row.id);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_identity (id INTEGER PRIMARY KEY CHECK(id = 1), epoch TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_changes (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      block_id TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS memory_sessions (session_id TEXT PRIMARY KEY, indexed_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_memory_changes_block ON memory_changes(block_id);
  `);
  const first = db.prepare("SELECT epoch FROM memory_identity WHERE id = 1").get() === undefined;
  if (first) {
    db.prepare("INSERT INTO memory_identity(id, epoch) VALUES(1, ?)").run(randomUUID());
    // 旧库原地迁移：已有记忆进入回填流，不要求重读全部会话日志。
    db.exec("INSERT INTO memory_changes(block_id) SELECT block_id FROM memory ORDER BY id");
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_change_insert AFTER INSERT ON memory BEGIN
      INSERT INTO memory_changes(block_id) VALUES(new.block_id);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_change_update AFTER UPDATE ON memory BEGIN
      INSERT INTO memory_changes(block_id) VALUES(new.block_id);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_change_delete AFTER DELETE ON memory BEGIN
      INSERT INTO memory_changes(block_id, deleted) VALUES(old.block_id, 1);
    END;
  `);
}

export function rowToMemory(row, { now = Date.now(), ttlMs = 7200000 } = {}) {
  if (!row) return undefined;
  return {
    blockId: String(row.block_id), sessionId: String(row.session_id),
    cwd: row.cwd == null ? undefined : String(row.cwd), seq: Number(row.seq), time: Number(row.time),
    surface: row.surface ?? undefined, q: String(row.q), a: String(row.a),
    tag: row.tag ?? undefined, expires: row.expires ?? undefined, perspective: row.perspective ?? undefined,
    attachments: JSON.parse(row.attachments ?? "[]"), contentHash: row.content_hash,
    fresh: now - Number(row.time) <= ttlMs,
    ...(row.score === undefined ? {} : { score: Number(row.score) }),
  };
}

export function memoryEligible(item, { sessionId, tag, perspective, cwd } = {}) {
  return Boolean(item)
    && !(sessionId !== undefined && item.sessionId === sessionId && item.surface === "current")
    && (!tag || item.tag === tag) && (!perspective || item.perspective === perspective)
    && (cwd === undefined || item.cwd === cwd);
}

export function createMemorySyncAccess(db) {
  const cap = (value, fallback = 200) => Math.max(1, Math.min(Number.isFinite(value) ? Math.trunc(value) : fallback, 2000));
  return {
    identity: () => ({
      epoch: db.prepare("SELECT epoch FROM memory_identity WHERE id = 1").get().epoch,
      revision: Number(db.prepare("SELECT COALESCE(MAX(revision), 0) AS n FROM memory_changes").get().n),
    }),
    changes({ after = 0, limit = 200 } = {}) {
      return db.prepare("SELECT revision, block_id, deleted FROM memory_changes WHERE revision > ? ORDER BY revision LIMIT ?")
        .all(after, cap(limit)).map((row) => ({ revision: Number(row.revision), blockId: row.block_id, deleted: Boolean(row.deleted) }));
    },
    // 字符串主键游标：删除前面的行不会像 OFFSET 分页那样跳过后面的行。
    scan({ after = "", limit = 200 } = {}) {
      return db.prepare("SELECT * FROM memory WHERE block_id > ? ORDER BY block_id LIMIT ?").all(after, cap(limit)).map((row) => rowToMemory(row));
    },
    get(blockId, options) { return rowToMemory(db.prepare("SELECT * FROM memory WHERE block_id = ?").get(blockId), options); },
    hasSession(sessionId) { return Boolean(db.prepare("SELECT 1 FROM memory_sessions WHERE session_id = ?").get(sessionId)); },
    sessionIds() { return db.prepare("SELECT session_id FROM memory_sessions UNION SELECT session_id FROM memory").all().map((row) => row.session_id); },
  };
}

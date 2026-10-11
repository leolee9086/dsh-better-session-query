// 向量同步的耐久状态。SQLite只管理任务/缓存，近邻检索始终交给vectorStore。
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export async function openVectorState(path) {
  if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    const app = Number(db.prepare("PRAGMA application_id").get().application_id);
    const version = Number(db.prepare("PRAGMA user_version").get().user_version);
    if (app !== 0 && app !== 1447908145) throw new Error("该文件不是记忆向量同步库");
    if (app === 0 && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get()) throw new Error("拒绝覆盖非空未知数据库");
    if (version > 2) throw new Error("向量同步库版本较新，拒绝降级");
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      PRAGMA application_id=1447908145; PRAGMA user_version=2;
      CREATE TABLE IF NOT EXISTS generations (
        id TEXT PRIMARY KEY, epoch TEXT NOT NULL, dataset TEXT NOT NULL, sources TEXT NOT NULL,
        cursor INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entities (
        generation TEXT NOT NULL, id TEXT NOT NULL, block_id TEXT NOT NULL,
        content_hash TEXT NOT NULL, input_hash TEXT NOT NULL, input TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(generation,id)
      );
      CREATE INDEX IF NOT EXISTS entities_block ON entities(generation,block_id);
      CREATE TABLE IF NOT EXISTS jobs (
        generation TEXT NOT NULL, entity_id TEXT NOT NULL, field TEXT NOT NULL,
        space TEXT NOT NULL, source TEXT NOT NULL, input_hash TEXT NOT NULL,
        priority INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0, error TEXT,
        PRIMARY KEY(generation,entity_id,field)
      );
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(generation,next_at,priority);
      CREATE TABLE IF NOT EXISTS vectors (
        space TEXT NOT NULL, input_hash TEXT NOT NULL, vector TEXT NOT NULL,
        PRIMARY KEY(space,input_hash)
      );`);
    // v1 → v2：检索字段从"一个来源一个字段"改成"一个来源按模态分通道"（理由见 memory-vectors.js）。
    // 旧的实体与任务记的是旧字段名，不能复用；向量缓存按内容哈希存，与字段无关，保留下来免得重算。
    if (version === 1) db.exec("DELETE FROM generations; DELETE FROM entities; DELETE FROM jobs;");
    return {
      db,
      transaction(fn) {
        db.exec("BEGIN IMMEDIATE");
        try { const result = fn(); db.exec("COMMIT"); return result; }
        catch (error) { db.exec("ROLLBACK"); throw error; }
      },
      close: () => db.close(),
    };
  } catch (error) { db.close(); throw error; }
}

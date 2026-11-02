// test/real-log.mjs — 真实会话日志的造法，以及跑在这些文件上的日志源与清单。
//
// 替代之前的 logReaderFor(mock)：那份 mock 直接返回内存数组，
// 等于把"定位、分帧、解压、按窗口读"整段跳过，测出来的是假数据上的逻辑。
//
// 这里所有数据都真的落到磁盘：多帧 zstd、标准 v4 目录结构、真 rebec 解析。
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";

import { locateSessionLog } from "../lib/log-source.js";

const require = createRequire(import.meta.url);

/**
 * 拿 rebec：优先环境变量，其次已安装的包；都没有就返回 undefined（调用方决定 skip 还是失败）。
 * @returns rebec 模块或 undefined。
 */
export function loadRebec() {
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

/**
 * 会话头那一行。
 * @param id - 会话 id。
 * @param cwd - 工作区，可省略。
 * @returns JSON 文本。
 */
export function headerLine(id, cwd) {
  const header = { type: "session", version: 4, id, createdAt: 1 };
  if (cwd !== undefined) header.cwd = cwd;
  return JSON.stringify(header);
}

/**
 * 把若干帧拼成日志字节：每帧独立压缩，帧内是完整的 JSONL 行。
 * @param frames - 每个子数组是一帧的事件对象数组（或已序列化的字符串）。
 * @returns Buffer。
 */
export function buildLog(frames) {
  return Buffer.concat(
    frames
      .filter((lines) => lines.length > 0)
      .map((lines) => {
        const text = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n";
        return zstdCompressSync(Buffer.from(text, "utf8"));
      }),
  );
}

/** 会话目录：<DSH_HOME>/sessions/<projectKey>/<id>/ */
function sessionDir(home, id) {
  return join(home, "sessions", "--D-dev--", id);
}

/**
 * 一个临时 DSH_HOME，里面真的能写会话日志。
 *
 * 所有"改内容"的操作都落到文件上（追加帧、覆盖写、删除），
 * 测试因此走的是和生产一样的路径：文件 → rebec → 事件 → 索引。
 */
export class LogFixture {
  /** @param prefix - 临时目录前缀，便于排查。 */
  constructor(prefix = "bsq-real-") {
    this.home = mkdtempSync(join(tmpdir(), prefix));
    this.previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = this.home;
    this.rebec = loadRebec();
    /** 哪些会话算"实时":清单里要如实报出来,indexer 靠它决定每轮都查。 */
    this.liveIds = new Set();
  }

  /**
   * 覆盖写一个会话（头 + 一帧事件）。
   * @param id - 会话 id。
   * @param options - { cwd, events }。
   */
  write(id, { cwd, events = [], live = false } = {}) {
    const dir = sessionDir(this.home, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session.v4.jsonl.zstd"),
      buildLog([[headerLine(id, cwd), ...events]]),
    );
    if (live) this.liveIds.add(id);
    else this.liveIds.delete(id);
    return this;
  }

  /**
   * 追加一帧事件（模拟会话继续增长）。
   * @param id - 会话 id。
   * @param events - 新事件。
   */
  append(id, events) {
    const file = join(sessionDir(this.home, id), "session.v4.jsonl.zstd");
    const tail = buildLog([events]);
    writeFileSync(file, Buffer.concat([
      statSync(file).size > 0 ? readFileSyncSafe(file) : Buffer.alloc(0),
      tail,
    ]));
    return this;
  }

  /**
   * 原地重写：帧数和长度都可能变，用来验证"不能只靠长度判断有没有变"。
   * @param id - 会话 id。
   * @param options - { cwd, events }。
   */
  rewrite(id, { cwd, events = [] } = {}) {
    return this.write(id, { cwd, events });
  }

  /** 删掉整个会话目录（模拟会话被删除）。 */
  remove(id) {
    rmSync(sessionDir(this.home, id), { recursive: true, force: true });
    return this;
  }

  /** 删掉日志文件但保留目录（模拟没有当前格式日志）。 */
  removeLog(id) {
    try {
      unlinkSync(join(sessionDir(this.home, id), "session.v4.jsonl.zstd"));
    } catch {
      // 已经没有了就是目标状态。
    }
    return this;
  }

  /** 写一份读不出来的日志(坏魔数),用来验证失败处理与冷却。 */
  corrupt(id) {
    const dir = sessionDir(this.home, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.v4.jsonl.zstd"), Buffer.from("not-a-zstd-frame-at-all"));
    return this;
  }

  /** 把日志截断到若干字节，模拟损坏或没写完。 */
  truncate(id, bytes) {
    const file = join(sessionDir(this.home, id), "session.v4.jsonl.zstd");
    const buf = readFileSyncSafe(file);
    writeFileSync(file, buf.subarray(0, Math.max(0, Math.min(bytes, buf.length))));
    return this;
  }

  /** 真实日志源：定位走生产实现，分批读走真 rebec。 */
  logReader() {
    if (this.rebec === undefined) throw new Error("没有可用的 rebec");
    const calls = { stat: 0, batch: 0, statById: new Map(), batchById: new Map() };
    const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
    // 日志路径形如 <home>/sessions/<project>/<id>/session.v4.jsonl.zstd,倒数第二段就是会话 id。
    const idOf = (path) => String(path).split(/[\\/]/).slice(-2)[0];
    return {
      calls,
      locateSessionLog: (id) => locateSessionLog(id, { force: true }),
      statSessionLog: (path) => {
        calls.stat += 1;
        bump(calls.statById, idOf(path));
        const info = statSync(path);
        return { size: info.size, mtimeMs: Math.trunc(info.mtimeMs) };
      },
      readSessionBatch: (path, offset, limit) => {
        calls.batch += 1;
        bump(calls.batchById, idOf(path));
        return JSON.parse(this.rebec.sessionScanLog(path, offset, limit));
      },
    };
  }

  /** 真实清单：扫 sessions 目录，用 rebec 读每个日志的 header。 */
  conversation() {
    if (this.rebec === undefined) throw new Error("没有可用的 rebec");
    const rebec = this.rebec;
    const self = this;
    const home = this.home;
    return {
      async listSessions() {
        const root = join(home, "sessions");
        const records = [];
        for (const project of safeReaddir(root)) {
          const projectDir = join(root, project);
          for (const session of safeReaddir(projectDir)) {
            const file = join(projectDir, session, "session.v4.jsonl.zstd");
            // 清单里的 id 来自目录名：生产里会话注册表不依赖日志能否解析，
            // 损坏的会话照样出现在清单里，只是读正文时失败。这里照同一条规则。
            let cwd;
            try {
              const win = JSON.parse(rebec.sessionScanLog(file, 0, 1));
              if (win.header !== null && win.header !== undefined) cwd = win.header.cwd;
            } catch {
              // header 读不出来就用 undefined：会话仍在清单里，读正文时才失败。
            }
            records.push({
              header: { id: session, cwd },
              live: self.liveIds.has(session),
              persisted: true,
            });
          }
        }
        return records;
      },
    };
  }

  /** 清理：还原 DSH_HOME，删临时目录。 */
  done() {
    rmSync(this.home, { recursive: true, force: true });
    if (this.previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = this.previousHome;
  }
}

function readFileSyncSafe(file) {
  return require("node:fs").readFileSync(file);
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// lib/log-source.js — 定位会话日志文件,并把它交给 rebec 分批读取。
//
// 为什么不用 ctx.sessionQuery / ctx.sessionPersistence:
//   两条路都会把整份日志读进内存(load 一次 + clone 一次,readSession 还要 replay 一次),
//   20 万事件的会话一次要几 GB 堆,host 会以 V8 OOM 崩掉。
//   这里只按窗口读,进程内存与日志长度无关。
//
// 日志位置是 <DSH_HOME>/sessions/<projectKey>/<sessionId>/session.v4.jsonl.zstd。
// 一级目录由 cwd 派生,插件不复制那套规则,直接按会话 id 找二级目录;结果按 TTL 缓存。

import { createRequire } from "node:module";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const require = createRequire(import.meta.url);

/** 当前格式的日志文件名。旧代次(v2/v3/无后缀)这里不读。 */
export const CURRENT_LOG_NAME = "session.v4.jsonl.zstd";

/** rebec 的 napi 产物,只在第一次用时加载。 */
let rebecModule;
function rebec() {
  if (rebecModule !== undefined) return rebecModule;
  try {
    rebecModule = require("@leolee9086/rebec");
  } catch (error) {
    throw new Error(
      "缺少 @leolee9086/rebec:会话日志的分帧解析由它提供(纯 JS 全量读会撑爆堆)。"
      + `安装:pnpm add @leolee9086/rebec。原始错误:${error?.message ?? String(error)}`,
    );
  }
  return rebecModule;
}

/** DSH 数据目录。 */
export function dshHome() {
  const configured = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
  return configured !== "" ? configured : join(homedir(), ".dsh");
}

/** 会话 id → 日志绝对路径的缓存;miss 时重扫 sessions 目录。 */
const pathCache = new Map();
let pathCacheAt = 0;
const PATH_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 找会话的当前格式日志。
 * @param sessionId - 会话 id(等于二级目录名)。
 * @param options - `{ force }`:忽略缓存重扫。
 * @returns 绝对路径;没有 v4 日志时 undefined。
 */
export function locateSessionLog(sessionId, options = {}) {
  const now = Date.now();
  if (!options.force && now - pathCacheAt < PATH_CACHE_TTL_MS) {
    const cached = pathCache.get(sessionId);
    if (cached !== undefined) return cached;
  }
  if (options.force || now - pathCacheAt >= PATH_CACHE_TTL_MS) rescanSessions();
  return pathCache.get(sessionId);
}

/** 重扫 sessions 目录,建立 id → v4 日志路径的映射。 */
export function rescanSessions() {
  const root = join(dshHome(), "sessions");
  const next = new Map();
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    // 没有 sessions 目录:这台机器还没存过会话,不是错误。
    if (error?.code === "ENOENT") {
      pathCache.clear();
      pathCacheAt = Date.now();
      return;
    }
    throw error;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = join(root, project.name);
    let sessions;
    try {
      sessions = readdirSync(projectDir, { withFileTypes: true });
    } catch {
      // 某个工作区目录读不到(权限/竞态):跳过它,不影响其它会话。
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const candidate = join(projectDir, session.name, CURRENT_LOG_NAME);
      try {
        statSync(candidate);
        next.set(session.name, candidate);
      } catch {
        // 没有当前格式日志:跳过,上层当作"读不到"。
        continue;
      }
    }
  }
  pathCache.clear();
  for (const [id, path] of next) pathCache.set(id, path);
  pathCacheAt = Date.now();
}

/**
 * 读一批事件。
 * @param path - 日志绝对路径。
 * @param offset - 上次返回的 nextOffset(帧边界;0 表示从头)。
 * @param limit - 这批最多要多少条(一帧超限时整帧返回,可能略多)。
 * @returns `{ header?, events, nextOffset, done, torn }`。
 */
export function readSessionBatch(path, offset, limit) {
  const raw = rebec().sessionScanLog(path, offset, limit);
  return JSON.parse(raw);
}

/**
 * 日志的物理身份:字节数 + 修改时间。
 *
 * 只有字节数不够:日志原地重写(compaction、修复)时长度可能不变,
 * 只看长度会把"内容全变了"当成"没变",整份新内容被静默跳过。
 * @param path - 日志绝对路径。
 * @returns { size, mtimeMs }。
 */
export function statSessionLog(path) {
  const info = statSync(path);
  return { size: info.size, mtimeMs: Math.trunc(info.mtimeMs) };
}

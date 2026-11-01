// lib/surface.js — 会话表层的增量折叠。
//
// DSH 的规范实现是 dsh-session 的 surface.ts(foldSurface / SurfaceManager)。规则是:
//   每个消息事件带一个 surfaceOp:
//     - 'append'                                 : 追加到表层;
//     - { op: 'replace', startSeq, endSeq }      : 用它自己替换表层上 [startSeq, endSeq] 这一段,
//                                                  被换掉的 seq 从此不在表层(log-only);
//     - 没有 surfaceOp                            : 非消息事件,不进表层。
// 折叠结果就是"当前表层的事件 seq 序列",顺序即模型看到的顺序。
//
// 这里只保留折叠状态(seq 数组 + 被遮蔽的 seq),不保留事件本体,
// 所以可以随日志一批一批推进,内存与日志长度无关。
//
// 索引器需要它的原因:块表里每一行都要标 surface(current / log-only)。
// 这个标记不能靠"读了多少条"猜 —— compaction 会把旧消息挤出表层,
// 属于"新事件改变了旧事件的归属",必须用同一套折叠规则算。

/**
 * 造一个增量 surface 折叠器。
 * @param initialNodes - 上次折叠留下的节点 seq 序列(续读时传入);省略即从空表层开始。
 * @returns `{ apply(event), nodes(), size(), toJSON() }`。
 *   apply(event) 返回 `{ surface, shadowed? }`:
 *   surface 是这条事件自己的归属('current' / undefined 表示不进表层);
 *   shadowed 是这次替换挤出表层的 seq 列表,调用方据此把那些块改成 log-only。
 */
export function createSurfaceFold(initialNodes = []) {
  const nodes = Array.isArray(initialNodes) ? initialNodes.slice() : [];

  return {
    /**
     * 折叠一条事件。
     * @param event - 会话事件(至少要有 seq)。
     * @returns 见上。
     */
    apply(event) {
      const seq = event?.seq;
      if (!Number.isInteger(seq) || seq < 0) return {};
      const op = event?.surfaceOp;
      if (op === undefined) return {};
      if (op === "append") {
        nodes.push(seq);
        return { surface: "current" };
      }
      if (op !== null && typeof op === "object" && op.op === "replace") {
        const startIdx = nodes.indexOf(op.startSeq);
        const endIdx = nodes.indexOf(op.endSeq);
        if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
          // 折叠状态与日志不同步(索引被裁剪、从中间接管、日志被重写)。
          // 不抛:抛会让整个会话永远索引不了。退化成追加,并如实标出来。
          nodes.push(seq);
          return { surface: "current", inconsistent: true };
        }
        const shadowed = nodes.slice(startIdx, endIdx + 1);
        nodes.splice(startIdx, endIdx - startIdx + 1, seq);
        return { surface: "current", shadowed };
      }
      // 结构不合法的 surfaceOp:交给调用方当异常处理(与 DSH 的严格性一致)。
      return { invalid: true };
    },

    /** 当前表层的 seq 顺序(只读视图)。 */
    nodes() {
      return nodes;
    },

    /** 表层节点数。 */
    size() {
      return nodes.length;
    },

    /** 序列化:存进索引库,下一次续读时用它恢复折叠状态。 */
    toJSON() {
      return nodes;
    },
  };
}

/**
 * 恢复上次的折叠状态。
 * @param value - `indexed_sessions.surface_nodes` 里的 JSON 文本或数组;损坏/缺失时返回空。
 * @returns 节点数组。
 */
export function parseSurfaceNodes(value) {
  if (Array.isArray(value)) return value.filter((seq) => Number.isInteger(seq) && seq >= 0);
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((seq) => Number.isInteger(seq) && seq >= 0) : [];
  } catch {
    // 状态坏了就从头折:宁可多算一次,不要因为一段坏 JSON 卡住整个会话。
    return [];
  }
}

// lib/recall-order.js — 召回结果的输出顺序。
//
// 为什么单独抽出来：共享召回库当前安装的那一版（v0.1.0）仍然把"新鲜"放在相关性前面，
// 而这里默认要的语义是"更相关但稍旧的记忆，不能被刚记下的无关记忆挤掉"。
// 依赖钉在发布包上，升级前先在插件这一层把顺序摆正；依赖升级到同一语义后，这个文件可以删掉。
//
// 两种顺序都是没有数据支撑的策略选择，所以走配置（memoryRecall.order）：
//   relevance-first（默认）：融合分 recallScore 优先，新鲜只在并列时作偏好；
//   fresh-first：新鲜优先，回到共享库旧行为，用于对照。
// 两种模式下 fresh 都不参与"该不该返回"的判断，只影响顺序——旧的记忆照样能命中。

/**
 * 排好并截断。
 * @param items - hybridRecall 的候选（带 recallScore / fresh / time）。
 * @param limit - 输出条数上限。
 * @param mode - `"relevance-first"`（默认）或 `"fresh-first"`。
 * @returns 新数组，不改动入参。
 */
export function orderRecalled(items, limit, mode = "relevance-first") {
  const cap = Math.max(1, Math.min(2000, Math.trunc(Number(limit) || 5)));
  const byRelevance = (a, b) => Number(b?.recallScore ?? 0) - Number(a?.recallScore ?? 0)
    || Number(b?.fresh === true) - Number(a?.fresh === true)
    || Number(b?.time ?? 0) - Number(a?.time ?? 0);
  const byFreshness = (a, b) => Number(b?.fresh === true) - Number(a?.fresh === true)
    || Number(b?.recallScore ?? 0) - Number(a?.recallScore ?? 0)
    || Number(b?.time ?? 0) - Number(a?.time ?? 0);
  return [...(Array.isArray(items) ? items : [])]
    .sort(mode === "fresh-first" ? byFreshness : byRelevance)
    .slice(0, cap);
}

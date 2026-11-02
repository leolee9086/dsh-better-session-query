// lib/recall-order.js — 召回结果的输出顺序：相关优先，新鲜只在并列时当作偏好。
//
// 为什么单独抽出来：共享召回库当前安装的那一版（v0.1.0）仍然把"新鲜"放在相关性前面，
// 而这里要的语义是"更相关但稍旧的记忆，不能被刚记下的无关记忆挤掉"。
// 依赖钉在发布包上，升级前先在插件这一层把顺序摆正；依赖升级到同一语义后，这个文件可以删掉。
// 排序键（从主到次）：融合分 recallScore → 是否新鲜 → 时间。
// 注意 fresh 不参与"该不该返回"的判断，只影响顺序——旧的记忆照样能命中。

/**
 * 按"相关优先、新鲜次之"排好并截断。
 * @param items - hybridRecall 的候选（带 recallScore / fresh / time）。
 * @param limit - 输出条数上限。
 * @returns 新数组，不改动入参。
 */
export function orderRecalled(items, limit) {
  const cap = Math.max(1, Math.min(2000, Math.trunc(Number(limit) || 5)));
  return [...(Array.isArray(items) ? items : [])]
    .sort((a, b) => Number(b?.recallScore ?? 0) - Number(a?.recallScore ?? 0)
      || Number(b?.fresh === true) - Number(a?.fresh === true)
      || Number(b?.time ?? 0) - Number(a?.time ?? 0))
    .slice(0, cap);
}

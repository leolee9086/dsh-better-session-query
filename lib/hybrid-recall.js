// 只融合各来源排名，不把BM25、余弦和RRF原始分数直接相加。
import { extractKeywords } from "./passive-recall.js";

export async function hybridRecall({ memory, vectors }, request = {}) {
  const limit = Math.max(1, Math.min(2000, Math.trunc(request.limit ?? 5)));
  const query = request.query?.trim() || (request.keywords ?? []).filter((word) => typeof word === "string").join(" ");
  const keywords = request.keywords?.length ? request.keywords : extractKeywords(query);
  const keyword = memory.recall({ ...request, keywords, limit: Math.min(2000, Math.max(limit * 4, 20)) });
  let semantic = { items: [], failures: [{ sourceId: "vectorStore", reason: "not-mounted" }], truncated: false };
  if (vectors) {
    try { semantic = await vectors.search({ ...request, query, limit: Math.min(2000, Math.max(limit * 4, 20)) }); }
    catch { semantic.failures = [{ sourceId: "vectorStore", reason: "unavailable" }]; }
  }
  const merged = new Map();
  const entry = (item) => {
    if (!merged.has(item.blockId)) merged.set(item.blockId, { ...item, score: undefined, keywordScore: undefined, vectorSources: [], recallScore: 0, recallSources: [] });
    return merged.get(item.blockId);
  };
  keyword.items.forEach((item, rank) => {
    const value = entry(item);
    value.keywordScore = item.score;
    value.recallScore += 1 / (60 + rank + 1);
    value.recallSources.push("keyword");
  });
  semantic.items.forEach((item, rank) => {
    const value = entry(item);
    value.vectorSources = item.vectorSources;
    value.matchedModality = item.matchedModality;
    value.recallScore += 1 / (60 + rank + 1);
    value.recallSources.push("vector");
  });
  // 在截断前判断被动召回门槛。关键词强度与每个语义来源的余弦阈值分别判断。
  const eligible = [...merged.values()].filter((item) => {
    if (!request.passive) return true;
    if (-Number(item.keywordScore) >= (request.minScore ?? 1)) return true;
    return item.vectorSources.some((source) => {
      const threshold = request.minSimilarityBySource?.[source.sourceId]
        ?? (source.sourceId === "local-multimodal" ? 0.3 : request.minSimilarity ?? 0.45);
      return Number.isFinite(source.similarity) && source.similarity >= threshold;
    });
  });
  const items = eligible.sort((a, b) => Number(b.fresh) - Number(a.fresh) || b.recallScore - a.recallScore || b.time - a.time).slice(0, limit);
  return { items, total: merged.size, fresh: items.filter((item) => item.fresh).length,
    stale: items.filter((item) => !item.fresh).length, failures: semantic.failures,
    truncated: semantic.truncated, mode: vectors ? "hybrid" : "keyword-only" };
}

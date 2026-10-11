/** 显示原始查询线索；仅图片查询也应有可辨认的标题。 */
function clues(args = {}) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const words = Array.isArray(args.keywords)
        ? args.keywords.filter((word) => typeof word === 'string').map(word => word.trim()).filter(Boolean)
        : [];
    return [...new Set([...(query ? [query] : []), ...words, ...(args.image ? ['图片'] : [])])];
}
/**
 * 工具只规范化入参与输出，实际召回交给与被动入口相同的公共实现。
 * 依赖是一个召回函数，不模拟 Cordis，也不在工具层另写一套融合策略。
 */
export function createActiveRecall({ recall, format, ttlMs }) {
    return {
        async execute(args = {}, exec) {
            try {
                const keywords = Array.isArray(args?.keywords)
                    ? args.keywords.filter((word) => typeof word === 'string').map(word => word.trim()).filter(Boolean)
                    : [];
                const query = typeof args?.query === 'string' ? args.query.trim() : '';
                const image = args?.image;
                if (image !== undefined && (!image || typeof image.path !== 'string' || !image.path.trim()
                    || typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(image.sha256))) {
                    return 'ERROR: image 需提供非空 path 和 SHA256';
                }
                if (!keywords.length && !query && !image)
                    return 'ERROR: keywords、query 或 image 至少提供一种非空线索';
                const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
                    ? Math.max(1, Math.min(Math.trunc(args.limit), 20)) : 5;
                const outcome = await recall({
                    keywords, query, image, limit, ttlMs,
                    // 保留当前会话过滤，避免把仍在活跃上下文里的记忆重复召回。
                    sessionId: exec?.agent?.session?.id,
                    tag: typeof args.tag === 'string' ? args.tag.trim() : undefined,
                    perspective: typeof args.perspective === 'string' ? args.perspective.trim() : undefined,
                });
                return format(clues(args), outcome, ttlMs);
            }
            catch (error) {
                return 'ERROR: ' + (error instanceof Error ? error.message : String(error));
            }
        },
        presentCall(args = {}) {
            return { card: 'generic', title: '回忆: ' + clues(args).join(' / '), kind: 'execute' };
        },
    };
}

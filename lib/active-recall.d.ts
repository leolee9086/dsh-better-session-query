import type { RecallCandidate, RecallOutcome, RecallRequest } from '@leolee9086/dsh-hybrid-recall';
type Execution = {
    agent?: {
        session?: {
            id?: string;
        };
    };
};
type Arguments = {
    keywords?: unknown;
    query?: unknown;
    image?: unknown;
    limit?: unknown;
    tag?: unknown;
    perspective?: unknown;
};
/**
 * 工具只规范化入参与输出，实际召回交给与被动入口相同的公共实现。
 * 依赖是一个召回函数，不模拟 Cordis，也不在工具层另写一套融合策略。
 */
export declare function createActiveRecall<T extends RecallCandidate>({ recall, format, ttlMs }: {
    recall: (request: RecallRequest) => Promise<RecallOutcome<T>>;
    format: (clues: string[], outcome: RecallOutcome<T>, ttlMs: number) => string;
    ttlMs: number;
}): {
    execute(args?: Arguments, exec?: Execution): Promise<string>;
    presentCall(args?: Arguments): {
        card: string;
        title: string;
        kind: string;
    };
};
export {};

# 向量召回开发状态

2026-10-11：将已有开发修改按职责提交，以保存可审查的实现历史。本次没有发布 npm、更新标签、部署或完成向量召回交付。

## 已保存的实现

- 记忆 SQLite 原地迁移、正文与变更流同事务、删除墓碑、幂等写入和回填游标。
- 记忆提取成功后再推进会话索引；删除、归档和排除时清理派生记忆。
- 多字段 Dataset 同步、持久任务与缓存、模型代际、重试和正文 hash 校验。
- 混合召回原型、被动召回入口、共享服务生命周期、附件字节校验与监控状态。
- 主动入口接线已补齐：接受 keywords、query 或 image，经 recallMemory 调用独立公共库 @leolee9086/dsh-hybrid-recall；主动和被动入口共用混合实现。新库和工具适配以 TypeScript 编写，插件旧 hybrid-recall.js 只做兼容转发。图片仅接通参数传递，下游缺口见下文。

## 尚未完成

- 图片查询传入 path，而 imageInput 读取 image；图文混合查询还会忽略文字。
- 跨空间直接比较 similarity、提前按 blockId 折叠、fresh 硬优先，以及禁用全部多模态模型的文字检索，均需按修订方案重新处理。
- 通用 retrieval-contract 尚未由查询插件消费；不能宣称支持任意记忆结构。
- 真实模型的召回质量、正式宿主装配和图片端到端验收尚未完成，不能由入口测试推定。
- 公共混合召回库尚未发布，当前依赖 file:../dsh-hybrid-recall，需要相邻工作树；正式分发前须改为公共库发布版本。

## 验证范围

存量提交阶段运行：

```sh
pnpm exec node --test --test-reporter=dot test/memory.test.mjs test/memory-sync.test.mjs test/indexer.test.mjs
pnpm exec node --test --test-reporter=dot test/memory-vectors.test.mjs
```

前一组 32 项通过，后一组 3 项通过。后一组用真实侧车和 SQLite，但嵌入来源是确定性的测试实现；它检查同步、模型换代、删除屏蔽和故障恢复，不测真实模型相关性。

memory-vectors 测试直接导入相邻 dsh-vectordb 源码，该仓仍依赖本机 s-forge 包。三包冒烟脚本还需要相邻 dsh-embeddings 与已下载模型，属于开发工作区脚本，不能在单独克隆查询仓后直接运行。默认 pnpm test/prepack 也包含该跨仓测试，独立打包验证仍待收束。

已有三包冒烟脚本存量提交阶段只保存，没有加载模型重跑；其中图片查询已知存在上述契约问题。它只有自造样例，不能作为召回率基准或发行验收。旧 mock ctx 插件套件没有重跑，不据此声称正式应用接线正确。

2026-10-11 主动入口修复及公共库抽离验证：

- 公共库：`pnpm build`、`pnpm test`，3 项行为测试通过，覆盖两路融合、来源失败降级、被动门槛先于截断。
- 查询插件：`pnpm build`、`pnpm check`；`pnpm exec node --test test/active-recall.test.ts test/passive-recall.test.mjs`，13 项通过。
- 主动入口测试使用真实 SQLite 记忆库、公共混合实现和工具格式化，覆盖 query-only、关键词兼容、当前会话/标签/视角过滤、异步语义候选、故障降级、空参数和图片参数传递。
- 语义候选来源为确定性测试替身；图片测试只检查入口传递，不读取图片。不把以上 16 项局部测试视为真实模型质量、图片能力或正式应用装配验收。本次未发布、推送或部署。

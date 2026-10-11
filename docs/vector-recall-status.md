# 向量召回开发状态

2026-10-11：将已有开发修改按职责提交，以保存可审查的实现历史。本次没有发布 npm、更新标签、部署或完成向量召回交付。

## 已保存的实现

- 记忆 SQLite 原地迁移、正文与变更流同事务、删除墓碑、幂等写入和回填游标。
- 记忆提取成功后再推进会话索引；删除、归档和排除时清理派生记忆。
- 多字段 Dataset 同步、持久任务与缓存、模型代际、重试和正文 hash 校验。
- 混合召回原型、被动召回入口、共享服务生命周期、附件字节校验与监控状态。

## 尚未完成

- 主动 recall 工具仍要求 keywords 并调用旧 memory.recall；schema 中的 query/image 尚未接通执行入口。
- 图片查询传入 path，而 imageInput 读取 image；图文混合查询还会忽略文字。
- 跨空间直接比较 similarity、提前按 blockId 折叠、fresh 硬优先，以及禁用全部多模态模型的文字检索，均需按修订方案重新处理。
- 通用 retrieval-contract 尚未由查询插件消费；不能宣称支持任意记忆结构。
- 工具描述中的语义和图文能力是开发中的目标，不能视为当前主动工具已经可用。

## 验证范围

本次运行：

```sh
pnpm exec node --test --test-reporter=dot test/memory.test.mjs test/memory-sync.test.mjs test/indexer.test.mjs
pnpm exec node --test --test-reporter=dot test/memory-vectors.test.mjs
```

前一组 32 项通过，后一组 3 项通过。后一组用真实侧车和 SQLite，但嵌入来源是确定性的测试实现；它检查同步、模型换代、删除屏蔽和故障恢复，不测真实模型相关性。

memory-vectors 测试直接导入相邻 dsh-vectordb 源码，该仓仍依赖本机 s-forge 包。三包冒烟脚本还需要相邻 dsh-embeddings 与已下载模型，属于开发工作区脚本，不能在单独克隆查询仓后直接运行。默认 pnpm test/prepack 也包含该跨仓测试，独立打包验证仍待收束。

已有三包冒烟脚本本次只保存，没有加载模型重跑；其中图片查询已知存在上述契约问题。它只有自造样例，不能作为召回率基准或发行验收。旧 mock ctx 插件套件没有重跑，不据此声称正式应用接线正确。

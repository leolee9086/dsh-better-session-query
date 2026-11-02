# 向量召回开发状态

## 2026-11-02：阶段 A 的机制补齐

计划文档（2026-10-02 修订计划）里"阶段 A"点名的五件事，代码层面都做完了：

1. **图片契约**：外部统一 `{path, sha256}`，内部统一 `{image, sha256, cwd}`，换算只有一处
   （`lib/vector-documents.js` 的 `imageQuery`）。以图搜记忆恢复：同一张图余弦 1.0，排在第一位。
2. **图文混合查询**：文字与图片两条线索各自参与，不再"有图就把文字丢掉"。
3. **通道能力**：来源可以用 `capabilities` 声明 `text->text` / `text->image` / `image->text` / `image->image`。
   图文来源的 `text->text` 默认关闭（理由是文本塔分布太窄，实测两条毫不相关的记忆余弦 0.92+），
   但来源可以显式打开——不再由"是不是多模态模型"一句话决定。
4. **排序**：跨空间的原始余弦不再参与排序。每条证据先按"它所在那一路内部"归一化（只有一条候选的
   路段记 0，没有分辨力），排序键是 relevance → 融合排名 → 时间；`similarity` 只留作诊断与被动阈值。
   同一记忆的多个分片、多条通道命中都会留下证据，且换代的同一份内容不会重复计分。
5. **新鲜度**：相关优先，新鲜只作并列时的偏好。共享召回库源码已改成同一语义（默认相关优先）；
   插件侧另有 `lib/recall-order.js` 立即生效——依赖钉在 v0.1.0 安装包上，等共享库下次发版两层就一致。

验证（都是本轮现场跑出来的）：

- 插件全量 **195/195**（新增 `test/vector-image-query.test.ts`、`test/vector-mixed-query.test.ts`、`test/recall-order.test.ts`）
- 共享召回库 **5/5**（新增两条排序语义测试）
- 三包冒烟 `scripts/acceptance-vector-memory.mjs` **11 项全过**（真侧车 + 真本地模型 + 真 SQLite，
  含新增的图文混合查询一项）

### 没有数据支撑的值，全部暴露成配置

阈值与策略没有一个有独立标注的数据支撑，所以都不写死在代码里：

- `memoryVectors`：`rrfConstant`、`candidateFactor`、`candidateFloor`、`relevanceMode`
  （`lane-normalized` / `fusion`）、`chunkChars`、`chunkOverlap`、`imageMaxBytes`
- `memoryRecall.order`：`relevance-first` / `fresh-first`
- `passiveRecall.minSimilarity` 与 `minSimilarityBySource`（后者是合并，不是整表替换）

共享召回库不再内置任何来源 id 的特例：门槛只从调用方传入的值里取，默认 0.45 是明写的占位值。

阶段 A 之后仍未完成：

- **没有基线评测**：被动阈值（0.3/0.45）、归一化相关度的实际意义，都还是保守默认值，
  没有独立标注的数据支撑；计划里的 B 阶段（LongMemEval / TEMPR / V-Mem 等对照）没开始。
- 重排扩展点、有界展开（C/D 阶段）、正式宿主装配、工具→服务→模型的图片端到端验收都还没做。
- `dsh-vectordb` 的 retrieval-contract 还没被插件消费（它目前只是独立模块 + 自己的测试）。
- 共享库与 vectordb 仍按 GitHub Release 的 tgz 分发，npm registry 二次认证未过。

---

## 2026-10-11 状态（历史记录）

（下面这段记的是当时的状态；其中列出的缺口已在 2026-11-02 处理，见上。）

2026-10-11：先按职责保存存量开发修改，随后完成公共库独立分发及消费者依赖迁移。公共库已发布 GitHub Release，npm registry 发布尚待二次认证；查询插件没有发布新版本或部署，完整向量召回交付仍有下述功能缺口。

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
- 公共库通过 v0.1.0 GitHub Release 的 HTTPS 安装包分发，消费者固定版本；npm registry 发布仍待维护者二次认证，不影响按锁文件独立安装。

## 验证范围

存量提交阶段运行：

```sh
pnpm exec node --test --test-reporter=dot test/memory.test.mjs test/memory-sync.test.mjs test/indexer.test.mjs
pnpm exec node --test --test-reporter=dot test/memory-vectors.test.mjs
```

前一组 32 项通过，后一组 3 项通过。后一组用真实侧车和 SQLite，但嵌入来源是确定性的测试实现；它检查同步、模型换代、删除屏蔽和故障恢复，不测真实模型相关性。

memory-vectors 测试现通过声明的 @leolee9086/vectordb 开发依赖打开真实数据库；测试内的 TypeScript 适配只提供 Dataset 接口，不加载相邻插件，也不模拟 Cordis 装配。默认测试不再依赖 s-forge 工作树。三包冒烟脚本仍需要已下载模型和开发工作区，不作为默认测试或正式应用验收。

已有三包冒烟脚本存量提交阶段只保存，没有加载模型重跑；其中图片查询已知存在上述契约问题。它只有自造样例，不能作为召回率基准或发行验收。旧 mock ctx 插件套件没有重跑，不据此声称正式应用接线正确。

2026-10-11 主动入口修复及公共库抽离验证：

- 公共库：`pnpm build`、`pnpm test`，3 项行为测试通过，覆盖两路融合、来源失败降级、被动门槛先于截断。
- 查询插件：`pnpm build`、`pnpm check`；`pnpm exec node --test test/active-recall.test.ts test/passive-recall.test.mjs`，13 项通过。
- 主动入口测试使用真实 SQLite 记忆库、公共混合实现和工具格式化，覆盖 query-only、关键词兼容、当前会话/标签/视角过滤、异步语义候选、故障降级、空参数和图片参数传递。
- 语义候选来源为确定性测试替身；图片测试只检查入口传递，不读取图片。不把以上 16 项局部测试视为真实模型质量、图片能力或正式应用装配验收。该阶段未发布、推送或部署。

2026-10-11 15:11+08:00 公共库迁移验收：

- 清单和锁文件已改为 v0.1.0 GitHub Release HTTPS 依赖，去除本地 file 依赖及测试对相邻插件的源码导入。
- 本仓安装、构建、语法检查通过；记忆向量同步与主动/被动召回共 16 项相关测试通过。
- 将清单、锁文件、源码和测试复制到工作区外独立目录，`pnpm install --frozen-lockfile`、`pnpm build`、`pnpm check` 和同一组 16 项测试通过。没有设置 `VECTORDB_SIDECAR`，真实数据库由远端安装包内侧车驱动。
- Windows 工作区运行测试时可通过 `VECTORDB_SIDECAR` 指向工作区外构建的侧车，避免 Low 完整度产物写普通临时目录失败；上述独立安装验证不依赖此覆盖。
- 查询插件未发布新版本、未部署；公共库的 GitHub Release 已发布，npm registry 仍待二次认证。

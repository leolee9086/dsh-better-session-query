// memory.changes → 持久任务 → embeddingService → 多字段Dataset。
// 原文事务与向量库不能跨库原子提交，因此以幂等重放+命中时验证原文hash保证一致性。
import { openVectorState } from "./vector-state.js";
import { hashValue, memoryDocuments, imageInput, imageQuery } from "./vector-documents.js";
import { memoryEligible } from "./memory-sync.js";

/**
 * 检索通道 = 来源 × 文档模态。一个通道就是底层 Dataset 里的一个字段加一个索引。
 * 每个通道自己声明“能接受哪几种查询模态”（accepts），不再用"是不是多模态模型"一句话推断。
 *
 * 为什么不是“一个来源一个字段”：图文模型的文本塔输出分布很窄——实测三条毫不相关的
 * 记忆（数据库锁 / 存档胶片 / 生日）两两文本余弦全在 0.92 以上（0.9638/0.9597/0.9298），
 * 文本-文本几乎没有分辨力；而纯文本模型同一组测试是 0.6759 / 0.0304 / -0.1208。
 * 把两者挤进同一条通道，就是用噪声盖掉真正在排序的那一路。
 *
 * 能力默认值按来源形状给，来源可以用 `capabilities` 显式覆盖：
 *   `"text->text" | "text->image" | "image->text" | "image->image"`，值为 true 表示可用。
 * 图文来源的 text→text 默认关闭（上面那条实测），但如果模型卡确实支持，来源可以自己声明打开——
 * 不能因为"它是多模态模型"就一律关掉。
 */
function capabilitiesOf(source) {
  const declared = source.capabilities ?? {};
  const multimodal = Array.isArray(source.modalities) && source.modalities.includes("image");
  const fallback = multimodal
    ? { "image->text": true, "text->image": true, "image->image": true, "text->text": false }
    : { "text->text": true };
  return { ...fallback, ...declared };
}

function channelsOf(source) {
  const capabilities = capabilitiesOf(source);
  const modalities = Array.isArray(source.modalities) ? source.modalities : [];
  const channels = [];
  if (modalities.includes("text")) {
    const accepts = [];
    if (capabilities["text->text"] === true) accepts.push("text");
    if (capabilities["image->text"] === true) accepts.push("image");
    // 一条查询都接不了的通道不建：空索引只会白占空间与任务。
    if (accepts.length > 0) channels.push({ field: source.field + "_t", modality: "text", accepts, source });
  }
  if (modalities.includes("image")) {
    const accepts = [];
    if (capabilities["text->image"] === true) accepts.push("text");
    if (capabilities["image->image"] === true) accepts.push("image");
    if (accepts.length > 0) channels.push({ field: source.field + "_i", modality: "image", accepts, source });
  }
  return channels;
}

export async function openMemoryVectors({ memory, embeddings, vectorStore, path, options = {}, log = () => {} }) {
  const sources = embeddings.list().filter((source) => source.queryable && !source.precomputed);
  const unique = [...new Map(sources.map((source) => [source.spaceId, source])).values()]
    .sort((a, b) => Number(b.local) - Number(a.local) || a.field.localeCompare(b.field));
  if (!unique.length) throw new Error("没有可查询的嵌入来源");
  const identity = memory.identity();
  const channels = unique.flatMap(channelsOf);
  const generation = hashValue([identity.epoch, channels.map((channel) => [channel.source.spaceId, channel.field, channel.modality]).sort()]);
  const datasetName = "memory_" + generation.slice(0, 32);
  const state = await openVectorState(path);
  const { db, transaction } = state;
  const statement = (sql) => db.prepare(sql);
  db.prepare("INSERT OR IGNORE INTO generations(id,epoch,dataset,sources,created) VALUES(?,?,?,?,?)")
    .run(generation, identity.epoch, datasetName, JSON.stringify(channels), Date.now());
  let closed = false;
  let timer;
  let running;
  const cancellation = new AbortController();
  const handles = new Map();
  let lastError = null;
  let lastRun = null;
  let closing;
  function schema(descriptors) {
    return {
      embeddings: Object.fromEntries(descriptors.map((channel) => [channel.field, { dimension: channel.source.dimension, distanceMetric: "cosine" }])),
      indexes: Object.fromEntries(descriptors.map((channel) => [channel.field, { embedding: channel.field, engine: options.engine ?? "hnsw" }])),
    };
  }
  async function dataset(record = { id: generation, dataset: datasetName, sources: JSON.stringify(channels) }) {
    if (!handles.has(record.id)) {
      const opening = vectorStore.dataset(record.dataset, schema(JSON.parse(record.sources))).catch((error) => { handles.delete(record.id); throw error; });
      handles.set(record.id, opening);
    }
    return handles.get(record.id);
  }
  const cached = (space, inputHash) => statement("SELECT vector FROM vectors WHERE space=? AND input_hash=?").get(space, inputHash);

  function schedule(blockId) {
    const item = memory.get(blockId);
    const docs = item ? memoryDocuments(item, { chunkChars: options.chunkChars, chunkOverlap: options.chunkOverlap }) : [];
    const ids = new Set(docs.map((doc) => doc.id));
    for (const old of statement("SELECT id FROM entities WHERE generation=? AND block_id=?").all(generation, blockId)) {
      if (ids.has(old.id)) continue;
      statement("UPDATE entities SET deleted=1,dirty=1 WHERE generation=? AND id=?").run(generation, old.id);
      statement("DELETE FROM jobs WHERE generation=? AND entity_id=?").run(generation, old.id);
    }
    for (const doc of docs) {
      const old = statement("SELECT * FROM entities WHERE generation=? AND id=?").get(generation, doc.id);
      statement(`INSERT INTO entities(generation,id,block_id,content_hash,input_hash,input) VALUES(?,?,?,?,?,?)
        ON CONFLICT(generation,id) DO UPDATE SET content_hash=excluded.content_hash,input_hash=excluded.input_hash,input=excluded.input,deleted=0,dirty=1`)
        .run(generation, doc.id, blockId, item.contentHash, doc.inputHash, JSON.stringify(doc.input));
      // 一个分片只进与它自己模态相同的通道；文本分片会同时进纯文本通道和图文模型的文本通道（后者留给图找文）。
      const mine = channels.filter((channel) => channel.modality === doc.modality);
      for (const channel of mine) {
        if (cached(channel.source.spaceId, doc.inputHash)) {
          statement("DELETE FROM jobs WHERE generation=? AND entity_id=? AND field=?").run(generation, doc.id, channel.field);
          continue;
        }
        // 同一字节任务的失败冷却保留；新内容立即排队，不继承旧内容的重试延迟。
        const priority = channel.source.id === "local-text" ? 0 : channel.source.local ? 1 : 2;
        statement(`INSERT INTO jobs(generation,entity_id,field,space,source,input_hash,priority) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(generation,entity_id,field) DO UPDATE SET input_hash=excluded.input_hash,
          attempts=CASE WHEN jobs.input_hash=excluded.input_hash THEN jobs.attempts ELSE 0 END,
          next_at=CASE WHEN jobs.input_hash=excluded.input_hash THEN jobs.next_at ELSE 0 END,
          error=CASE WHEN jobs.input_hash=excluded.input_hash THEN jobs.error ELSE NULL END`)
          .run(generation, doc.id, channel.field, channel.source.spaceId, channel.source.id, doc.inputHash, priority);
      }
      if (old?.input_hash !== doc.inputHash) {
        const fields = mine.map((channel) => channel.field);
        for (const job of statement("SELECT field FROM jobs WHERE generation=? AND entity_id=?").all(generation, doc.id)) {
          if (!fields.includes(job.field)) statement("DELETE FROM jobs WHERE generation=? AND entity_id=? AND field=?").run(generation, doc.id, job.field);
        }
      }
    }
  }

  function catchUp(limit = 200) {
    if (memory.identity().epoch !== identity.epoch) throw new Error("原文记忆库已换代，需要重新打开向量同步器");
    const cursor = Number(statement("SELECT cursor FROM generations WHERE id=?").get(generation).cursor);
    const changes = memory.changes({ after: cursor, limit });
    if (!changes.length) return 0;
    transaction(() => {
      for (const blockId of new Set(changes.map((change) => change.blockId))) schedule(blockId);
      // 只有所有任务成功入库才推进游标，中途退出从原位置重放。
      statement("UPDATE generations SET cursor=? WHERE id=?").run(changes.at(-1).revision, generation);
    });
    return changes.length;
  }

  const publishing = new Map();
  function publish(entity) {
    // 不同来源可并行计算，但同一实体的全量替换必须串行，且提交时重读所有缓存字段。
    const previous = publishing.get(entity.id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const latest = statement("SELECT * FROM entities WHERE generation=? AND id=?").get(generation, entity.id);
      if (latest) await publishLatest(latest);
    });
    publishing.set(entity.id, next);
    return next.finally(() => { if (publishing.get(entity.id) === next) publishing.delete(entity.id); });
  }
  async function publishLatest(entity) {
    const collection = await dataset();
    const item = memory.get(entity.block_id);
    if (entity.deleted || !item || item.contentHash !== entity.content_hash) {
      await collection.deleteEntities([entity.id], { durability: "sync" });
    } else {
      const modality = JSON.parse(entity.input).image === undefined ? "text" : "image";
      const vectors = {};
      for (const channel of channels.filter((entry) => entry.modality === modality)) {
        const hit = cached(channel.source.spaceId, entity.input_hash);
        if (hit) vectors[channel.field] = JSON.parse(hit.vector);
      }
      if (Object.keys(vectors).length) {
        await collection.upsertEntities([{ id: entity.id, embeddings: vectors, meta: {
          blockId: item.blockId, contentHash: item.contentHash, inputHash: entity.input_hash,
          modality, generation,
        } }], { durability: "sync" });
      } else await collection.deleteEntities([entity.id], { durability: "sync" });
    }
    // 本次网络等待期间原文可能又变；dirty只清这次提交的实体版本。
    statement("UPDATE entities SET dirty=0 WHERE generation=? AND id=? AND input_hash=? AND content_hash=? AND deleted=?")
      .run(generation, entity.id, entity.input_hash, entity.content_hash, entity.deleted);
  }

  async function execute(job) {
    const entity = statement("SELECT * FROM entities WHERE generation=? AND id=? AND deleted=0").get(generation, job.entity_id);
    if (!entity || entity.input_hash !== job.input_hash) return;
    const current = memory.get(entity.block_id);
    if (!current || current.contentHash !== entity.content_hash) { transaction(() => schedule(entity.block_id)); return; }
    const channel = channels.find((item) => item.field === job.field);
    if (!channel) {
      // 通道配置变了（旧任务留着旧字段名）：清掉，等schedule重新按当前通道排队。
      statement("DELETE FROM jobs WHERE generation=? AND entity_id=? AND field=?").run(generation, job.entity_id, job.field);
      return;
    }
    try {
      const source = channel.source;
      let hit = cached(job.space, job.input_hash);
      if (!hit) {
        const input = JSON.parse(entity.input);
        const prepared = input.image === undefined ? { text: input.text } : await imageInput(input, { local: source.local, maxBytes: options.imageMaxBytes });
        const response = await embeddings.embed(source.id, {
          inputs: [prepared], task: "document", signal: cancellation.signal,
          timeoutMs: source.local ? (options.localTimeoutMs ?? 60000) : (options.remoteTimeoutMs ?? 15000),
        });
        if (response.spaceId !== job.space || response.vectors.length !== 1 || response.vectors[0].length !== source.dimension) throw new Error("嵌入空间或维度不匹配");
        const vector = [...response.vectors[0]];
        if (vector.some((value) => !Number.isFinite(value)) || !vector.some((value) => value !== 0)) throw new Error("嵌入向量无效");
        transaction(() => {
          statement("INSERT OR REPLACE INTO vectors(space,input_hash,vector) VALUES(?,?,?)").run(job.space, job.input_hash, JSON.stringify(vector));
          statement("UPDATE entities SET dirty=1 WHERE generation=? AND id=? AND input_hash=?").run(generation, entity.id, job.input_hash);
        });
      }
      // publish失败仍留job；重启后使用缓存重发，不再调用收费嵌入。
      await publish(entity);
      statement("DELETE FROM jobs WHERE generation=? AND entity_id=? AND field=? AND input_hash=?")
        .run(generation, entity.id, job.field, job.input_hash);
    } catch (error) {
      if (cancellation.signal.aborted) return;
      const delay = Math.min(options.retryMaxMs ?? 300000, (options.retryBaseMs ?? 2000) * 2 ** Math.min(job.attempts, 8));
      // 不持久化远端响应正文/图片路径/记忆原文等敏感错误内容。
      statement("UPDATE jobs SET attempts=attempts+1,next_at=?,error=? WHERE generation=? AND entity_id=? AND field=? AND input_hash=?")
        .run(Date.now() + delay, "embedding-or-write-failed", generation, job.entity_id, job.field, job.input_hash);
      lastError = "embedding-or-write-failed";
      log(`记忆向量来源 ${job.source} 暂未完成，已保留重试任务`);
    }
  }

  async function runRound() {
    catchUp(options.changeBatch ?? 200);
    // 崩溃发生在向量写入与任务确认之间时，dirty负责再次幂等提交。
    for (const entity of statement("SELECT * FROM entities WHERE generation=? AND dirty=1 LIMIT ?").all(generation, options.writeBatch ?? 20)) {
      if (closed) return;
      try { await publish(entity); } catch { lastError = "vector-store-unavailable"; break; }
    }
    // 本地与远端各自处理一批；远端超时不会挡住本轮本地兜底写入。
    const jobs = statement("SELECT * FROM jobs WHERE generation=? AND next_at<=? ORDER BY priority,next_at,entity_id LIMIT ?")
      .all(generation, Date.now(), options.jobBatch ?? 16);
    const local = jobs.filter((job) => job.priority < 2);
    const remote = jobs.filter((job) => job.priority >= 2);
    await Promise.all([local, remote].map(async (lane) => {
      for (const job of lane) { if (closed) break; await execute(job); }
    }));
    lastRun = Date.now();
  }
  function tick() {
    if (closed) return Promise.resolve();
    if (running) return running;
    running = runRound().catch((error) => { lastError = "sync-round-failed"; throw error; }).finally(() => { running = undefined; });
    return running;
  }
  function start() {
    if (closed || timer) return;
    const loop = async () => {
      try { await tick(); } catch { log("记忆向量同步暂时失败，持久任务保留"); }
      if (!closed) { timer = setTimeout(loop, options.intervalMs ?? 1000); timer.unref?.(); }
    };
    // 提前赋值防止start重入。
    timer = setTimeout(loop, 0); timer.unref?.();
  }
  function status() {
    const current = statement("SELECT cursor FROM generations WHERE id=?").get(generation);
    const jobs = statement("SELECT field,COUNT(*) AS pending,SUM(CASE WHEN attempts>0 THEN 1 ELSE 0 END) AS retrying FROM jobs WHERE generation=? GROUP BY field").all(generation);
    const entities = Number(statement("SELECT COUNT(*) AS n FROM entities WHERE generation=? AND deleted=0").get(generation).n);
    const dirty = Number(statement("SELECT COUNT(*) AS n FROM entities WHERE generation=? AND dirty=1").get(generation).n);
    const coverage = channels.map((channel) => ({
      sourceId: channel.source.id, spaceId: channel.source.spaceId, field: channel.field, modality: channel.modality,
      // 覆盖数只数这个通道自己模态的分片：整个空间的实体数会让两条通道报同一个数字，看不出谁漏了。
      // input 里的 "image" 只可能是键（正文里的引号会被 JSON 转义成 \"），所以 instr 判断是可靠的。
      indexed: Number(statement(`SELECT COUNT(*) AS n FROM entities e JOIN vectors v ON v.input_hash=e.input_hash AND v.space=?
        WHERE e.generation=? AND e.deleted=0 AND e.dirty=0 AND instr(e.input, '"image"') ${channel.modality === "image" ? ">" : "="} 0`)
        .get(channel.source.spaceId, generation).n),
      pending: Number(jobs.find((job) => job.field === channel.field)?.pending ?? 0),
      retrying: Number(jobs.find((job) => job.field === channel.field)?.retrying ?? 0),
    }));
    return { generation, dataset: datasetName, cursor: Number(current.cursor), sourceRevision: memory.identity().revision,
      entities, dirty, pending: jobs.reduce((sum, job) => sum + Number(job.pending), 0), coverage, lastRun, lastError, closed };
  }
  async function search({ query, image, limit = 20, signal, ...filters } = {}) {
    if (closed) throw new Error("向量同步器已关闭");
    const text = typeof query === "string" ? query.trim() : "";
    // 图片线索在入口换成内部形态：工具参数与验收脚本都传 {path, sha256}，底层统一按 {image} 用。
    const imageClue = image === undefined ? undefined : imageQuery(image);
    // 图文混合查询：两条线索各自参与，不再"有图就丢文字"。
    const queryModalities = [];
    if (text !== "") queryModalities.push("text");
    if (imageClue !== undefined) queryModalities.push("image");
    if (queryModalities.length === 0) return { items: [], failures: [], truncated: false };
    const combined = AbortSignal.any([cancellation.signal, ...(signal ? [signal] : [])]);
    const failures = [];
    // 模型配置换代时保留最近一代：谷换期还能搜到旧向量。
    // 查询向量必须按**那一代自己的来源**算（同id不同revision的空间不同，不能混用）。
    const records = [{ id: generation, dataset: datasetName, sources: JSON.stringify(channels) },
      ...statement("SELECT * FROM generations WHERE epoch=? AND id<>? ORDER BY created DESC LIMIT 1").all(identity.epoch, generation)];
    const vectors = new Map();
    const queryVector = (source, modality) => {
      const key = source.id + ":" + source.spaceId + ":" + modality;
      if (!vectors.has(key)) {
        vectors.set(key, (async () => {
          const input = modality === "text" ? { text } : await imageInput(imageClue, { local: source.local, maxBytes: options.imageMaxBytes });
          const output = await embeddings.embed(source.id, { inputs: [input], task: "query", signal: combined, timeoutMs: options.queryTimeoutMs ?? 8000 });
          if (output.spaceId !== source.spaceId) throw new Error("查询空间不一致");
          return output.vectors[0];
        })());
      }
      return vectors.get(key);
    };
    // 融合分：每个「查询模态 × 通道 × 分片」的命中按名次贡献 1/(常数+名次)。
    // 跨空间、跨模型的原始余弦不参与比较——量纲不同，比大小没有意义；similarity 只留作诊断与阈值。
    const fusionConstant = Number(options.rrfConstant ?? 60);
    const found = new Map();
    // 同一份内容可能同时存在于旧代与新代索引里（换代迁移期），也可能被两条查询模态同时命中。
    // 按「查询模态 × 来源 × 文档模态 × 实体」去重：换代是同一份内容的副本，不能重复计分；
    // 不同分片、不同查询模态才是真的多路证据。
    const seenEvidence = new Map();
    const remember = (item, hit, evidence, rank) => {
      const keys = seenEvidence.get(item.blockId) ?? new Set();
      seenEvidence.set(item.blockId, keys);
      const fresh = evidence.filter((entry) => {
        const key = [entry.queryModality, entry.sourceId, entry.modality, hit.id ?? ""].join("|");
        if (keys.has(key)) return false;
        keys.add(key);
        return true;
      });
      if (fresh.length === 0) return;
      const candidate = found.get(item.blockId) ?? {
        ...item, similarity: 0, relevance: 0, vectorScore: 0, fusionScore: 0, vectorSources: [], matchedModality: undefined,
      };
      candidate.similarity = Math.max(candidate.similarity, ...fresh.map((entry) => entry.similarity));
      // relevance 是"这一路内部的相对位置"，不是原始余弦：把每一路各自映射到 [0,1]，
      // 才能在不比较跨模型量纲的前提下说"这条在这一路里有多靠前"。
      candidate.relevance = Math.max(candidate.relevance, ...fresh.map((entry) => entry.relevance));
      // 同一记忆的多个分片、多条通道命中都要留证据：只留最高那一条会丢掉"另一路也命中"。
      candidate.vectorSources.push(...fresh);
      candidate.vectorScore = Math.max(candidate.vectorScore, Number(hit.score ?? 0));
      candidate.fusionScore += 1 / (fusionConstant + rank + 1);
      candidate.matchedModality ??= hit.meta?.modality;
      found.set(item.blockId, candidate);
    };
    let truncated = false;
    for (const record of records) {
      const recordChannels = JSON.parse(record.sources);
      let collection;
      try { collection = await dataset(record); } catch { failures.push({ sourceId: "vectorStore", reason: "index-unavailable" }); continue; }
      const max = options.maxCandidates ?? 2000;
      // 首次取多少候选、用完不够时怎么扩：都是没有数据支撑的经验值，走配置。
      const factor = Math.max(1, Math.trunc(Number(options.candidateFactor) || 4));
      const floor = Math.max(1, Math.trunc(Number(options.candidateFloor) || 40));
      let count = Math.min(max, Math.max(limit * factor, floor));
      for (;;) {
        let filled = false;
        for (const modality of queryModalities) {
          const lanes = [];
          for (const channel of recordChannels) {
            if (!Array.isArray(channel.accepts) || !channel.accepts.includes(modality)) continue;
            try {
              lanes.push({ index: channel.field, vector: await queryVector(channel.source, modality), weight: channel.source.weight, channel, modality });
            } catch { failures.push({ sourceId: channel.source.id, reason: "query-embedding-unavailable" }); }
          }
          if (lanes.length === 0) continue;
          try {
            const result = await collection.fuseSearch(
              lanes.map(({ channel, modality: laneModality, ...lane }) => ({ ...lane, topK: count })),
              { topK: count, allowPartial: true },
            );
            failures.push(...(result.failures ?? []).map((failure) => ({
              sourceId: recordChannels.find((entry) => entry.field === failure.index)?.source.id ?? failure.index,
              reason: "index-unavailable",
            })));
            if (result.results.length >= count) filled = true;
            // 每一路（字段）在本轮里的相似度区间：用来把这一路映射到 [0,1]。
            // 只有一条候选的路段没有分辨力，映射结果恒为 0——不能让它靠"唯一候选"白拿名次。
            const ranges = new Map();
            for (const hit of result.results) {
              for (const entry of hit.sources ?? []) {
                const similarity = 1 - entry.distance;
                const range = ranges.get(entry.index) ?? { min: similarity, max: similarity };
                range.min = Math.min(range.min, similarity);
                range.max = Math.max(range.max, similarity);
                ranges.set(entry.index, range);
              }
            }
            const relevanceOf = (field, similarity) => {
              const range = ranges.get(field);
              if (range === undefined || !(range.max > range.min)) return 0;
              return (similarity - range.min) / (range.max - range.min);
            };
            result.results.forEach((hit, rank) => {
              const item = memory.get(hit.meta?.blockId, filters);
              // 命中后必须回原文复核：删掉或改过的记忆，旧向量一律不算数。
              if (!memoryEligible(item, filters) || item.contentHash !== hit.meta?.contentHash) return;
              const evidence = (hit.sources ?? []).map((entry) => {
                const channel = recordChannels.find((candidate) => candidate.field === entry.index);
                const similarity = 1 - entry.distance;
                return { queryModality: modality, sourceId: channel?.source.id, spaceId: channel?.source.spaceId,
                  modality: channel?.modality, field: entry.index, rank: entry.rank, score: entry.score,
                  distance: entry.distance, similarity, relevance: relevanceOf(entry.index, similarity) };
              });
              remember(item, hit, evidence, rank);
            });
          } catch { failures.push({ sourceId: "vectorStore", reason: "index-unavailable" }); }
        }
        // 候选够用了就停；这一轮都没被填满说明索引里没有更多，扩大也没有意义。
        if (found.size >= limit || !filled) break;
        // 达到上限就诚实报告截断，不声称已经查尽。
        if (count >= max) { truncated = true; break; }
        count = Math.min(max, count * 2);
      }
    }
    // 排序策略。两种都是没有数据支撑的选择，所以走配置，等基线评测再定默认：
    //   lane-normalized（默认）：先看"在各自那一路里有多靠前"（按路归一化），再看融合排名；
    //   fusion：纯按融合排名（1/(常数+名次) 累加），归一化相关度只作诊断。
    // 两种都**不比原始余弦**——跨模型量纲比大小没有意义。
    const order = options.relevanceMode === "fusion"
      ? (a, b) => b.fusionScore - a.fusionScore || b.relevance - a.relevance || b.time - a.time
      : (a, b) => b.relevance - a.relevance || b.fusionScore - a.fusionScore || b.time - a.time;
    return {
      items: [...found.values()].sort(order).slice(0, limit),
      failures,
      truncated,
    };
  }
  const searches = new Set();
  function trackedSearch(request) {
    const promise = search(request);
    searches.add(promise);
    return promise.finally(() => searches.delete(promise));
  }
  return { tick, start, status, search: trackedSearch,
    async drain({ maxRounds = 1000 } = {}) {
      for (let round = 0; round < maxRounds; round++) {
        await tick();
        const snapshot = status();
        if (snapshot.cursor >= snapshot.sourceRevision && snapshot.pending === 0 && snapshot.dirty === 0) return snapshot;
        if (snapshot.cursor >= snapshot.sourceRevision && statement("SELECT 1 FROM jobs WHERE generation=? AND next_at<=? LIMIT 1").get(generation, Date.now()) === undefined) return snapshot;
      }
      return status();
    },
    retry() { statement("UPDATE jobs SET next_at=0 WHERE generation=?").run(generation); },
    close() {
      if (closing) return closing;
      closed = true; clearTimeout(timer); cancellation.abort(new Error("向量同步关闭"));
      closing = (async () => {
        await Promise.allSettled([running, ...searches]);
        state.close();
      })();
      return closing;
    },
  };
}

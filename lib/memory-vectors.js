// memory.changes → 持久任务 → embeddingService → 多字段Dataset。
// 原文事务与向量库不能跨库原子提交，因此以幂等重放+命中时验证原文hash保证一致性。
import { openVectorState } from "./vector-state.js";
import { hashValue, memoryDocuments, imageInput } from "./vector-documents.js";
import { memoryEligible } from "./memory-sync.js";

/**
 * 检索通道 = 来源 × 模态。一个通道就是底层Dataset里的一个字段加一个索引。
 *
 * 为什么不是“一个来源一个字段”：图文模型的文本塔输出分布很窄——实测三条毫不相关的
 * 记忆（数据库锁 / 存档胶片 / 生日）两两文本余弦全在 0.92 以上（0.9638/0.9597/0.9298），
 * 文本-文本几乎没有分辨力；而纯文本模型同一组测试是 0.6759 / 0.0304 / -0.1208。
 * 把两者挤进同一条通道，就是用噪声盖掉真正在排序的那一路。
 *
 * 所以每个通道只用在它的强项上：
 *   textRetrieval=true 的文本通道：纯文本模型，负责“文字找文字”；
 *   textRetrieval=false 的文本通道：图文模型的文本塔，只接受图片查询（图找文）；
 *   图片通道：接受文字或图片查询（文找图、图找图）。
 */
function channelsOf(source) {
  const channels = [];
  const multimodal = source.modalities.includes("image");
  if (source.modalities.includes("text")) {
    channels.push({ field: source.field + "_t", modality: "text", textRetrieval: !multimodal, source });
  }
  if (multimodal) channels.push({ field: source.field + "_i", modality: "image", textRetrieval: false, source });
  return channels;
}

/** 本次查询该走哪些通道。 */
function servesQuery(channel, modality) {
  // 查询模态必须是这个来源支持的模态：拿图片去问纯文本模型，连查询向量都算不出来。
  if (!channel.source.modalities.includes(modality)) return false;
  // 图片查询：图找图与图找文都行（同一个图文空间里，图片向量与文本向量本来就可比）。
  if (modality === "image") return true;
  // 文字查询：文找图，加上纯文本模型的文本通道。
  return channel.modality === "image" || channel.textRetrieval === true;
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
    const docs = item ? memoryDocuments(item) : [];
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
        const prepared = input.image === undefined ? { text: input.text } : await imageInput(input, { local: source.local });
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
    const modality = image === undefined ? "text" : "image";
    if (modality === "text" && !query?.trim()) return { items: [], failures: [], truncated: false };
    const combined = AbortSignal.any([cancellation.signal, ...(signal ? [signal] : [])]);
    const failures = [];
    // 模型配置换代时保留最近一代：谷换期还能搜到旧向量。
    // 查询向量必须按**那一代自己的来源**算（同id不同revision的空间不同，不能混用）。
    const records = [{ id: generation, dataset: datasetName, sources: JSON.stringify(channels) },
      ...statement("SELECT * FROM generations WHERE epoch=? AND id<>? ORDER BY created DESC LIMIT 1").all(identity.epoch, generation)];
    const vectors = new Map();
    const queryVector = (source) => {
      const key = source.id + ":" + source.spaceId + ":" + modality;
      if (!vectors.has(key)) {
        vectors.set(key, (async () => {
          const input = modality === "text" ? { text: query } : await imageInput(image, { local: source.local });
          const output = await embeddings.embed(source.id, { inputs: [input], task: "query", signal: combined, timeoutMs: options.queryTimeoutMs ?? 8000 });
          if (output.spaceId !== source.spaceId) throw new Error("查询空间不一致");
          return output.vectors[0];
        })());
      }
      return vectors.get(key);
    };
    const found = new Map();
    let truncated = false;
    for (const record of records) {
      const recordChannels = JSON.parse(record.sources);
      const lanes = [];
      for (const channel of recordChannels) {
        if (!servesQuery(channel, modality)) continue;
        try {
          lanes.push({ index: channel.field, vector: await queryVector(channel.source), weight: channel.source.weight, channel });
        } catch { failures.push({ sourceId: channel.source.id, reason: "query-embedding-unavailable" }); }
      }
      if (!lanes.length) continue;
      try {
        const collection = await dataset(record);
        const max = options.maxCandidates ?? 2000;
        let count = Math.min(max, Math.max(limit * 4, 40));
        while (true) {
          const result = await collection.fuseSearch(lanes.map(({ channel, ...lane }) => ({ ...lane, topK: count })), { topK: count, allowPartial: true });
          failures.push(...(result.failures ?? []).map((failure) => ({ sourceId: recordChannels.find((item) => item.field === failure.index)?.source.id ?? failure.index, reason: "index-unavailable" })));
          for (const hit of result.results) {
            const item = memory.get(hit.meta?.blockId, filters);
            if (!memoryEligible(item, filters) || item.contentHash !== hit.meta?.contentHash) continue;
            const inputs = (hit.sources ?? []).map((entry) => {
              const channel = recordChannels.find((candidate) => candidate.field === entry.index);
              return { sourceId: channel?.source.id, spaceId: channel?.source.spaceId, modality: channel?.modality,
                rank: entry.rank, score: entry.score, distance: entry.distance, similarity: 1 - entry.distance };
            });
            // 两个分数各管一件事，不要拿一个去否定另一个：
            //   similarity —— 这条候选“有多相关”，用来排序、设准入阈值、做诊断；
            //   vectorScore（RRF）—— “有多少路检索支持它”，跨异构来源融合时才有意义。
            //   它编码的是排名而不是相关度，候选少的时候几条挤在一起是正常现象，不是缺陷。
            // 这里用 similarity 排序（平分时看 RRF）只是**当前的选择**：
            // 还没有独立标注的基准能证明它优于按 RRF 排序，所以别把这句话当成已验证的结论。
            const similarity = inputs.length ? Math.max(...inputs.map((item) => item.similarity)) : 0;
            const candidate = { ...item, similarity, vectorScore: hit.score, vectorSources: inputs, matchedModality: hit.meta.modality };
            const previous = found.get(item.blockId);
            if (!previous || previous.similarity < candidate.similarity
              || (previous.similarity === candidate.similarity && previous.vectorScore < candidate.vectorScore)) {
              found.set(item.blockId, candidate);
            }
          }
          if (result.results.length < count) break;
          // 筛选后不足/新鲜不足时扩大候选；达到上限诚实报告截断，不声称完全查尽。
          if ([...found.values()].filter((item) => item.fresh).length >= limit) break;
          if (count >= max) { truncated = true; break; }
          count = Math.min(max, count * 2);
        }
      } catch { failures.push({ sourceId: "vectorStore", reason: "index-unavailable" }); }
    }
    return { items: [...found.values()].sort((a, b) => Number(b.fresh) - Number(a.fresh) || b.similarity - a.similarity).slice(0, limit), failures, truncated };
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

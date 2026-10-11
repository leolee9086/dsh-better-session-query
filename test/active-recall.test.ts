import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryStore, MEMORY_TOOL } from '../lib/memory.js';
import { hybridRecall } from '@leolee9086/dsh-hybrid-recall';
import type { RecallRequest } from '@leolee9086/dsh-hybrid-recall';
import { createActiveRecall } from '../lib/active-recall.js';
import { formatRecalled } from '../lib/index.js';

const ttlMs = 7200000;
const block = (id: string, a: string, tag = '环境', perspective = 'ego', surface = 'log-only') => ({
  id, type: 'tool-call', seq: 1, time: Date.now(), surface,
  text: MEMORY_TOOL + ' ' + JSON.stringify({ q: '包管理器', a, tag, perspective }),
});

test('仅自然语言可召回，关键词兼容且保留会话、标签和视角过滤', async () => {
  const memory = await openMemoryStore();
  try {
    memory.ingest({ sessionId: 'other', blocks: [block('kept', '使用pnpm'), block('wrong-tag', '隐藏标签', '其它'), block('wrong-view', '隐藏视角', '环境', 'id')] });
    memory.ingest({ sessionId: 'active', blocks: [block('visible', '已经在眼前', '环境', 'ego', 'current')] });
    const tool = createActiveRecall({ recall: request => hybridRecall({ memory }, request), format: formatRecalled, ttlMs });
    for (const input of [{ query: ' 包管理器 ', keywords: [' '] }, { keywords: [' 包管理器 '] }]) {
      const result = await tool.execute({ ...input, tag: ' 环境 ', perspective: ' ego ' }, { agent: { session: { id: 'active' } } });
      assert.match(result, /A: 使用pnpm/);
      assert.doesNotMatch(result, /隐藏标签|隐藏视角|已经在眼前|ERROR/);
      assert.match(result, /暂不可用来源: vectorStore/);
    }
    assert.equal(tool.presentCall({ query: ' 包管理器 ' }).title, '回忆: 包管理器');
  } finally { memory.close(); }
});

test('等待异步语义候选，来源失败仍返回真实关键词结果', async () => {
  const memory = await openMemoryStore();
  try {
    memory.ingest({ sessionId: 'other', blocks: [block('memory', '使用pnpm')] });
    const vectors = { async search(request: RecallRequest) {
      await Promise.resolve();
      if (request.query === '包管理器') throw new Error('offline');
      return { items: [{ ...memory.get('memory'), vectorSources: [{ sourceId: 'test-space', similarity: 0.8 }] }] };
    } };
    const tool = createActiveRecall({ recall: request => hybridRecall({ memory, vectors }, request), format: formatRecalled, ttlMs });
    const semantic = await tool.execute({ query: 'dependency tooling' });
    assert.match(semantic, /A: 使用pnpm/);
    assert.match(semantic, /召回依据: vector \(test-space\)/);
    const fallback = await tool.execute({ query: '包管理器' });
    assert.match(fallback, /A: 使用pnpm/);
    assert.match(fallback, /暂不可用来源: vectorStore/);
  } finally { memory.close(); }
});

test('图片单独或配合文字均进入召回来源，不因缺 keywords 提前拒绝', async () => {
  const memory = await openMemoryStore();
  const image = { path: 'D:/fixture.png', sha256: 'a'.repeat(64) };
  const seen: RecallRequest[] = [];
  try {
    // 只验证入口传递；这里不读取图片、不声称下游 path/image 缺口已修复。
    const vectors = { async search(request: RecallRequest) { seen.push(request); return { items: [] }; } };
    const tool = createActiveRecall({ recall: request => hybridRecall({ memory, vectors }, request), format: formatRecalled, ttlMs });
    for (const query of [undefined, '这张照片']) {
      const result = await tool.execute({ image, query });
      assert.doesNotMatch(result, /ERROR/);
      assert.match(result, /图片/);
    }
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0].image, image);
    assert.deepEqual(seen[1].image, image);
    assert.equal(seen[1].query, '这张照片');
    assert.equal(tool.presentCall({ image }).title, '回忆: 图片');
  } finally { memory.close(); }
});

test('空线索不触发召回，来源初始化失败转为工具错误', async () => {
  let calls = 0;
  const tool = createActiveRecall({ recall: async () => { calls++; throw new Error('记忆库不可用'); }, format: formatRecalled, ttlMs });
  for (const args of [undefined, {}, { keywords: [' ', ''], query: ' ' }]) {
    assert.match(await tool.execute(args), /ERROR: .*至少提供一种非空线索/);
  }
  assert.equal(calls, 0);
  assert.equal(await tool.execute({ query: '有效线索' }), 'ERROR: 记忆库不可用');
  assert.equal(calls, 1);
});

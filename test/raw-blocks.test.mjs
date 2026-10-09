import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractRawBlocks, extractBlocks, isSearchable } from '../lib/blocks.js'
test('raw traversal preserves text, nested paths, structured arguments and signatures independently of index flags', () => {
  const event = { seq: 7, type: 'assistant/message', time: 1, data: { content: [
    { type: 'text', text: '  🧵content\n' }, { type: 'reasoning', text: ' reason ', signature: 'opaque' },
    { type: 'tool-call', callId: 'c1', name: 'read', arguments: { path: 'x', count: 2 } },
    { type: 'tool-result', callId: 'c1', content: [{ type: 'text', text: ' result ' }] },
  ] } }
  const blocks = extractRawBlocks(event, { sessionId: 's' })
  assert.equal(blocks[0].text, '  🧵content\n'); assert.equal(blocks[0].role, 'assistant')
  assert.deepEqual(blocks[0].textMapping.original, [0, event.data.content[0].text.length])
  assert.equal(blocks[1].signed, true); assert.equal(blocks[1].raw.signature, 'opaque')
  assert.deepEqual(blocks[2].arguments, { path: 'x', count: 2 }); assert.equal(blocks.at(-1).path, '3.0'); assert.equal(blocks.at(-1).callId, 'c1')
  assert.throws(() => { blocks[2].arguments.count = 4 }, TypeError)
  assert.equal(event.data.content[2].arguments.count, 2)
  const indexed = extractBlocks(event, { sessionId: 's', include: { text: true, reasoning: false, toolCall: false, toolResult: false, image: false, file: false } })
  assert.equal(indexed[0].text, '🧵content'); assert.equal(isSearchable(indexed.find(block => block.type === 'reasoning'), { reasoning: false }), false)
})
test('raw reads reject invented event identities', () => {
  assert.throws(() => extractRawBlocks({ data: {} }, { sessionId: 's' }), /committed event seq/)
})

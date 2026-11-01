// surface 折叠的规范对照：与 DSH 的 foldSurface 逐位比对。
// 运行方式: node --experimental-transform-types test/surface-oracle.mjs
import { createRequire } from 'node:module'
import { globSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSurfaceFold } from '../lib/surface.js'

const require = createRequire(import.meta.url)
const rebec = require('D:/dev/rebec/rebec.node')
// 基准实现来自 harness 源码树。它不在的话(别人机器上)就跳过,不要假装通过。
const HARNESS_SURFACE = process.env.DSH_HARNESS_SURFACE ?? 'D:/dev/deepseek-harness/packages/core/session/src/surface.ts'
let foldSurface
try {
  ({ foldSurface } = await import(pathToFileURL(HARNESS_SURFACE).href))
} catch (error) {
  console.log('SKIP: 找不到 harness 的 surface.ts（设置 DSH_HARNESS_SURFACE 指向它）:', error.message)
  process.exit(0)
}

let failures = 0
function check(ok, label, detail) {
  if (ok) console.log('  PASS', label)
  else { failures += 1; console.log('  FAIL', label, detail ?? '') }
}

function readAllEvents(path) {
  let offset = 0
  const events = []
  for (;;) {
    const win = JSON.parse(rebec.sessionScanLog(path, offset, 4000))
    events.push(...win.events)
    offset = win.nextOffset
    if (win.done) break
  }
  return events
}

const home = process.env.USERPROFILE
const sessionsRoot = join(home, '.dsh', 'sessions')
// 固定挑几个不同规模的真实会话
const ids = [
  'session-54388bf1-1284-4cf1-8e0d-5a3b60ceb253',
  'session-3510e9c7-4e82-46e6-99bd-ef29eff8946d',
  'session-1e02ffc7-d94a-477c-961a-7d8dde1846f0',
]

for (const id of ids) {
  const hits = globSync('*/' + id + '/session.v4.jsonl.zstd', { cwd: sessionsRoot })
  if (hits.length === 0) { console.log('skip', id); continue }
  const events = readAllEvents(join(sessionsRoot, hits[0]))
  console.log('== ' + id + ' (' + events.length + ' 事件)')

  let expected
  try {
    expected = foldSurface(events).nodes
  } catch (error) {
    console.log('  skip: foldSurface 拒绝 —', error.message)
    continue
  }

  const fold = createSurfaceFold()
  let inconsistent = 0
  for (const event of events) {
    const result = fold.apply(event)
    if (result.inconsistent) inconsistent += 1
  }
  const got = fold.nodes()

  check(got.length === expected.length, '表层长度一致', got.length + ' vs ' + expected.length)
  let firstDiff = -1
  for (let i = 0; i < Math.min(got.length, expected.length); i += 1) {
    if (got[i] !== expected[i]) { firstDiff = i; break }
  }
  check(firstDiff === -1, '表层 seq 逐位一致', firstDiff === -1 ? '' : '#' + firstDiff + ' ours=' + got[firstDiff] + ' dsh=' + expected[firstDiff])
  check(inconsistent === 0, '没有走退化分支', String(inconsistent))
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES')
process.exitCode = failures === 0 ? 0 : 1

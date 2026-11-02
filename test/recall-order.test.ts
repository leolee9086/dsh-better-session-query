// test/recall-order.test.ts — 输出顺序：相关优先，新鲜只在并列时作偏好。
//
// 这条策略暂时留在插件这一层（共享库当前安装版仍按新鲜优先排序），所以要有自己的测试：
// 哪天依赖升级到同一语义、这个模块被删掉，测试也一起删。
import test from "node:test";
import assert from "node:assert/strict";
import { orderRecalled } from "../lib/recall-order.js";

test("相关优先：更相关的旧记忆不会被刚记下的弱候选压过", () => {
  const items = [
    { blockId: "fresh-weak", fresh: true, time: 9, recallScore: 1 / 62 },
    { blockId: "relevant-old", fresh: false, time: 1, recallScore: 1 / 61 },
  ];
  assert.deepEqual(orderRecalled(items, 2).map((item) => item.blockId), ["relevant-old", "fresh-weak"]);
});

test("并列时新鲜优先，再按时间", () => {
  const items = [
    { blockId: "stale-newer", fresh: false, time: 8, recallScore: 0.5 },
    { blockId: "fresh", fresh: true, time: 2, recallScore: 0.5 },
    { blockId: "stale-older", fresh: false, time: 1, recallScore: 0.5 },
  ];
  assert.deepEqual(orderRecalled(items, 3).map((item) => item.blockId), ["fresh", "stale-newer", "stale-older"]);
});

test("按 limit 截断，且不改动入参", () => {
  const items = [
    { blockId: "a", fresh: true, time: 3, recallScore: 0.3 },
    { blockId: "b", fresh: true, time: 2, recallScore: 0.2 },
    { blockId: "c", fresh: true, time: 1, recallScore: 0.1 },
  ];
  const snapshot = structuredClone(items);
  assert.deepEqual(orderRecalled(items, 2).map((item) => item.blockId), ["a", "b"]);
  assert.deepEqual(items, snapshot);
  assert.equal(orderRecalled(undefined as any, 3).length, 0, "空输入返回空数组，不炸");
});

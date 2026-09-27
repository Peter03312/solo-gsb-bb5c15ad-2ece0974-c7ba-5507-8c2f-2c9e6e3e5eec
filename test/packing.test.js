'use strict';

const assert = require('assert');
const { packItems, validatePacking, collectProps, MAX_PACK_ITEMS } = require('../packing');

const S = (id, props) => ({ id, name: id, props });

/** 构造已校验载荷并求解的快捷函数 */
function run(body) {
  const v = validatePacking(body);
  assert.deepStrictEqual(v.errors, []);
  return packItems(v.items, v.capacity, v.pairs);
}

/* 1. 空场景 / 无道具：校验报错，不求解 */
{
  const v = validatePacking({ scenes: [], packing: { capacity: 10, weights: {}, pairs: [] } });
  assert.ok(v.errors.some(e => e.includes('至少') || e.includes('道具')));
  const v2 = validatePacking({ scenes: [S('A', [])], packing: { capacity: 10, weights: {}, pairs: [] } });
  assert.ok(v2.errors.some(e => e.includes('道具')));
}

/* 2. 场景道具汇总去重：保持场景序、场景内顺序，同名只保留首次 */
{
  const names = collectProps([
    S('s1', ['灯笼', '地毯', '灯笼']),
    S('s2', ['桌子', '灯笼', '椅子']),
  ]);
  assert.deepStrictEqual(names, ['灯笼', '地毯', '桌子', '椅子']);
}

/* 3. 单件道具：一箱；字段完整 */
{
  const r = run({ scenes: [S('A', ['灯'])], packing: { capacity: 10, weights: { 灯: 3 }, pairs: [] } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.totalBins, 1);
  assert.strictEqual(r.totalWeight, 3);
  assert.deepStrictEqual(r.bins, [{ items: ['灯'], weight: 3 }]);
}

/* 4. 全部装得下时只一箱，且按录入顺序列出 */
{
  const r = run({
    scenes: [S('A', ['甲', '乙', '丙'])],
    packing: { capacity: 10, weights: { 甲: 2, 乙: 3, 丙: 4 }, pairs: [] },
  });
  assert.strictEqual(r.totalBins, 1);
  assert.deepStrictEqual(r.bins[0].items, ['甲', '乙', '丙']);
  assert.strictEqual(r.bins[0].weight, 9);
}

/* 5. 经典装箱：4 件重量 5/5/6/4，承重 10 → 最少 2 箱 */
{
  const r = run({
    scenes: [S('s', ['A', 'B', 'C', 'D'])],
    packing: { capacity: 10, weights: { A: 5, B: 5, C: 6, D: 4 }, pairs: [] },
  });
  assert.strictEqual(r.totalBins, 2);
  // 每箱重量不超限，每件恰好出现一次
  const seen = [];
  for (const b of r.bins) {
    assert.ok(b.weight <= 10);
    seen.push(...b.items);
  }
  assert.deepStrictEqual(seen.sort(), ['A', 'B', 'C', 'D']);
}

/* 6. 互斥对：A、B 不能同箱时必须拆箱 */
{
  // 承重 100、三件各 1，无互斥只需 1 箱
  const free = run({
    scenes: [S('s', ['A', 'B', 'C'])],
    packing: { capacity: 100, weights: { A: 1, B: 1, C: 1 }, pairs: [] },
  });
  assert.strictEqual(free.totalBins, 1);

  // A-B 互斥：至少 2 箱；任一箱不得同时含 A、B
  const r = run({
    scenes: [S('s', ['A', 'B', 'C'])],
    packing: { capacity: 100, weights: { A: 1, B: 1, C: 1 }, pairs: [{ a: 'A', b: 'B' }] },
  });
  assert.strictEqual(r.totalBins, 2);
  for (const b of r.bins) assert.ok(!(b.items.includes('A') && b.items.includes('B')));
}

/* 7. 互斥三角：A-B、B-C、A-C 全互斥 → 每件一箱，共 3 箱 */
{
  const r = run({
    scenes: [S('s', ['A', 'B', 'C'])],
    packing: { capacity: 100, weights: { A: 1, B: 1, C: 1 },
      pairs: [{ a: 'A', b: 'B' }, { a: 'B', b: 'C' }, { a: 'A', b: 'C' }] },
  });
  assert.strictEqual(r.totalBins, 3);
}

/* 8. 稳定性：箱内按录入顺序，箱间按每箱最早道具的录入顺序 */
{
  const r = run({
    scenes: [S('s', ['A', 'B', 'C', 'D'])],
    packing: { capacity: 10, weights: { A: 6, B: 6, C: 2, D: 2 }, pairs: [] },
  });
  assert.strictEqual(r.totalBins, 2);
  for (const b of r.bins) {
    const idxs = b.items.map(n => ['A', 'B', 'C', 'D'].indexOf(n));
    assert.deepStrictEqual(idxs, idxs.slice().sort((x, y) => x - y));
  }
  // 第一箱必含录入最早的 A
  assert.ok(r.bins[0].items.includes('A'));
  assert.ok(r.bins[0].items[0] === 'A');
  // 确定性：重复求解一致
  const r2 = run({
    scenes: [S('s', ['A', 'B', 'C', 'D'])],
    packing: { capacity: 10, weights: { A: 6, B: 6, C: 2, D: 2 }, pairs: [] },
  });
  assert.deepStrictEqual(r.bins, r2.bins);
}

/* 9. 单件超重：具体提示 */
{
  const v = validatePacking({
    scenes: [S('s', ['A', 'B'])],
    packing: { capacity: 5, weights: { A: 6, B: 1 }, pairs: [] },
  });
  assert.ok(v.errors.some(e => e.includes('A') && e.includes('6') && e.includes('5')));
}

/* 10. 超过 14 件：具体提示件数 */
{
  const props = Array.from({ length: 15 }, (_, i) => `p${i}`);
  const weights = Object.fromEntries(props.map(p => [p, 1]));
  const v = validatePacking({
    scenes: [S('s', props)],
    packing: { capacity: 10, weights, pairs: [] },
  });
  assert.ok(v.errors.some(e => e.includes('15') && e.includes(String(MAX_PACK_ITEMS))));
}

/* 11. 配置无效：承重非正整数、重量缺失/非正整数 */
{
  const v = validatePacking({
    scenes: [S('s', ['A', 'B'])],
    packing: { capacity: 0, weights: { A: 2 }, pairs: [] },
  });
  assert.ok(v.errors.some(e => e.includes('单箱承重')));
  assert.ok(v.errors.some(e => e.includes('B')));

  const v2 = validatePacking({
    scenes: [S('s', ['A'])],
    packing: { capacity: 10, weights: { A: -3 }, pairs: [] },
  });
  assert.ok(v2.errors.some(e => e.includes('A') && e.includes('正整数')));

  const v3 = validatePacking({
    scenes: [S('s', ['A'])],
    packing: { capacity: 10, weights: { A: 1.5 }, pairs: [] },
  });
  assert.ok(v3.errors.some(e => e.includes('A')));
}

/* 12. 互斥对配置无效：引用不存在的道具、自身互斥、重复对去重 */
{
  const v = validatePacking({
    scenes: [S('s', ['A', 'B'])],
    packing: { capacity: 10, weights: { A: 1, B: 1 }, pairs: [{ a: 'A', b: 'X' }] },
  });
  assert.ok(v.errors.some(e => e.includes('X')));

  const self = validatePacking({
    scenes: [S('s', ['A'])],
    packing: { capacity: 10, weights: { A: 1 }, pairs: [{ a: 'A', b: 'A' }] },
  });
  assert.ok(self.errors.some(e => e.includes('相同')));

  const dup = validatePacking({
    scenes: [S('s', ['A', 'B'])],
    packing: { capacity: 10, weights: { A: 1, B: 1 },
      pairs: [{ a: 'A', b: 'B' }, { a: 'B', b: 'A' }] },
  });
  assert.deepStrictEqual(dup.errors, []);
  assert.strictEqual(dup.pairs.length, 1);
}

/* 13. 每件单独装箱恒可行：全部超重边缘——重量恰等承重可以装 */
{
  const r = run({
    scenes: [S('s', ['A', 'B'])],
    packing: { capacity: 5, weights: { A: 5, B: 5 }, pairs: [] },
  });
  assert.strictEqual(r.totalBins, 2);
  assert.deepStrictEqual(r.bins.map(b => b.weight), [5, 5]);
}

/* 14. 14 件性能冒烟：最差情况（每件 1、承重 1、无互斥）O(3^14)，应远小于 1 秒 */
{
  const props = Array.from({ length: 14 }, (_, i) => `p${i}`);
  const weights = Object.fromEntries(props.map(p => [p, 1]));
  const t0 = Date.now();
  const r = run({ scenes: [S('s', props)], packing: { capacity: 1, weights, pairs: [] } });
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.totalBins, 14);
  assert.strictEqual(r.totalWeight, 14);
  assert.ok(elapsed < 1000, `装箱求解耗时 ${elapsed}ms，超过预期`);
}

/* 15. 14 件满载互斥混合冒烟：结果合法且确定 */
{
  const props = Array.from({ length: 14 }, (_, i) => `p${i}`);
  const weights = Object.fromEntries(props.map((p, i) => [p, (i % 4) + 1]));
  const pairs = [{ a: 'p0', b: 'p1' }, { a: 'p2', b: 'p3' }, { a: 'p0', b: 'p13' }];
  const body = { scenes: [S('s', props)], packing: { capacity: 6, weights, pairs } };
  const r1 = run(body);
  const r2 = run(body);
  assert.deepStrictEqual(r1.bins, r2.bins);
  const seen = new Set();
  for (const b of r1.bins) {
    assert.ok(b.weight <= 6);
    for (const p of b.items) {
      assert.ok(!seen.has(p));
      seen.add(p);
    }
    const has = (x) => b.items.includes(x);
    assert.ok(!(has('p0') && has('p1')));
    assert.ok(!(has('p2') && has('p3')));
    assert.ok(!(has('p0') && has('p13')));
  }
  assert.strictEqual(seen.size, 14);
}

console.log('装箱测试全部通过 ✔');

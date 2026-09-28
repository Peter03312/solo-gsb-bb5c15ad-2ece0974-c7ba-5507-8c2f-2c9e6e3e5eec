'use strict';

const assert = require('assert');
const {
  scheduleCrew,
  validateSchedule,
  schedulePhase,
  MIN_WORKERS,
  MAX_WORKERS,
  MAX_PHASE_TASKS,
} = require('../scheduling');

/* 1. 人数必须是 2～4 的整数 */
for (const bad of [0, 1, 5, 2.5, null, undefined, 'x']) {
  const v = validateSchedule({
    workers: bad,
    minutes: { 灯: 2 },
    steps: [{ type: 'setup', scene: 'A', added: ['灯'] }],
  });
  assert.ok(v.errors.some(e => e.includes(`${MIN_WORKERS} 到 ${MAX_WORKERS}`)), `workers=${bad} 应报错`);
}

/* 2. 缺少 / 非正整数工时，均明确提示到具体道具 */
{
  const v = validateSchedule({
    workers: 2,
    minutes: { 灯: 0, 桌: -1 },
    steps: [{ type: 'setup', scene: 'A', added: ['灯', '桌', '椅'] }],
  });
  assert.ok(v.errors.some(e => e.includes('灯') && e.includes('正整数')));
  assert.ok(v.errors.some(e => e.includes('桌') && e.includes('正整数')));
  assert.ok(v.errors.some(e => e.includes('椅') && e.includes('缺少')));
}

/* 3. 没有待执行步骤：明确提示无需排班 */
{
  const v = validateSchedule({ workers: 2, minutes: {} });
  assert.ok(v.errors.some(e => e.includes('没有待排班')));
  const v2 = validateSchedule({ workers: 2, minutes: {}, steps: [] });
  assert.ok(v2.errors.length > 0);
}

/* 4. 超过每阶段 14 项：指出具体段、撤下/摆上件数 */
{
  const props = Array.from({ length: 15 }, (_, i) => `p${i}`);
  const v = validateSchedule({
    workers: 3,
    minutes: Object.fromEntries(props.map(p => [p, 1])),
    steps: [{ type: 'setup', scene: 'A', added: props }],
  });
  assert.ok(v.errors.some(e => e.includes('15') && e.includes(String(MAX_PHASE_TASKS)) && e.includes('摆上')));

  const v2 = validateSchedule({
    workers: 3,
    minutes: Object.fromEntries(props.map(p => [p, 1])),
    steps: [{ type: 'transition', from: 'A', to: 'B', removed: props, added: [] }],
  });
  assert.ok(v2.errors.some(e => e.includes('撤下 15')));
}

/* 5. 步骤结构无效：类型错误、缺场景标识 */
{
  const v = validateSchedule({
    workers: 2,
    minutes: { 灯: 1 },
    steps: [
      { type: 'bogus', added: ['灯'] },
      { type: 'setup', added: ['灯'] },
      { type: 'transition', from: 'A', removed: ['灯'] },
    ],
  });
  assert.ok(v.errors.some(e => e.includes('setup') && e.includes('transition')));
  assert.ok(v.errors.some(e => e.includes('开场') && e.includes('场景标识')));
  assert.ok(v.errors.some(e => e.includes('目标场景')));
}

/* 6. 工时表里多余（步骤未引用）的道具不报错也不进入结果 */
{
  const v = validateSchedule({
    workers: 2,
    minutes: { 灯: 3, 多余: 9 },
    steps: [{ type: 'setup', scene: 'A', added: ['灯'] }],
  });
  assert.deepStrictEqual(v.errors, []);
  assert.deepStrictEqual(Object.keys(v.minutes), ['灯']);
}

/* 7. 单阶段并行机：2 人、工时 [3,3,2,3,2]，最短 makespan = 7 */
{
  const r = schedulePhase([3, 3, 2, 3, 2], 2);
  assert.strictEqual(r.makespan, 7);
  // 每件任务恰好分给一人
  const all = r.groups.flat().sort((a, b) => a - b);
  assert.deepStrictEqual(all, [0, 1, 2, 3, 4]);
  // 每人负载不超过 makespan
  for (const g of r.groups) {
    assert.ok(g.reduce((a, i) => a + [3, 3, 2, 3, 2][i], 0) <= 7);
  }
}

/* 8. 稳定性：同分最优解取分配向量字典序最小（最早任务尽量给最小编号的人） */
{
  // [2,7,4] / 3 人：最优 makespan 7；字典序最小分配为 [0,1,0]（任务 0、2 同人）
  const r = schedulePhase([2, 7, 4], 3);
  assert.strictEqual(r.makespan, 7);
  const assign = new Array(3);
  r.groups.forEach((g, k) => g.forEach(i => { assign[i] = k; }));
  assert.deepStrictEqual(assign, [0, 1, 0]);
  // 重复调用逐字节一致
  assert.deepStrictEqual(r, schedulePhase([2, 7, 4], 3));
}

/* 9. 空阶段：makespan 0，全员空组 */
{
  const r = schedulePhase([], 2);
  assert.strictEqual(r.makespan, 0);
  assert.deepStrictEqual(r.groups, [[], []]);
}

/* 10. 端到端：各段串行、段内先撤后摆（闸门），汇总正确 */
{
  const v = validateSchedule({
    workers: 2,
    scenes: [{ id: 'A', name: '场A' }, { id: 'B', name: '场B' }],
    minutes: { a: 4, b: 4, c: 2 },
    steps: [
      { type: 'setup', scene: 'A', added: ['a', 'b'] },                       // 摆上 4/4 → 4
      { type: 'transition', from: 'A', to: 'B', removed: ['a', 'b'], added: ['c'] }, // 撤 4/4 → gate 4；摆 2 → 段 6
    ],
  });
  assert.deepStrictEqual(v.errors, []);
  const r = scheduleCrew(v.steps, v.workers, v.workerNames, v.minutes, v.names);

  assert.strictEqual(r.segmentCount, 2);
  assert.strictEqual(r.totalTaskCount, 5);
  assert.strictEqual(r.totalDuration, 10);
  assert.strictEqual(r.totalWait, 4);

  const [s1, s2] = r.segments;
  assert.strictEqual(s1.start, 0);
  assert.strictEqual(s1.gate, 0);
  assert.strictEqual(s1.duration, 4);
  assert.strictEqual(s1.end, 4);
  assert.strictEqual(s1.label, '开场布置 →「场A」');

  assert.strictEqual(s2.start, 4);
  assert.strictEqual(s2.gate, 4); // 先撤后摆
  assert.strictEqual(s2.duration, 6);
  assert.strictEqual(s2.end, 10);
  assert.strictEqual(s2.add.offset, 4);

  // 摆上任务的时间戳必须在闸门之后
  for (const w of s2.add.workers) {
    for (const t of w.tasks) {
      assert.ok(t.start >= 4, '摆上不得早于撤下完成');
      assert.strictEqual(t.end - t.start, t.minutes);
    }
  }

  // 每人同一阶段内任务串行（不重叠）
  for (const seg of r.segments) {
    for (const ph of [seg.remove, seg.add]) {
      for (const w of ph.workers) {
        for (let i = 1; i < w.tasks.length; i++) {
          assert.ok(w.tasks[i].start >= w.tasks[i - 1].end);
        }
      }
    }
  }
}

/* 11. 撤下/摆上各自最优：3 人、撤下 6/6、摆上 6 时段耗时 4+6=10 */
{
  const v = validateSchedule({
    workers: 3,
    minutes: { a: 6, b: 6, c: 6, d: 6 },
    steps: [{ type: 'transition', from: 'A', to: 'B', removed: ['a', 'b'], added: ['c', 'd'] }],
  });
  assert.deepStrictEqual(v.errors, []);
  const r = scheduleCrew(v.steps, v.workers, v.workerNames, v.minutes, v.names);
  const seg = r.segments[0];
  assert.strictEqual(seg.remove.makespan, 6);
  assert.strictEqual(seg.gate, 6);
  assert.strictEqual(seg.add.makespan, 6);
  assert.strictEqual(seg.duration, 12);
}

/* 12. 14 项任务性能冒烟：最坏情形数十毫秒内完成 */
{
  const durs = Array.from({ length: 14 }, (_, i) => (i % 5) + 1);
  const t0 = Date.now();
  const r = schedulePhase(durs, 4);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, `排班求解耗时 ${elapsed}ms，超过预期`);
  const lb = Math.max(...durs);
  assert.ok(r.makespan >= lb);
  assert.strictEqual(r.groups.flat().length, 14);
}

console.log('换景人员排班测试全部通过 ✔');

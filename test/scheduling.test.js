'use strict';

const assert = require('assert');
const {
  validateSchedule,
  scheduleSteps,
  binPack,
  MAX_TASKS_PER_PHASE,
  MIN_WORKERS,
  MAX_WORKERS,
} = require('../scheduling');

/** 校验并排班的快捷函数；校验不通过时抛错（错误在专门用例里逐条检查）。 */
function run(body) {
  const v = validateSchedule(body);
  assert.deepStrictEqual(v.errors, []);
  return scheduleSteps(v.pendingSteps, v.workers, v.durations);
}

/** 校验返回的一个阶段排班可执行且不违反机器约束。 */
function assertPhaseFeasible(phase, workers, cap) {
  assert.strictEqual(phase.makespan, cap);
  assert.strictEqual(phase.assignments.length, phase.taskCount);
  // 每人一条时间轴：任务互不重叠，且完工不超过阶段 makespan
  for (let w = 0; w < workers.length; w++) {
    const mine = phase.assignments
      .filter(a => a.worker === workers[w])
      .sort((a, b) => a.start - b.start);
    let t = 0;
    for (const a of mine) {
      assert.strictEqual(a.start, t, '同一人的任务必须首尾相接');
      assert.strictEqual(a.end, a.start + a.minutes);
      assert.ok(a.end <= cap);
      t = a.end;
    }
  }
}

/* 1. 工作人员数量 / 姓名校验 */
for (const bad of [
  undefined, null, [], ['甲'], ['甲', '甲'], ['甲', '乙', '丙', '丁', '戊'], ['甲', '  '],
]) {
  const v = validateSchedule({ workers: bad, durations: {}, steps: [] });
  assert.ok(v.errors.some(e => e.includes('工作人员')), `应拒绝工作人员配置：${JSON.stringify(bad)}`);
}

/* 2. 缺少待执行步骤：无 steps、steps 为空、全部为已完成前缀 */
{
  const base = { workers: ['甲', '乙'], durations: {} };
  assert.ok(validateSchedule({ ...base }).errors.some(e => e.includes('steps')));
  assert.ok(validateSchedule({ ...base, steps: [] }).errors.some(e => e.includes('待执行')));
  assert.ok(validateSchedule({
    ...base,
    steps: [{ type: 'setup', scene: 'A', removed: [], added: ['灯'], phase: 'done' }],
  }).errors.some(e => e.includes('待执行')));
}

/* 3. 缺少工时 / 工时非正整数 / 多余工时 */
{
  const v = validateSchedule({
    workers: ['甲', '乙'],
    durations: { 灯: 3, 桌: 0 },
    steps: [{ type: 'setup', scene: 'A', removed: [], added: ['灯', '椅', '桌'] }],
  });
  assert.ok(v.errors.some(e => e.includes('「椅」') && e.includes('工时')));
  assert.ok(v.errors.some(e => e.includes('「桌」')));

  const v2 = validateSchedule({
    workers: ['甲', '乙'],
    durations: { 灯: 3, 多余: 2 },
    steps: [{ type: 'setup', scene: 'A', removed: [], added: ['灯'] }],
  });
  assert.ok(v2.errors.some(e => e.includes('多余')));
}

/* 4. 每阶段超过 14 项任务：明确提示（撤下 / 摆上各自计 14） */
{
  const props = Array.from({ length: MAX_TASKS_PER_PHASE + 1 }, (_, i) => `p${i}`);
  const v = validateSchedule({
    workers: ['甲', '乙'],
    durations: Object.fromEntries(props.map(p => [p, 1])),
    steps: [{ type: 'setup', scene: 'A', removed: [], added: props }],
  });
  assert.ok(v.errors.some(e => e.includes('摆上') && e.includes(`${MAX_TASKS_PER_PHASE}`) && e.includes('上限')));

  // 撤下超限单独识别
  const v2 = validateSchedule({
    workers: ['甲', '乙'],
    durations: Object.fromEntries([
      ...props.map(p => [p, 1]),
      ['q', 1],
    ]),
    steps: [{ type: 'transition', from: 'A', to: 'B', removed: props, added: ['q'] }],
  });
  assert.ok(v2.errors.some(e => e.includes('撤下')));

  // 合计超过 14 但两阶段各自 ≤ 14：允许（如撤下 8 + 摆上 8）
  const rem8 = Array.from({ length: 8 }, (_, i) => `r${i}`);
  const add8 = Array.from({ length: 8 }, (_, i) => `a${i}`);
  const v3 = validateSchedule({
    workers: ['甲', '乙'],
    durations: Object.fromEntries([...rem8, ...add8].map(p => [p, 1])),
    steps: [{ type: 'transition', from: 'A', to: 'B', removed: rem8, added: add8 }],
  });
  assert.deepStrictEqual(v3.errors, []);
}

/* 5. 单件任务的开场布置：一人干完，makespan = 工时，字段完整 */
{
  const r = run({
    workers: ['阿强', '阿芳'],
    durations: { 灯: 3 },
    steps: [{ type: 'setup', scene: 'A', removed: [], added: ['灯'] }],
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.workerCount, 2);
  assert.strictEqual(r.segments.length, 1);
  assert.strictEqual(r.totalDuration, 3);
  const seg = r.segments[0];
  assert.strictEqual(seg.type, 'setup');
  assert.strictEqual(seg.remove.taskCount, 0);
  assert.strictEqual(seg.remove.makespan, 0);
  assert.strictEqual(seg.add.taskCount, 1);
  assert.strictEqual(seg.add.makespan, 3);
  assert.strictEqual(seg.duration, 3);
  assert.deepStrictEqual(
    seg.add.assignments.map(a => ({ prop: a.prop, worker: a.worker, start: a.start, end: a.end })),
    [{ prop: '灯', worker: '阿强', start: 0, end: 3 }],
  );
  // 空阶段不产生任务
  assert.deepStrictEqual(seg.remove.assignments, []);
}

/* 6. 经典装箱实例：5/5/6/4，2 人 → makespan 10；全部约束可执行 */
{
  const r = run({
    workers: ['甲', '乙'],
    durations: { A: 5, B: 5, C: 6, D: 4 },
    steps: [{ type: 'setup', scene: 'X', removed: [], added: ['A', 'B', 'C', 'D'] }],
  });
  assert.strictEqual(r.segments[0].add.makespan, 10);
  assertPhaseFeasible(r.segments[0].add, ['甲', '乙'], 10);
}

/* 7. 撤下先于摆上：同段两件撤下 4+4、两件摆上 3+3，2 人
      段耗时 = 4（撤下）+ 3（摆上）= 7，摆上阶段 start 从 4 起 */
{
  const r = run({
    workers: ['甲', '乙'],
    durations: { 旧1: 4, 旧2: 4, 新1: 3, 新2: 3 },
    steps: [{
      type: 'transition', from: 'A', to: 'B',
      removed: ['旧1', '旧2'], added: ['新1', '新2'],
    }],
  });
  const seg = r.segments[0];
  assert.strictEqual(seg.remove.makespan, 4);
  assert.strictEqual(seg.add.makespan, 3);
  assert.strictEqual(seg.duration, 7);
  assert.strictEqual(r.totalDuration, 7);
  assertPhaseFeasible(seg.remove, ['甲', '乙'], 4);
  assertPhaseFeasible(seg.add, ['甲', '乙'], 3);
  // 摆上分配的时间以本阶段 0 为起点；全场时间轴由段 start/end 给出
  assert.strictEqual(seg.start, 0);
  assert.strictEqual(seg.end, 7);
}

/* 8. 多段串行：全场 = 各段耗时之和，段时间轴首尾相接 */
{
  const r = run({
    workers: ['甲', '乙'],
    durations: { a: 6, b: 6, c: 1, d: 1 },
    steps: [
      { type: 'setup', scene: 'A', removed: [], added: ['a', 'b'] },
      { type: 'transition', from: 'A', to: 'B', removed: ['a', 'b'], added: ['c', 'd'] },
    ],
  });
  assert.strictEqual(r.segments.length, 2);
  // 段 1：无撤下，摆上 6+6 两人并行 → 6
  assert.strictEqual(r.segments[0].duration, 6);
  // 段 2：撤下 6+6 → 6，摆上 1+1 → 1，共 7
  assert.strictEqual(r.segments[1].duration, 7);
  assert.strictEqual(r.totalDuration, 13);
  assert.strictEqual(r.segments[0].start, 0);
  assert.strictEqual(r.segments[0].end, 6);
  assert.strictEqual(r.segments[1].start, 6);
  assert.strictEqual(r.segments[1].end, 13);
}

/* 9. 已完成（done）步骤被服务端跳过，只排待执行段 */
{
  const r = run({
    workers: ['甲', '乙'],
    durations: { x: 2, y: 3 },
    steps: [
      { type: 'setup', scene: 'A', phase: 'done', removed: [], added: ['x'] },
      { type: 'transition', phase: 'suffix', from: 'A', to: 'B', removed: ['x'], added: ['y'] },
    ],
  });
  assert.strictEqual(r.segments.length, 1);
  assert.strictEqual(r.segments[0].type, 'transition');
}

/* 10. 3、4 人均能利用：7+6+5+4，3 人。总量下界 ⌈22/3⌉=8，但容量 8 时
       任意两件都装不下（最小配对 4+5=9），需要 4 箱；容量 9 时 {7}{6}{5,4}
       恰好 3 箱 → 最短完工 9。4 人时各一件并行，最短完工 = 最大件 7。 */
{
  const mkBody = (workers) => ({
    workers,
    durations: { a: 7, b: 6, c: 5, d: 4 },
    steps: [{ type: 'setup', scene: 'A', removed: [], added: ['a', 'b', 'c', 'd'] }],
  });
  const r3 = run(mkBody(['甲', '乙', '丙']));
  assert.strictEqual(r3.segments[0].add.makespan, 9);
  assertPhaseFeasible(r3.segments[0].add, ['甲', '乙', '丙'], 9);
  const r4 = run(mkBody(['甲', '乙', '丙', '丁']));
  assert.strictEqual(r4.segments[0].add.makespan, 7);
  assertPhaseFeasible(r4.segments[0].add, ['甲', '乙', '丙', '丁'], 7);
  for (const r of [r3, r4]) {
    // 每件恰好出现一次，人员名都在名单内
    const props = r.segments[0].add.assignments.map(a => a.prop).sort();
    assert.deepStrictEqual(props, ['a', 'b', 'c', 'd']);
    assert.ok(r.segments[0].add.assignments.every(a => r.workers.includes(a.worker)));
  }
}

/* 11. 稳定性：同输入重复求解，分配逐字段一致 */
{
  const body = {
    workers: ['甲', '乙', '丙'],
    durations: { a: 5, b: 4, c: 4, d: 3, e: 3, f: 2 },
    steps: [{ type: 'setup', scene: 'A', removed: [], added: ['a', 'b', 'c', 'd', 'e', 'f'] }],
  };
  const r1 = JSON.stringify(run(body));
  const r2 = JSON.stringify(run(body));
  assert.strictEqual(r1, r2);
}

/* 11b. 已完成（done）步骤独有、待执行步骤不再出现的道具：
       可携带工时（前端透传全部 steps）但不强制、不参与排班、不报"多余" */
{
  const steps = [
    { type: 'setup', scene: 'A', phase: 'done', removed: [], added: ['x'] },
    { type: 'transition', phase: 'suffix', from: 'A', to: 'B', removed: [], added: ['y'] },
  ];
  // 携带 x 的工时：通过
  const v = validateSchedule({ workers: ['甲', '乙'], durations: { x: 2, y: 3 }, steps });
  assert.deepStrictEqual(v.errors, []);
  const r = scheduleSteps(v.pendingSteps, v.workers, v.durations);
  assert.strictEqual(r.segments.length, 1);
  assert.strictEqual(r.segments[0].add.taskCount, 1);
  assert.strictEqual(r.segments[0].add.assignments[0].prop, 'y');
  // 不带 x 的工时：也通过（done 段不强制）
  const v2 = validateSchedule({ workers: ['甲', '乙'], durations: { y: 3 }, steps });
  assert.deepStrictEqual(v2.errors, []);
  // 完全无关的道具仍然报错
  const v3 = validateSchedule({ workers: ['甲', '乙'], durations: { x: 2, y: 3, z: 1 }, steps });
  assert.ok(v3.errors.some(e => e.includes('z')));
}

/* 12. 人员顺序变化时按名单稳定映射（任务只落到名单内人员，1 号人员承担按
       录入顺序最早任务所在的箱） */
{
  const body = {
    workers: ['甲', '乙'],
    durations: { a: 5, b: 5 },
    steps: [{ type: 'setup', scene: 'A', removed: [], added: ['a', 'b'] }],
  };
  const r = run(body);
  const a = r.segments[0].add.assignments.find(x => x.prop === 'a');
  assert.strictEqual(a.worker, '甲');
  assert.strictEqual(a.workerIndex, 0);
}

/* 13. 人员数范围常量 */
assert.strictEqual(MIN_WORKERS, 2);
assert.strictEqual(MAX_WORKERS, 4);
assert.strictEqual(MAX_TASKS_PER_PHASE, 14);

/* 14. binPack 边界：空任务列表 → 一只空箱（schedulePhase 不走该路径，直接用函数验证） */
assert.ok(Array.isArray(binPack([], 2, 0)));
/* 单件超过容量 → null */
assert.strictEqual(binPack([5], 2, 4), null);

console.log('scheduling 单元测试全部通过 ✔');

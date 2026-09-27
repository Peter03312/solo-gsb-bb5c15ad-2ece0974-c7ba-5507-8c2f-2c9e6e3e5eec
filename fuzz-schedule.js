'use strict';

/**
 * 换景排班随机对拍：
 *  - 小规模（n ≤ 8）用穷举所有"任务→人员"分配求真实最短完工时间，
 *    与调度器的二分 + 装箱 DP 结果逐案对比；
 *  - 同时校验返回的排班可执行（每人任务不重叠、每件恰好一次、不超 makespan）；
 *  - 较大规模（n = 14）只校验可行性与下界，用于压力测试。
 */

const assert = require('assert');
const { schedulePhase, validateSchedule, scheduleSteps } = require('./scheduling');

/** 穷举最短 makespan：m^n 种"任务 → 人员"分配，取最小的最大负载。 */
function bruteMakespan(weights, m) {
  const n = weights.length;
  if (n === 0) return 0;
  let best = Infinity;
  const load = new Array(m).fill(0);
  (function dfs(i) {
    if (i === n) {
      let mx = 0;
      for (const w of load) mx = Math.max(mx, w);
      best = Math.min(best, mx);
      return;
    }
    for (let w = 0; w < m; w++) {
      load[w] += weights[i];
      // 简单剪枝：当前最大负载已不优于已知最优
      let mx = 0;
      for (const x of load) mx = Math.max(mx, x);
      if (mx < best) dfs(i + 1);
      load[w] -= weights[i];
    }
  })(0);
  return best;
}

function assertExecutable(phase, workers) {
  const seen = new Set();
  for (const a of phase.assignments) {
    assert.ok(!seen.has(a.prop), '每件道具只能被搬运一次');
    seen.add(a.prop);
    assert.ok(workers.includes(a.worker));
    assert.strictEqual(a.end - a.start, a.minutes);
    assert.ok(a.start >= 0 && a.end <= phase.makespan);
  }
  assert.strictEqual(seen.size, phase.taskCount);
  for (let w = 0; w < workers.length; w++) {
    const mine = phase.assignments
      .filter(a => a.workerIndex === w)
      .sort((a, b) => a.start - b.start);
    let t = 0;
    for (const a of mine) { assert.strictEqual(a.start, t); t = a.end; }
  }
}

const N = Number(process.argv[2]) || 400;
let checked = 0;
for (let t = 0; t < N; t++) {
  const n = 1 + Math.floor(Math.random() * 8);
  const m = 2 + Math.floor(Math.random() * 3); // 2..4
  const workers = Array.from({ length: m }, (_, i) => `w${i}`);
  const weights = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 9));
  const tasks = weights.map((minutes, i) => ({ prop: `p${i}`, minutes }));

  const phase = schedulePhase(tasks, workers);
  const expect = bruteMakespan(weights, m);
  assert.strictEqual(phase.makespan, expect,
    `makespan 不一致：weights=${weights}, m=${m}, got=${phase.makespan}, expect=${expect}`);
  assertExecutable(phase, workers);

  // 确定性：再排一次完全相同
  const again = schedulePhase(tasks, workers);
  assert.deepStrictEqual(JSON.stringify(again), JSON.stringify(phase));
  checked++;
}

// 端到端：随机多段，全场耗时 = 各段（撤下 + 摆上）最优耗时之和
for (let t = 0; t < Math.min(N, 100); t++) {
  const m = 2 + Math.floor(Math.random() * 3);
  const workers = Array.from({ length: m }, (_, i) => `人${i + 1}`);
  const steps = [];
  const durations = {};
  const segCount = 1 + Math.floor(Math.random() * 4);
  for (let s = 0; s < segCount; s++) {
    const nr = s === 0 ? 0 : Math.floor(Math.random() * 5);
    const na = 1 + Math.floor(Math.random() * 5);
    const removed = [];
    const added = [];
    for (let i = 0; i < nr; i++) {
      const name = `s${s}r${i}`;
      removed.push(name);
      durations[name] = 1 + Math.floor(Math.random() * 9);
    }
    for (let i = 0; i < na; i++) {
      const name = `s${s}a${i}`;
      added.push(name);
      durations[name] = 1 + Math.floor(Math.random() * 9);
    }
    steps.push(s === 0
      ? { type: 'setup', scene: `S${s}`, removed, added }
      : { type: 'transition', from: `S${s - 1}`, to: `S${s}`, removed, added });
  }
  const v = validateSchedule({ workers, durations, steps });
  assert.deepStrictEqual(v.errors, []);
  const r = scheduleSteps(v.pendingSteps, v.workers, v.durations);
  let total = 0;
  let cursor = 0;
  for (const seg of r.segments) {
    assert.strictEqual(seg.duration, seg.remove.makespan + seg.add.makespan);
    assert.strictEqual(seg.start, cursor);
    cursor += seg.duration;
    total += seg.duration;
    assertExecutable(seg.remove, workers);
    assertExecutable(seg.add, workers);
  }
  assert.strictEqual(r.totalDuration, total);
  assert.strictEqual(r.segments[r.segments.length - 1].end, total);
  checked++;
}

// 压力：14 件、4 人，必须毫秒级返回且满足下界
{
  const m = 4;
  const workers = ['甲', '乙', '丙', '丁'];
  const weights = [9, 8, 8, 7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2];
  const tasks = weights.map((minutes, i) => ({ prop: `p${i}`, minutes }));
  const t0 = Date.now();
  const phase = schedulePhase(tasks, workers);
  const ms = Date.now() - t0;
  const sum = weights.reduce((a, b) => a + b, 0);
  const lower = Math.max(Math.max(...weights), Math.ceil(sum / m));
  assert.ok(phase.makespan >= lower);
  assert.ok(phase.makespan <= sum);
  assertExecutable(phase, workers);
  assert.ok(ms < 500, `14 件排班耗时 ${ms}ms，应在毫秒级完成`);
  console.log(`压力用例：n=14, m=4, makespan=${phase.makespan}（下界 ${lower}），耗时 ${ms}ms`);
}

console.log(`fuzz-schedule 全部通过 ✔（${checked} 个随机用例）`);

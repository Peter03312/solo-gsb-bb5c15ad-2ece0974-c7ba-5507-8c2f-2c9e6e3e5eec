'use strict';

/**
 * 换景人员排班随机对拍：
 *  - 小规模（n ≤ 8）：与"枚举每件任务分给哪个人"的暴力最优解逐案比对，
 *    既比最短 makespan，也比"分配向量字典序最小"的稳定分工；
 *  - 大规模（n ≤ 14）：只校验结果合法（每人负载 ≤ makespan、任务恰好分一次）。
 *
 * 用法：node fuzz-crew.js [轮数，默认 2000]
 */

const { schedulePhase } = require('./scheduling');

const ROUNDS = Number(process.argv[2]) || 2000;

let seed = (Date.now() ^ 0x5bd1e995) >>> 0;
function rnd() {
  // 确定性的 LCG，便于复现
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
}

/** 暴力最优：枚举 m^n 种分配，取 makespan 最小、分配向量字典序最小者。 */
function brute(durs, m) {
  const n = durs.length;
  let best = Infinity;
  let bestAssign = null;
  const assign = new Array(n).fill(0);
  const lexLess = (a, b) => {
    if (!b) return true;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  (function rec(i) {
    if (i === n) {
      const load = new Array(m).fill(0);
      for (let j = 0; j < n; j++) load[assign[j]] += durs[j];
      const mk = Math.max(...load);
      if (mk < best || (mk === best && lexLess(assign, bestAssign))) {
        best = mk;
        bestAssign = assign.slice();
      }
      return;
    }
    for (let k = 0; k < m; k++) { assign[i] = k; rec(i + 1); }
  })(0);
  const groups = Array.from({ length: m }, () => []);
  bestAssign.forEach((k, j) => groups[k].push(j));
  return { makespan: best, groups };
}

function checkLegal(durs, m, r) {
  const seen = new Set();
  r.groups.forEach((g, k) => {
    let load = 0;
    for (const i of g) {
      if (seen.has(i)) throw new Error('任务被重复分配：' + i);
      seen.add(i);
      load += durs[i];
    }
    if (load > r.makespan) throw new Error(`第 ${k + 1} 人负载 ${load} 超过 makespan ${r.makespan}`);
  });
  if (seen.size !== durs.length) throw new Error('有任务未被分配');
  if (r.makespan < Math.max(...durs)) throw new Error('makespan 低于最长单件工时，不可能最优');
}

let failures = 0;
for (let t = 0; t < ROUNDS; t++) {
  const small = t < ROUNDS * 0.7;
  const n = small ? 1 + Math.floor(rnd() * 8) : 9 + Math.floor(rnd() * 6); // 9..14
  const m = 2 + Math.floor(rnd() * 3); // 2..4
  const durs = Array.from({ length: n }, () => 1 + Math.floor(rnd() * 9));

  const got = schedulePhase(durs, m);
  try {
    checkLegal(durs, m, got);
  } catch (e) {
    console.error('非法结果：', e.message, { n, m, durs, got });
    if (++failures >= 5) break;
    continue;
  }

  if (small) {
    const exp = brute(durs, m);
    if (got.makespan !== exp.makespan || JSON.stringify(got.groups) !== JSON.stringify(exp.groups)) {
      console.error('与暴力解不一致：', { n, m, durs, got, exp });
      if (++failures >= 5) break;
    }
  }
}

if (failures) {
  console.error(`排班对拍失败 ${failures} 例（种子 ${seed}）`);
  process.exit(1);
}
console.log(`排班随机对拍 ${ROUNDS} 轮全部通过 ✔（小规模比对暴力最优，大规模校验合法）`);

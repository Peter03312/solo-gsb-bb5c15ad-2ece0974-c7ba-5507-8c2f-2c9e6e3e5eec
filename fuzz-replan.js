'use strict';
/**
 * 演出中重排的随机对拍：对小规模（n <= 7）实例，
 * 用"枚举剩余场景的全部入选子集 × 全排列"暴力求最优后缀，
 * 与 solver.replan 的结果核对目标值（价值、代价）与可行性。
 */
const { replan } = require('./solver');

let seed = 987654321;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function ri(n) { return Math.floor(rnd() * n); }

function randomInstance() {
  const n = 1 + ri(7);
  const scenes = [];
  const propPool = ['p1', 'p2', 'p3', 'p4', 'p5'];
  for (let i = 0; i < n; i++) {
    const ps = [];
    for (let k = 0; k < ri(3); k++) ps.push(propPool[ri(propPool.length)]);
    const timed = rnd() < 0.6;
    scenes.push({
      id: `s${i}`, name: `s${i}`, props: [...new Set(ps)],
      duration: ri(12),
      required: timed ? rnd() < 0.4 : false,
      value: ri(10),
    });
  }
  const constraints = { dependencies: [], fixedPositions: [], forbiddenAdjacencies: [] };
  for (let k2 = 0; k2 < ri(5); k2++) {
    const a = ri(n), b = ri(n);
    if (a !== b) constraints.dependencies.push({ before: `s${a}`, after: `s${b}` });
  }
  for (let k = 0; k < ri(4); k++) {
    constraints.fixedPositions.push({ sceneId: `s${ri(n)}`, position: 1 + ri(n) });
  }
  for (let k = 0; k < ri(4); k++) {
    const a = ri(n), b = ri(n);
    if (a !== b) constraints.forbiddenAdjacencies.push({ a: `s${a}`, b: `s${b}` });
  }
  return {
    scenes, constraints,
    mode: scenes.some(s => s.required) || rnd() < 0.3 ? 'timed' : 'classic',
    timeLimit: 1 + ri(n * 14),
    opLimit: rnd() < 0.5 ? 1 + ri(5) : null,
  };
}

function perms(arr) {
  const out = [];
  const rec = (a, k) => {
    if (k === a.length) { out.push(a.slice()); return; }
    for (let i = k; i < a.length; i++) {
      [a[k], a[i]] = [a[i], a[k]];
      rec(a, k + 1);
      [a[k], a[i]] = [a[i], a[k]];
    }
  };
  rec(arr, 0);
  return out;
}

function run() {
  const { scenes, constraints, mode, timeLimit, opLimit } = randomInstance();
  const cap = (opLimit === undefined || opLimit === null) ? Infinity : opLimit;
  const n = scenes.length;
  const idx = new Map(scenes.map((s, i) => [s.id, i]));
  const props = scenes.map(s => new Set(s.props));

  // 随机前缀：K 个不同场景，随机顺序
  const shuffled = scenes.map((_, i) => i);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = ri(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const K = ri(n + 1);
  const prefix = shuffled.slice(0, K);
  const prefixSet = new Set(prefix);
  const remaining = scenes.map((_, i) => i).filter(i => !prefixSet.has(i));

  const stageProps = new Set();
  for (let k = 0; k < ri(4); k++) stageProps.add(['q1', 'q2', 'p1', 'p3'][ri(4)]);

  const deps = (constraints.dependencies || []).map(d => [idx.get(d.before), idx.get(d.after)]);
  const fixedOf = new Map();
  for (const f of constraints.fixedPositions || []) {
    const g = idx.get(f.sceneId);
    if (!fixedOf.has(g)) fixedOf.set(g, new Set());
    fixedOf.get(g).add(f.position - 1);
  }
  const bad = Array.from({ length: n }, () => Array(n).fill(false));
  for (const f of constraints.forbiddenAdjacencies || []) {
    bad[idx.get(f.a)][idx.get(f.b)] = true;
    bad[idx.get(f.b)][idx.get(f.a)] = true;
  }
  const posInPrefix = new Array(n).fill(-1);
  prefix.forEach((g, k) => { posInPrefix[g] = k; });

  /* ---------- 暴力：前缀冲突 ---------- */
  let prefixConflict = false;
  let prefixOvertime = false;
  for (const [a, b] of deps) {
    if (posInPrefix[a] !== -1 && posInPrefix[b] !== -1 && posInPrefix[a] > posInPrefix[b]) prefixConflict = true;
    if (posInPrefix[a] === -1 && posInPrefix[b] !== -1) prefixConflict = true;
  }
  for (const [g, ps] of fixedOf) {
    for (const p of ps) {
      if (posInPrefix[g] !== -1 && posInPrefix[g] !== p) prefixConflict = true;
      if (posInPrefix[g] === -1 && p < K && (mode === 'classic' || scenes[g].required)) prefixConflict = true;
    }
  }
  for (let k = 0; k + 1 < K; k++) {
    if (bad[prefix[k]][prefix[k + 1]]) prefixConflict = true;
  }
  const prefixDur = prefix.reduce((a, g) => a + scenes[g].duration, 0);
  if (mode === 'timed' && prefixDur > timeLimit) prefixOvertime = true;

  const opts = { mode, timeLimit, opLimit, replan: {
    prefixIds: prefix.map(g => scenes[g].id),
    stageProps: [...stageProps],
    originalOrder: scenes.map(s => s.id),
  } };
  const r = replan(scenes, constraints, opts);

  if (prefixConflict || prefixOvertime) {
    if (r.ok) {
      return { err: 'brute: 前缀冲突但 solver 有解', inst: arguments[0], r: r.order };
    }
    return null;
  }

  /* ---------- 暴力：后缀枚举 ---------- */
  const symDiff = (a, b) => {
    let c = 0;
    for (const p of a) if (!b.has(p)) c++;
    for (const p of b) if (!a.has(p)) c++;
    return c;
  };

  let best = null; // { value, cost }
  const consider = (members) => {
    // members：后缀入选的全局下标（按顺序）
    if (mode === 'classic' && members.length !== remaining.length) return;
    // 必演剩余场景必须全部入选
    for (const g of remaining) {
      if (mode === 'timed' && scenes[g].required && !members.includes(g)) return;
    }    let dur = prefixDur;
    for (const g of members) dur += scenes[g].duration;
    if (mode === 'timed' && dur > timeLimit) return;

    const check = (perm) => {
      // 固定序位（绝对）
      for (const g of perm) {
        const fs = fixedOf.get(g);
        if (fs) {
          const absPos = K + perm.indexOf(g);
          for (const p of fs) if (p !== absPos) return null;
        }
      }
      // 后缀内依赖
      for (const [a, b] of deps) {
        const ia = perm.indexOf(a), ib = perm.indexOf(b);
        if (ia !== -1 && ib !== -1 && ia > ib) return null;
      }
      // 边界禁止相邻
      if (K > 0 && perm.length && bad[prefix[K - 1]][perm[0]]) return null;
      // 后缀内禁止相邻
      for (let i = 0; i + 1 < perm.length; i++) {
        if (bad[perm[i]][perm[i + 1]]) return null;
      }
      let cost = 0;
      if (perm.length) {
        const startEdge = symDiff(stageProps, props[perm[0]]);
        if (startEdge > cap) return null; // 首段（从当前实际道具切入）超出上限
        cost += startEdge;
        for (let i = 1; i < perm.length; i++) {
          const e = symDiff(props[perm[i - 1]], props[perm[i]]);
          if (e > cap) return null; // 本次换景超出上限
          cost += e;
        }
      }
      let value = 0;
      if (mode === 'timed') for (const g of perm) if (!scenes[g].required) value += scenes[g].value;
      return { cost, value };
    };

    for (const perm of perms(members)) {
      const res = check(perm);
      if (!res) continue;
      if (best === null || res.value > best.value || (res.value === best.value && res.cost < best.cost)) {
        best = res;
      }
    }
  };

  // 枚举 remaining 的全部子集（classic 只看全集，但统一枚举也行）
  for (let mask = 0; mask < (1 << remaining.length); mask++) {
    const members = [];
    for (let i = 0; i < remaining.length; i++) if (mask & (1 << i)) members.push(remaining[i]);
    consider(members);
  }
  // timed 且没有剩余必演场景时，空后缀是保底可行解
  if (mode === 'timed' && best === null && !remaining.some(g => scenes[g].required)) {
    best = { value: 0, cost: 0 };
  }

  if (best === null) {
    if (r.ok) return { err: 'brute: 后缀不可行但 solver 有解', r: r.order, opts };
    return null;
  }
  if (!r.ok) return { err: 'brute: 后缀可行但 solver 无解', conflict: r.conflict, opts, scenes, constraints, best };

  const suffixValue = (mode === 'timed')
    ? r.suffixIds.reduce((a, id) => { const g = idx.get(id); return a + (scenes[g].required ? 0 : scenes[g].value); }, 0)
    : 0;
  if (mode === 'timed' && suffixValue !== best.value) {
    return { err: '价值不一致', got: suffixValue, exp: best.value, order: r.order, opts };
  }
  if (r.suffixCost !== best.cost) {
    return { err: '后缀代价不一致', got: r.suffixCost, exp: best.cost, order: r.order, opts };
  }
  // 前缀必须原样保留
  if (JSON.stringify(r.prefixIds) !== JSON.stringify(prefix.map(g => scenes[g].id))) {
    return { err: '前缀被改变', opts };
  }
  return null;
}

const N = Number(process.argv[2] || 500);
let tested = 0;
for (let it = 0; it < N; it++) {
  const fail = run();
  tested++;
  if (fail) {
    console.log('MISMATCH:', JSON.stringify(fail, null, 1));
    process.exit(1);
  }
}
console.log(`重排随机对拍 ${tested} 例全部一致 ✔`);

'use strict';
const { solve } = require('./solver');

// 确定性伪随机
let seed = 123456789;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function ri(n) { return Math.floor(rnd() * n); }

function brute(scenes, constraints, timeLimit, opLimit) {
  const n = scenes.length;
  const cap = (opLimit === undefined || opLimit === null) ? Infinity : opLimit;
  const idx = new Map(scenes.map((s, i) => [s.id, i]));
  const props = scenes.map(s => new Set(s.props));
  const req = scenes.map(s => !!s.required);
  const dur = scenes.map(s => s.duration);
  const val = scenes.map(s => (s.required ? 0 : s.value));
  let reqMask = 0;
  scenes.forEach((s, i) => { if (s.required) reqMask |= 1 << i; });

  const deps = (constraints.dependencies || []).map(d => [idx.get(d.before), idx.get(d.after)]);
  const fixedSets = new Map();
  for (const f of constraints.fixedPositions || []) {
    const g = idx.get(f.sceneId);
    if (!fixedSets.has(g)) fixedSets.set(g, new Set());
    fixedSets.get(g).add(f.position - 1);
  }
  const fixedSetOf = (g) => fixedSets.get(g) || null;
  const bad = Array.from({ length: n }, () => Array(n).fill(false));
  for (const f of constraints.forbiddenAdjacencies || []) {
    const a = idx.get(f.a), b = idx.get(f.b);
    bad[a][b] = bad[b][a] = true;
  }
  const setup = scenes.map((_, i) => props[i].size);
  const ccost = (a, b) => {
    let c = 0;
    for (const p of props[a]) if (!props[b].has(p)) c++;
    for (const p of props[b]) if (!props[a].has(p)) c++;
    return c;
  };

  const perms = [];
  function permute(arr, k) {
    if (k === arr.length) { perms.push(arr.slice()); return; }
    for (let i = k; i < arr.length; i++) {
      [arr[k], arr[i]] = [arr[i], arr[k]];
      permute(arr, k + 1);
      [arr[k], arr[i]] = [arr[i], arr[k]];
    }
  }
  // 目标值：每个入选子集的最优（最大价值由枚举保证，最小代价）。
  // 同分顺序的确定性由正式单测固定，这里只核对目标与入选集合。
  let best = null; // {value, cost, mask}

  if (reqMask === 0) best = { value: 0, cost: 0, mask: 0 };

  for (let mask = 0; mask < (1 << n); mask++) {
    if ((mask & reqMask) !== reqMask) continue;
    const members = [];
    let dt = 0, vt = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { members.push(i); dt += dur[i]; vt += val[i]; }
    if (dt > timeLimit) continue;
    perms.length = 0;
    permute(members, 0);
    let bestForMask = null;
    for (const perm of perms) {
      let ok = true;
      for (const [a, b] of deps) {
        const inA = (mask & (1 << a)) !== 0, inB = (mask & (1 << b)) !== 0;
        if (inA && inB && perm.indexOf(a) >= perm.indexOf(b)) { ok = false; break; }
      }
      if (!ok) continue;
      // 每个入选场景要么无固定约束，要么其全部固定约束都指向实际序位
      // （同一目标有多条不同固定位时无解）
      for (const g of members) {
        const fs = fixedSetOf(g);
        if (fs !== null) {
          const pos = perm.indexOf(g);
          for (const p of fs) if (p !== pos) { ok = false; break; }
          if (!ok) break;
        }
      }
      if (!ok) continue;
      for (let i = 0; i + 1 < perm.length; i++) {
        if (bad[perm[i]][perm[i + 1]]) { ok = false; break; }
      }
      if (!ok) continue;
      let cst = perm.length ? setup[perm[0]] : 0;
      if (cst > cap) continue; // 开场布置超出单段上限
      let edgeOk = true;
      for (let i = 1; i < perm.length; i++) {
        const e = ccost(perm[i - 1], perm[i]);
        if (e > cap) { edgeOk = false; break; }
        cst += e;
      }
      if (!edgeOk) continue;
      if (bestForMask === null || cst < bestForMask) bestForMask = cst;
    }
    if (bestForMask !== null) {
      if (best === null || vt > best.value || (vt === best.value && bestForMask < best.cost)) {
        best = { value: vt, cost: bestForMask, mask };
      }
    }
  }
  return best;
}

/** 独立校验求解器返回的顺序确实满足 timed 模式全部约束与目标 */
function verifySolution(scenes, constraints, timeLimit, r, opLimit) {
  const cap = (opLimit === undefined || opLimit === null) ? Infinity : opLimit;
  const n = scenes.length;
  const idx = new Map(scenes.map((s, i) => [s.id, i]));
  const props = scenes.map(s => new Set(s.props));
  const order = r.order.map(id => idx.get(id));
  const sel = new Set(order);
  // 全部必演入选
  scenes.forEach((s, i) => { if (s.required && !sel.has(i)) throw new Error('必演场景未入选'); });
  // 时长
  let used = 0;
  for (const i of order) used += scenes[i].duration;
  if (used > timeLimit) throw new Error('超过时长上限');
  if (used !== r.usedDuration) throw new Error('已用时长字段不一致');
  // 入选/舍弃集合
  const expSel = scenes.map((s, i) => i).filter(i => sel.has(i));
  if (JSON.stringify([...order].sort((a, b) => a - b)) !== JSON.stringify(expSel.sort((a, b) => a - b))) {
    throw new Error('selectedIds 与 order 不一致');
  }
  // 依赖（双方入选时）
  for (const d of constraints.dependencies || []) {
    const a = idx.get(d.before), b = idx.get(d.after);
    if (sel.has(a) && sel.has(b) && order.indexOf(a) >= order.indexOf(b)) throw new Error('依赖被违反');
  }
  // 固定序位：入选场景必须在其固定位；未入选的忽略
  const vFixedSets = new Map();
  for (const f of constraints.fixedPositions || []) {
    const g = idx.get(f.sceneId);
    if (!vFixedSets.has(g)) vFixedSets.set(g, new Set());
    vFixedSets.get(g).add(f.position - 1);
  }
  for (const f of constraints.fixedPositions || []) {
    const g = idx.get(f.sceneId);
    if (sel.has(g) && order.indexOf(g) !== f.position - 1) throw new Error('固定序位被违反');
  }
  // 同一场景若有多条固定约束，入选时所有位置必须等于其实际位置
  for (const [g, fs] of vFixedSets) {
    if (sel.has(g)) for (const p of fs) if (order.indexOf(g) !== p) throw new Error('同一场景多重固定序位被违反');
  }
  // 禁止相邻（双方入选时）
  for (const f of constraints.forbiddenAdjacencies || []) {
    const a = idx.get(f.a), b = idx.get(f.b);
    if (sel.has(a) && sel.has(b) && Math.abs(order.indexOf(a) - order.indexOf(b)) === 1) {
      throw new Error('禁止相邻被违反');
    }
  }
  // 价值与代价
  let v = 0;
  for (const i of order) if (!scenes[i].required) v += scenes[i].value;
  if (v !== r.totalValue) throw new Error('价值字段不一致');
  let c = order.length ? props[order[0]].size : 0;
  if (order.length && props[order[0]].size > cap) throw new Error('开场布置超过单段上限');
  for (let k = 0; k + 1 < order.length; k++) {
    const a = props[order[k]], b = props[order[k + 1]];
    let e = 0;
    for (const p of a) if (!b.has(p)) { c++; e++; }
    for (const p of b) if (!a.has(p)) { c++; e++; }
    if (e > cap) throw new Error('换景超过单段上限');
  }
  if (c !== r.totalCost) throw new Error('代价字段不一致');
}

function randomInstance() {
  // 暴力枚举排列，n 上限 8（8! × 256 仍可接受）
  const n = 1 + ri(8);
  const scenes = [];
  const propPool = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  for (let i = 0; i < n; i++) {
    const ps = [];
    for (let k = 0; k < ri(3); k++) ps.push(propPool[ri(propPool.length)]);
    scenes.push({
      id: `s${i}`, name: `s${i}`, props: [...new Set(ps)],
      duration: ri(15),
      required: rnd() < 0.4,
      value: ri(12),
    });
  }
  const constraints = { dependencies: [], fixedPositions: [], forbiddenAdjacencies: [] };
  const nd = ri(Math.min(8, Math.floor(n * (n - 1) / 2)));
  for (let k = 0; k < nd; k++) {
    const a = ri(n), b = ri(n);
    if (a !== b) constraints.dependencies.push({ before: `s${a}`, after: `s${b}` });
  }
  const nf = ri(5);
  for (let k = 0; k < nf; k++) constraints.fixedPositions.push({ sceneId: `s${ri(n)}`, position: 1 + ri(n) });
  const na = ri(5);
  for (let k = 0; k < na; k++) {
    const a = ri(n), b = ri(n);
    if (a !== b) constraints.forbiddenAdjacencies.push({ a: `s${a}`, b: `s${b}` });
  }
  const timeLimit = 1 + ri(n * 16);
  // 约一半实例带单段道具操作上限（1..6 件），其余不限
  const opLimit = rnd() < 0.5 ? 1 + ri(6) : null;
  return { scenes, constraints, timeLimit, opLimit };
}

let tested = 0;
const NITER = Number(process.argv[2] || 400);
for (let it = 0; it < NITER; it++) {
  const { scenes, constraints, timeLimit, opLimit } = randomInstance();
  const r = solve(scenes, constraints, { mode: 'timed', timeLimit, opLimit });
  const b = brute(scenes, constraints, timeLimit, opLimit);
  tested++;
  if (b === null) {
    if (r.ok) {
      console.log('MISMATCH: brute infeasible but solver ok', JSON.stringify({ scenes, constraints, timeLimit, opLimit, r: r.order }));
      process.exit(1);
    }
    continue;
  }
  if (!r.ok) {
    console.log('MISMATCH: brute feasible but solver infeasible', JSON.stringify({ scenes, constraints, timeLimit, opLimit }));
    process.exit(1);
  }
  try {
    verifySolution(scenes, constraints, timeLimit, r, opLimit);
  } catch (e) {
    console.log('INVALID SOLUTION:', e.message, JSON.stringify({ scenes, constraints, timeLimit, opLimit, order: r.order }));
    process.exit(1);
  }
  if (r.totalValue !== b.value || r.totalCost !== b.cost) {
    console.log('MISMATCH objective', JSON.stringify({
      scenes, constraints, timeLimit, opLimit,
      got: { order: r.order, value: r.totalValue, cost: r.totalCost },
      exp: { value: b.value, cost: b.cost, mask: b.mask },
    }, null, 1));
    process.exit(1);
  }
}
console.log(`随机对拍 ${tested} 例全部一致 ✔`);

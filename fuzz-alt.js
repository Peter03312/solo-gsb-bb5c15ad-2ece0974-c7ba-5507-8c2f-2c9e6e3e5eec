'use strict';
/**
 * 备选节目单（k-best）随机对拍：
 * 对小规模实例（n <= 6）暴力枚举所有可行（入选子集 ×）排列，
 * 按正式排序规则（经典：代价升序；时长受限：价值降序→代价升序；
 * 同分：场景下标序列字典序升序）取前 K 条，与 solve(..., { alternatives: K })
 * 返回的备选逐条核对：排序、唯一性、约束满足、单段上限。
 */
const { solve, MAX_ALTERNATIVES } = require('./solver');

let seed = 20260927;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function ri(n) { return Math.floor(rnd() * n); }

function randomInstance() {
  const n = 1 + ri(6);
  const scenes = [];
  const propPool = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  const timed = rnd() < 0.55;
  for (let i = 0; i < n; i++) {
    const ps = [];
    for (let k = 0; k < ri(3); k++) ps.push(propPool[ri(propPool.length)]);
    scenes.push({
      id: `s${i}`, name: `s${i}`, props: [...new Set(ps)],
      duration: ri(15),
      required: timed ? rnd() < 0.4 : false,
      value: ri(10),
    });
  }
  const constraints = { dependencies: [], fixedPositions: [], forbiddenAdjacencies: [] };
  for (let k2 = 0; k2 < ri(6); k2++) {
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
    mode: timed ? 'timed' : 'classic',
    timeLimit: 1 + ri(n * 16),
    opLimit: rnd() < 0.5 ? 1 + ri(6) : null,
    K: 2 + ri(MAX_ALTERNATIVES - 1), // 2 或 3
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

function lexArr(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
}

function brute({ scenes, constraints, mode, timeLimit, opLimit, K }) {
  const n = scenes.length;
  const cap = (opLimit === null || opLimit === undefined) ? Infinity : opLimit;
  const idx = new Map(scenes.map((s, i) => [s.id, i]));
  const props = scenes.map(s => new Set(s.props));
  let reqMask = 0;
  scenes.forEach((s, i) => { if (s.required) reqMask |= 1 << i; });

  const deps = (constraints.dependencies || []).map(d => [idx.get(d.before), idx.get(d.after)]);
  const fixedSets = new Map();
  for (const f of constraints.fixedPositions || []) {
    const g = idx.get(f.sceneId);
    if (!fixedSets.has(g)) fixedSets.set(g, new Set());
    fixedSets.get(g).add(f.position - 1);
  }
  const bad = Array.from({ length: n }, () => Array(n).fill(false));
  for (const f of constraints.forbiddenAdjacencies || []) {
    const a = idx.get(f.a), b = idx.get(f.b);
    bad[a][b] = bad[b][a] = true;
  }
  const sym = (a, b) => {
    let c = 0;
    for (const p of a) if (!b.has(p)) c++;
    for (const p of b) if (!a.has(p)) c++;
    return c;
  };

  const all = []; // 全部可行（完整或入选子集）排列
  const maxMask = (1 << n) - 1;
  for (let mask = 0; mask <= maxMask; mask++) {
    if (mode === 'classic' && mask !== maxMask) continue;
    if ((mask & reqMask) !== reqMask) continue;
    const members = [];
    let dur = 0, val = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) {
      members.push(i);
      dur += scenes[i].duration;
      if (!scenes[i].required) val += scenes[i].value;
    }
    if (mode === 'timed' && dur > timeLimit) continue;

    for (const perm of perms(members)) {
      let ok = true;
      for (const [a, b] of deps) {
        const ia = perm.indexOf(a), ib = perm.indexOf(b);
        if (ia !== -1 && ib !== -1 && ia > ib) { ok = false; break; }
      }
      if (!ok) continue;
      for (const g of members) {
        const fs = fixedSets.get(g);
        if (fs) {
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
      let cost = 0;
      if (perm.length) {
        if (props[perm[0]].size > cap) continue;
        cost += props[perm[0]].size;
        for (let i = 1; i < perm.length; i++) {
          const e = sym(props[perm[i - 1]], props[perm[i]]);
          if (e > cap) { ok = false; break; }
          cost += e;
        }
      }
      if (!ok) continue;
      all.push({ path: perm, cost, value: mode === 'timed' ? val : 0, mask });
    }
  }

  all.sort((x, y) => {
    if (mode === 'timed' && x.value !== y.value) return y.value - x.value;
    if (x.cost !== y.cost) return x.cost - y.cost;
    return lexArr(x.path, y.path);
  });
  // 去重（排列唯一，理论上不会重复）
  const uniq = [];
  for (const e of all) {
    if (!uniq.some(u => lexArr(u.path, e.path) === 0)) uniq.push(e);
  }
  return { feasible: uniq.length > 0, top: uniq.slice(0, K) };
}

function checkAlternative(scenes, constraints, alt, mode, timeLimit, opLimit) {
  const n = scenes.length;
  const cap = (opLimit === null || opLimit === undefined) ? Infinity : opLimit;
  const idx = new Map(scenes.map((s, i) => [s.id, i]));
  const order = alt.order.map(id => idx.get(id));
  const sel = new Set(order);
  if (mode === 'classic' && order.length !== n) throw new Error('classic 备选未包含全部场景');
  for (let i = 0; i < n; i++) if (scenes[i].required && !sel.has(i)) throw new Error('必演场景未入选');
  let dur = 0, val = 0, cost = 0;
  for (const g of order) {
    dur += scenes[g].duration;
    if (!scenes[g].required) val += scenes[g].value;
  }
  if (mode === 'timed' && dur > timeLimit) throw new Error('备选超时');
  for (const d of constraints.dependencies || []) {
    const a = idx.get(d.before), b = idx.get(d.after);
    if (sel.has(a) && sel.has(b) && order.indexOf(a) > order.indexOf(b)) {
      throw new Error('备选违反依赖');
    }
  }
  for (const f of constraints.fixedPositions || []) {
    const g = idx.get(f.sceneId);
    if (sel.has(g) && order.indexOf(g) !== f.position - 1) throw new Error('备选违反固定序位');
  }
  for (const f of constraints.forbiddenAdjacencies || []) {
    const a = idx.get(f.a), b = idx.get(f.b);
    if (sel.has(a) && sel.has(b)
        && Math.abs(order.indexOf(a) - order.indexOf(b)) === 1) {
      throw new Error('备选违反禁止相邻');
    }
  }
  if (order.length) {
    const sc0 = scenes[order[0]].props.length;
    if (sc0 > cap) throw new Error('备选开场超上限');
    cost += sc0;
    const pset = (g) => new Set(scenes[g].props);
    for (let i = 1; i < order.length; i++) {
      const a = pset(order[i - 1]), b = pset(order[i]);
      let e = 0;
      for (const p of a) if (!b.has(p)) e++;
      for (const p of b) if (!a.has(p)) e++;
      if (e > cap) throw new Error('备选换景超上限');
      cost += e;
    }
  }
  if (cost !== alt.totalCost) throw new Error(`备选代价字段错误 ${cost} != ${alt.totalCost}`);
  if (mode === 'timed') {
    if (val !== alt.totalValue) throw new Error('备选价值字段错误');
    if (dur !== alt.usedDuration) throw new Error('备选时长字段错误');
  }
  // steps 账目
  const sum = alt.steps.reduce((a2, s) => a2 + s.count, 0);
  if (sum !== alt.totalCost) throw new Error('备选 steps 账目不守恒');
}

const N = Number(process.argv[2] || 300);
let tested = 0;
for (let it = 0; it < N; it++) {
  const inst = randomInstance();
  const { scenes, constraints, mode, timeLimit, opLimit, K } = inst;
  const opts = mode === 'timed' ? { mode, timeLimit, opLimit, alternatives: K } : { opLimit, alternatives: K };
  const r = solve(scenes, constraints, opts);
  const b = brute(inst);

  if (!b.feasible) {
    if (r.ok) throw new Error('暴力无解但 solver 有解: ' + JSON.stringify(inst));
    continue;
  }
  if (!r.ok) throw new Error('暴力有解但 solver 无解: ' + JSON.stringify(inst) + ' ' + r.conflict.type);
  if (!Array.isArray(r.alternatives)) throw new Error('缺少 alternatives 数组');

  const alts = r.alternatives;
  const expectK = Math.min(K, b.top.length);
  if (alts.length !== expectK) {
    throw new Error(`备选条数 ${alts.length} != 期望 ${expectK}: ` + JSON.stringify(inst));
  }

  // 逐条与暴力排序结果核对（路径、代价、价值）
  for (let i = 0; i < expectK; i++) {
    const exp = b.top[i];
    const gotPath = alts[i].order.map(id => scenes.findIndex(s => s.id === id));
    if (lexArr(gotPath, exp.path) !== 0) {
      throw new Error(`第 ${i + 1} 条备选路径错误：got ${gotPath} exp ${exp.path} ` + JSON.stringify(inst));
    }
    if (alts[i].totalCost !== exp.cost) throw new Error('备选代价排序错误');
    if (mode === 'timed' && alts[i].totalValue !== exp.value) throw new Error('备选价值排序错误');
    if (alts[i].rank !== i + 1) throw new Error('备选 rank 字段错误');
    checkAlternative(scenes, constraints, alts[i], mode, timeLimit, opLimit);
  }

  // 唯一性与非递减排序
  const seen = new Set(alts.map(a => a.order.join(',')));
  if (seen.size !== alts.length) throw new Error('备选之间存在重复顺序');
  for (let i = 1; i < alts.length; i++) {
    if (mode === 'timed' && alts[i - 1].totalValue < alts[i].totalValue) throw new Error('价值未降序');
    if (mode === 'timed' && alts[i - 1].totalValue === alts[i].totalValue
        && alts[i - 1].totalCost > alts[i].totalCost) throw new Error('同价值下代价未升序');
    if (mode === 'classic' && alts[i - 1].totalCost > alts[i].totalCost) throw new Error('代价未升序');
  }

  // 顶层字段始终描述第 1 条方案
  if (JSON.stringify(r.order) !== JSON.stringify(alts[0].order)) throw new Error('顶层 order 与第 1 条备选不一致');
  tested++;
}
console.log(`备选节目单随机对拍 ${tested} 例全部一致 ✔`);

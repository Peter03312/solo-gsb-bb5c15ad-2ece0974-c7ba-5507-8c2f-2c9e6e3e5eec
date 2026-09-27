'use strict';
/**
 * 装箱随机对拍：用"枚举全部集合划分（restricted growth string）"的
 * 暴力算法求最少箱数，与 packing.js 的子集 DP 结果对拍。
 * 用法：node fuzz-pack.js [组数=400]
 */
const { packItems, validatePacking } = require('./packing');

const ITERS = Number(process.argv[2]) || 400;

let seed = 987654321;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function ri(n) { return Math.floor(rnd() * n); }

/** 暴力最少箱数：枚举 n 件道具的全部集合划分，保留每箱可行（承重 + 互斥）的划分，取箱数最小。 */
function brute(n, weights, cap, conflict) {
  const labels = new Array(n).fill(0);
  let best = n + 1;
  (function gen(i, maxLabel) {
    if (i === n) {
      const binCount = maxLabel + 1;
      if (binCount >= best) return;
      const binW = new Array(binCount).fill(0);
      const binMask = new Array(binCount).fill(0);
      for (let k = 0; k < n; k++) {
        const b = labels[k];
        if ((binMask[b] & conflict[k]) !== 0) return; // 箱内含互斥对
        binW[b] += weights[k];
        if (binW[b] > cap) return;
        binMask[b] |= 1 << k;
      }
      best = binCount;
      return;
    }
    for (let b = 0; b <= maxLabel + 1 && b < n; b++) {
      labels[i] = b;
      gen(i + 1, Math.max(maxLabel, b));
    }
  })(1, 0); // 第 0 件固定在第 0 箱（划分的对称性）
  return best;
}

let cases = 0;
for (let t = 0; t < ITERS; t++) {
  const n = 1 + ri(9); // 1..9 件（划分枚举上限，10! 级别仍可接受）
  const weights = Array.from({ length: n }, () => 1 + ri(9));
  const cap = Math.max(1, Math.max(...weights) - (rnd() < 0.3 ? ri(3) : 0));
  const effectiveCap = Math.max(cap, Math.max(...weights)); // 保证无单件超重
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rnd() < 0.18) pairs.push({ a: `p${i}`, b: `p${j}` });
    }
  }
  const scenes = [{ id: 's', props: weights.map((_, i) => `p${i}`) }];
  const wmap = Object.fromEntries(weights.map((w, i) => [`p${i}`, w]));
  const body = { scenes, packing: { capacity: effectiveCap, weights: wmap, pairs } };

  const v = validatePacking(body);
  if (v.errors.length) throw new Error('合法载荷被判错：' + v.errors.join('；'));
  const r = packItems(v.items, v.capacity, v.pairs);
  if (!r.ok) throw new Error('合法载荷求解失败');

  const conflict = new Array(n).fill(0);
  for (const p of pairs) {
    const a = Number(p.a.slice(1));
    const b = Number(p.b.slice(1));
    conflict[a] |= 1 << b;
    conflict[b] |= 1 << a;
  }
  const expectBins = brute(n, weights, effectiveCap, conflict);
  if (r.totalBins !== expectBins) {
    console.error(JSON.stringify(body, null, 2));
    throw new Error(`第 ${t} 组：DP=${r.totalBins} 箱，暴力=${expectBins} 箱`);
  }

  // 合法性核对：覆盖全部道具、每箱承重与互斥
  const seen = new Set();
  for (const b of r.bins) {
    if (b.weight > effectiveCap) throw new Error('箱子超重');
    const idxs = b.items.map(name => Number(name.slice(1)));
    for (const i of idxs) {
      if (seen.has(i)) throw new Error('道具重复入箱');
      seen.add(i);
    }
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        if ((conflict[idxs[x]] & (1 << idxs[y])) !== 0) throw new Error('互斥道具同箱');
      }
    }
    // 箱内按录入顺序
    const sorted = idxs.slice().sort((a, b) => a - b);
    if (JSON.stringify(idxs) !== JSON.stringify(sorted)) throw new Error('箱内顺序不稳定');
  }
  if (seen.size !== n) throw new Error('道具未全部入箱');
  cases++;
}

console.log(`装箱对拍 ${cases} 组全部通过 ✔`);

'use strict';

/**
 * 巡演装箱：把全部场景道具（汇总去重后）装进若干箱子。
 *
 * 约束：
 *  - 每件道具有正整数重量，每箱总重量不得超过单箱承重 capacity；
 *  - 互斥道具对不得装入同一箱；
 *  - 道具件数 n ≤ 14（MAX_PACK_ITEMS）。
 *
 * 目标：箱数最少的完整分箱（每件道具恰好入一箱）。
 * 只要每件道具单件不超承重，必然有解（每件单独一箱），
 * 因此"单件超重"在校验阶段即被拦截，求解阶段恒可完整分箱。
 *
 * 算法：子集 DP。
 *  - 先对全部 2^n 个子集计算"可行箱"（总重不超限且内部无互斥对）：
 *    重量和与互斥判定均按最低位递推，O(2^n)；
 *  - dp[mask] = 覆盖 mask 所需的最少箱数
 *    = 1 + min{ dp[mask \ s] : s 为 mask 的非空可行子集 }，O(3^n)，n=14 约 480 万次转移；
 *  - 重构时逐箱取出：每箱必含当前剩余道具中录入顺序最早的一件，
 *    在保持总箱数最少的候选中，优先取件数最多者，再按箱内录入顺序字典序取最小者，
 *    保证结果确定；箱内道具与箱间顺序均按道具录入顺序稳定展示。
 */

const { normalizeProps } = require('./solver');

/** 一次装箱最多可处理的道具件数。 */
const MAX_PACK_ITEMS = 14;

function popcount(x) {
  let c = 0;
  while (x) { x &= x - 1; c++; }
  return c;
}

/** 掩码的置位下标升序列表（即录入顺序）。 */
function maskItems(mask) {
  const out = [];
  for (let m = mask; m; m &= m - 1) out.push(31 - Math.clz32(m & (-m)));
  return out;
}

/** 从场景列表汇总去重道具名（保持录入顺序：先场景序、后场景内顺序）。 */
function collectProps(scenes) {
  const seen = new Set();
  const out = [];
  for (const s of scenes || []) {
    for (const p of normalizeProps(s && s.props)) {
      if (!seen.has(p)) { seen.add(p); out.push(p); }
    }
  }
  return out;
}

/**
 * 校验并规范化装箱载荷 { scenes, packing: { capacity, weights, pairs } }。
 * 返回 { errors, items, capacity, pairs }：
 *  - items: [{ name, weight }]（按录入顺序去重后的待运输道具，重量为正整数）
 *  - capacity: 正整数单箱承重
 *  - pairs: [{ a, b }]（去重后的互斥道具名对，a ≠ b 且均已录入）
 */
function validatePacking(body) {
  const errors = [];

  const rawScenes = body && body.scenes;
  const hasScenes = Array.isArray(rawScenes);
  if (!hasScenes) errors.push('场景数据缺失，无法汇总待运输道具');
  const names = collectProps(hasScenes ? rawScenes : []);
  if (hasScenes && names.length === 0) {
    errors.push('场景中还没有任何道具，请先在场景道具里录入至少一件待运输道具');
  }
  if (names.length > MAX_PACK_ITEMS) {
    errors.push(`待运输道具共 ${names.length} 件，超过 ${MAX_PACK_ITEMS} 件上限，请减少道具种类后再装箱`);
  }
  const itemSet = new Set(names);

  const packing = (body && body.packing) || {};

  // 单箱承重：正整数
  let capacity = Number(packing.capacity);
  if (!Number.isInteger(capacity) || capacity <= 0) {
    errors.push('单箱承重必须是正整数');
    capacity = 0;
  }

  // 逐件重量：每件待运输道具都必须是正整数；不允许多余的道具名
  const rawWeights = packing.weights;
  const weights = (rawWeights && typeof rawWeights === 'object' && !Array.isArray(rawWeights)) ? rawWeights : {};
  if (rawWeights !== undefined && (typeof rawWeights !== 'object' || rawWeights === null || Array.isArray(rawWeights))) {
    errors.push('重量配置格式无效：应为 { 道具名: 正整数重量 }');
  }
  const items = [];
  for (const name of names) {
    const w = Number(weights[name]);
    if (!Number.isInteger(w) || w <= 0) {
      errors.push(`道具「${name}」的重量必须是正整数`);
    } else {
      items.push({ name, weight: w });
    }
  }
  for (const key of Object.keys(weights)) {
    if (!itemSet.has(key)) errors.push(`重量配置中包含非待运输道具：${key}`);
  }

  // 互斥对：双方都必须已录入且不相同；按无序对去重
  const pairs = [];
  if (packing.pairs !== undefined && !Array.isArray(packing.pairs)) {
    errors.push('互斥对配置格式无效：应为数组');
  }
  const pairSeen = new Set();
  for (const pr of (Array.isArray(packing.pairs) ? packing.pairs : [])) {
    const a = pr && pr.a;
    const b = pr && pr.b;
    if (!itemSet.has(a) || !itemSet.has(b)) {
      const missing = !itemSet.has(a) ? a : b;
      errors.push(`互斥对引用了不存在的道具：${missing}`);
      continue;
    }
    if (a === b) {
      errors.push(`互斥对的两个道具相同：${a}`);
      continue;
    }
    const key = [a, b].sort().join('\u0001');
    if (pairSeen.has(key)) continue;
    pairSeen.add(key);
    pairs.push({ a, b });
  }

  // 单件超重：必然无法装箱，直接给出具体提示
  if (capacity > 0) {
    for (const it of items) {
      if (it.weight > capacity) {
        errors.push(`道具「${it.name}」的重量 ${it.weight} 超过单箱承重 ${capacity}，无法装箱`);
      }
    }
  }

  return { errors, items, capacity, pairs };
}

/**
 * 求箱数最少的完整分箱。入参须先经 validatePacking 校验（此时恒有解）。
 * 返回 { ok, items, capacity, bins, totalBins, totalWeight }，
 * bins[i] = { items: [道具名...], weight }，箱内与箱间均按录入顺序稳定排列。
 */
function packItems(items, capacity, pairs) {
  const n = items.length;
  const weights = items.map(it => it.weight);
  const index = new Map(items.map((it, i) => [it.name, i]));

  // conflict[i]：与 i 互斥的道具位掩码（对称）
  const conflict = new Array(n).fill(0);
  for (const p of pairs || []) {
    const a = index.get(p.a);
    const b = index.get(p.b);
    if (a === undefined || b === undefined || a === b) continue;
    conflict[a] |= 1 << b;
    conflict[b] |= 1 << a;
  }

  const size = 1 << n;
  const sumW = new Array(size).fill(0);
  const feasible = new Array(size).fill(false);
  feasible[0] = true;
  for (let mask = 1; mask < size; mask++) {
    const low = mask & (-mask);
    const bit = 31 - Math.clz32(low);
    const rest = mask ^ low;
    sumW[mask] = sumW[rest] + weights[bit];
    feasible[mask] = feasible[rest] && (conflict[bit] & rest) === 0 && sumW[mask] <= capacity;
  }

  // dp[mask]：恰好覆盖 mask 所需的最少箱数
  const dp = new Array(size).fill(Infinity);
  dp[0] = 0;
  for (let mask = 1; mask < size; mask++) {
    let best = Infinity;
    for (let s = mask; s; s = (s - 1) & mask) {
      if (!feasible[s]) continue;
      const v = dp[mask ^ s] + 1;
      if (v < best) best = v;
    }
    dp[mask] = best;
  }

  const full = size - 1;
  if (!Number.isFinite(dp[full])) {
    // 校验通过后理论上不可达（每件单独一箱恒可行），防御性返回
    return { ok: false, errors: ['在当前承重与互斥配置下无法完成装箱'] };
  }

  // 重构：每箱必含剩余最早录入的道具；同为最少箱数时，优先件数多、再按录入顺序字典序小
  const bins = [];
  let mask = full;
  while (mask) {
    const lowBit = mask & (-mask);
    let best = 0;
    for (let s = mask; s; s = (s - 1) & mask) {
      if (!(s & lowBit) || !feasible[s]) continue;
      if (dp[mask ^ s] + 1 !== dp[mask]) continue;
      if (!best || betterBin(s, best)) best = s;
    }
    bins.push(best);
    mask ^= best;
  }

  return {
    ok: true,
    items: items.map(it => ({ name: it.name, weight: it.weight })),
    capacity,
    bins: bins.map(m => ({
      items: maskItems(m).map(i => items[i].name),
      weight: sumW[m],
    })),
    totalBins: bins.length,
    totalWeight: sumW[full],
  };
}

/** a 是否优于 b（同为最少箱数候选箱）：件数多者优先；件数相同按录入顺序字典序小者优先。 */
function betterBin(a, b) {
  const pa = popcount(a);
  const pb = popcount(b);
  if (pa !== pb) return pa > pb;
  let x = a;
  let y = b;
  while (x && y) {
    const ia = 31 - Math.clz32(x & (-x));
    const ib = 31 - Math.clz32(y & (-y));
    if (ia !== ib) return ia < ib;
    x &= x - 1;
    y &= y - 1;
  }
  return false;
}

module.exports = { packItems, validatePacking, collectProps, MAX_PACK_ITEMS };

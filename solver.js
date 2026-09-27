'use strict';

/**
 * 求解器：在全部约束下，求道具增减次数最少的场景演出顺序。
 *
 * 两种编排模式：
 *  - classic（默认，经典编排）：全部场景必须参演，仅最小化道具增减次数。
 *  - timed（时长受限编排）：场景带时长 duration、必演标记 required、可选价值 value，
 *    并给定整场时长上限 timeLimit。从场景中选择一个包含全部必演项的子集参演，
 *    按依赖 / 固定序位 / 禁止相邻约束编排；未入选场景不参与任何约束，
 *    固定序位按"入选后的演出序列"计算。
 *
 * timed 模式目标（字典序）：
 *    1. 最大化入选可选场景的价值总和；
 *    2. 最小化道具增减次数（开场布置 + 各次换景撤下/上台之和）；
 *    3. 同分时保持确定顺序（子集掩码升序、场景下标升序）。
 *
 * 可选参数 opLimit（单段道具操作上限，正整数；缺省/Infinity 表示不限）：
 *    开场布置与每一次换景的"撤下数 + 上台数"都不得超过该上限。
 *    求解器在同时满足现有约束与该上限的候选中，仍按上述原目标择优；
 *    重排时上限只约束后缀（含"从当前实际道具切入"的首段），已完成前缀不变。
 *
 * 约束类型：
 *  - dependencies:        [{ before, after }]   before 必须排在 after 之前（二者都入选时生效）
 *  - fixedPositions:      [{ sceneId, position }] 场景固定在第 position 位（1 起，按入选序列计）
 *  - forbiddenAdjacencies:[{ a, b }]            a 与 b 不得相邻（二者都入选时生效）
 *
 * 算法：n <= 12。
 *  - classic：子集 DP（Held-Karp 风格），状态 (已排集合, 末尾场景)，O(2^n * n^2)。
 *  - timed：单个全局子集 DP 同时求出所有入选子集的最优排列——按"末尾场景在
 *    集合内无后继、固定序位等于集合长度-1"刻画可行性，未入选场景的约束自然
 *    失效，固定序位自动按入选序列位置计算；最后在含全部必演项且不超时的
 *    子集中按价值最高、代价最低择优。复杂度同样 O(2^n * n^2)。
 */

const MAX_SCENES = 12;
/** /api/solve 一次最多可请求的备选节目单条数（含最优方案本身）。 */
const MAX_ALTERNATIVES = 3;

function normalizeProps(props) {
  const out = [];
  const seen = new Set();
  for (const p of props || []) {
    const s = String(p).trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function popcount(x) {
  let c = 0;
  while (x) { x &= x - 1; c++; }
  return c;
}

/** 单段道具操作上限：非负有限整数（0 起），否则视为不限（Infinity）。 */
function normOpLimit(v) {
  if (v === null || v === undefined || v === '') return Infinity;
  const n = Number(v);
  return (Number.isFinite(n) && Number.isInteger(n) && n >= 0) ? n : Infinity;
}

/** 把输入编译成位掩码/矩阵模型，供 DP 使用。 */
function buildModel(scenes, constraints) {
  const n = scenes.length;
  const index = new Map();
  scenes.forEach((s, i) => index.set(s.id, i));
  const propSets = scenes.map(s => new Set(normalizeProps(s.props)));

  // prereq[i]: 必须排在 i 之前的场景位掩码
  const prereq = new Array(n).fill(0);
  for (const d of (constraints && constraints.dependencies) || []) {
    const a = index.get(d.before);
    const b = index.get(d.after);
    if (a === undefined || b === undefined) continue;
    prereq[b] |= (1 << a);
  }

  // 固定序位（position 为 1 起，内部转 0 起）
  const fixedPosOfScene = new Array(n).fill(-1);
  const sceneAtPos = new Array(n).fill(-1);
  // fixedMask[i]：场景 i 被固定到的全部序位（同一场景可存在多条固定约束）
  const fixedMask = new Array(n).fill(0);
  for (const f of (constraints && constraints.fixedPositions) || []) {
    const i = index.get(f.sceneId);
    if (i === undefined) continue;
    const p = Number(f.position) - 1;
    if (p < 0 || p >= n) continue;
    fixedPosOfScene[i] = p;
    fixedMask[i] |= (1 << p);
    sceneAtPos[p] = i; // 若两个场景固定同一序位，DP 必然无解，由冲突分析给出核心
  }

  // 禁止相邻矩阵（对称）
  const bad = Array.from({ length: n }, () => new Array(n).fill(false));
  for (const f of (constraints && constraints.forbiddenAdjacencies) || []) {
    const a = index.get(f.a);
    const b = index.get(f.b);
    if (a === undefined || b === undefined || a === b) continue;
    bad[a][b] = bad[b][a] = true;
  }

  // 换景代价：对称差大小
  const cost = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      let c = 0;
      for (const p of propSets[i]) if (!propSets[j].has(p)) c++;
      for (const p of propSets[j]) if (!propSets[i].has(p)) c++;
      cost[i][j] = c;
    }
  }
  const setupCost = propSets.map(s => s.size);

  // timed 模式附加字段（必演场景不参与可选价值统计）
  const durations = scenes.map(s => Number(s.duration) || 0);
  const values = scenes.map(s => (s.required ? 0 : (Number(s.value) || 0)));
  let requiredMask = 0;
  scenes.forEach((s, i) => { if (s.required) requiredMask |= (1 << i); });

  return {
    n, propSets, prereq, fixedPosOfScene, fixedMask, sceneAtPos, bad, cost, setupCost,
    durations, values, requiredMask,
  };
}

/**
 * 子集 DP。返回 { cost, orderIdx } 或 null（无解）。要求全部 n 个场景都排入。
 * opLimit 给出时，开场布置与每次换景的道具操作数都不得超过它。
 */
function runDP(model, opLimit = Infinity) {
  const { n, prereq, fixedPosOfScene, sceneAtPos, bad, cost, setupCost } = model;
  const fullMask = (1 << n) - 1;
  const size = 1 << n;
  const dp = new Array(size);
  const parent = new Array(size);

  const allowedAt = (j, pos) =>
    (fixedPosOfScene[j] === -1 || fixedPosOfScene[j] === pos) &&
    (sceneAtPos[pos] === -1 || sceneAtPos[pos] === j);

  const ensure = (m) => {
    if (!dp[m]) {
      dp[m] = new Array(n).fill(Infinity);
      parent[m] = new Array(n).fill(-1);
    }
  };

  for (let j = 0; j < n; j++) {
    if (prereq[j] !== 0) continue;      // 有前置依赖的场景不能排首位
    if (!allowedAt(j, 0)) continue;
    if (setupCost[j] > opLimit) continue; // 开场布置超出单段上限
    const m = 1 << j;
    ensure(m);
    dp[m][j] = setupCost[j];
  }

  for (let mask = 1; mask <= fullMask; mask++) {
    const row = dp[mask];
    if (!row) continue;
    const pos = popcount(mask); // 下一位的序位（0 起）
    if (pos >= n) continue;
    for (let last = 0; last < n; last++) {
      const cur = row[last];
      if (cur === Infinity) continue;
      for (let j = 0; j < n; j++) {
        const bit = 1 << j;
        if (mask & bit) continue;
        if ((prereq[j] & ~mask) !== 0) continue; // 前置依赖必须已全部排入
        if (!allowedAt(j, pos)) continue;
        if (bad[last][j]) continue;
        if (cost[last][j] > opLimit) continue;   // 本次换景超出单段上限
        const nm = mask | bit;
        const nc = cur + cost[last][j];
        ensure(nm);
        if (nc < dp[nm][j]) { // 严格小于：保证结果确定性（按下标字典序取先到达者）
          dp[nm][j] = nc;
          parent[nm][j] = last;
        }
      }
    }
  }

  const fullRow = dp[fullMask];
  if (!fullRow) return null;
  let best = Infinity;
  let bestLast = -1;
  for (let last = 0; last < n; last++) {
    if (fullRow[last] < best) {
      best = fullRow[last];
      bestLast = last;
    }
  }
  if (bestLast === -1) return null;

  const orderIdx = [];
  let mask = fullMask;
  let last = bestLast;
  while (true) {
    orderIdx.push(last);
    const p = parent[mask][last];
    if (p === -1) break;
    mask ^= (1 << last);
    last = p;
  }
  orderIdx.reverse();
  return { cost: best, orderIdx };
}

/**
 * timed 模式：单个全局子集 DP，同时求出每个入选子集 M 的最优排列代价。
 *
 * 关键刻画（按最终入选集合 M 归纳）：M 的一个排列可行，当且仅当：
 *  - 末尾场景 last 在 M 内没有"必须排在它之后"的场景（succ[last] & M\\{last} = ∅）；
 *  - last 的固定序位为 -1 或 |M|-1；
 *  - 倒数第二个场景与 last 不构成禁止相邻；
 *  - 去掉 last 后，前缀集合 M\\{last} 自身可行。
 * 这样涉及"未入选场景"的依赖 / 固定序位 / 相邻约束全部自然失效，
 * 固定序位也天然按"入选后的序列位置"（popcount）计算。
 *
 * 状态 dp[mask][last] = 恰好排列 mask、以 last 结尾的最小总代价（含开场布置）。
 * 一次 DP 得到全部 2^n 个子集的答案，复杂度 O(2^n * n^2)。
 *
 * 最后在所有 mask ⊇ requiredMask、总时长 ≤ timeLimit 的候选中，
 * 取价值最高、代价最低者；同分时按掩码升序、末尾下标升序保持确定性。
 * 无必演场景时空集（空节目单）作为 value=0、cost=0 的保底可行解。
 */
function runTimedDP(model, timeLimit, opLimit = Infinity) {
  const { n, prereq, fixedMask, bad, cost, setupCost, durations, values, requiredMask } = model;
  const fullMask = (1 << n) - 1;

  // fixedAt(j, p)：场景 j 可在序位 p 出现 ⇔ 它没有固定约束，或恰好固定在 p
  const fixedAt = (j, p) => {
    const fm = fixedMask[j];
    return fm === 0 || fm === (1 << p);
  };

  // succMask[a]：必须排在 a 之后的场景集合
  const succMask = new Array(n).fill(0);
  for (let b = 0; b < n; b++) {
    let m = prereq[b];
    while (m) {
      const bit = m & -m;
      const a = 31 - Math.clz32(bit);
      succMask[a] |= (1 << b);
      m ^= bit;
    }
  }

  // 预计算每个子集的总时长与总价值
  const durSum = new Float64Array(1 << n);
  const valSum = new Float64Array(1 << n);
  for (let m = 1; m <= fullMask; m++) {
    const bit = m & -m;
    const i = 31 - Math.clz32(bit);
    const pm = m ^ bit;
    durSum[m] = durSum[pm] + durations[i];
    valSum[m] = valSum[pm] + values[i];
  }

  const size = 1 << n;
  const dp = new Array(size);
  const parent = new Array(size);
  const ensure = (m) => {
    if (!dp[m]) {
      dp[m] = new Float64Array(n).fill(Infinity);
      parent[m] = new Int8Array(n).fill(-1);
    }
  };

  // 单元素集合：该场景没有固定约束，或恰好固定在第 0 位
  for (let j = 0; j < n; j++) {
    if (!fixedAt(j, 0)) continue;
    if (setupCost[j] > opLimit) continue; // 开场布置超出单段上限
    const m = 1 << j;
    ensure(m);
    dp[m][j] = setupCost[j];
  }

  for (let mask = 1; mask <= fullMask; mask++) {
    const row = dp[mask];
    if (!row) continue;
    const posAfter = popcount(mask); // 追加后新场景所在序位（0 起）
    for (let last = 0; last < n; last++) {
      const bit = 1 << last;
      if (mask & bit) continue;
      const nm = mask | bit;
      if (!fixedAt(last, posAfter)) continue;
      // last 在最终集合 nm 内不能还有必须排在其后的场景
      if (succMask[last] & mask) continue;
      let best = Infinity;
      let bestPrev = -1;
      for (let prev = 0; prev < n; prev++) {
        const v = row[prev];
        if (v === Infinity) continue;
        if (bad[prev][last]) continue;
        if (cost[prev][last] > opLimit) continue; // 本次换景超出单段上限
        const nc = v + cost[prev][last];
        if (nc < best) { best = nc; bestPrev = prev; } // prev 升序，严格小于 → 确定
      }
      if (bestPrev !== -1) {
        ensure(nm);
        // (nm,last) 的前缀集合唯一（nm\{last}），这里只会写入一次；保留严格比较以防万一
        if (best < dp[nm][last]) {
          dp[nm][last] = best;
          parent[nm][last] = bestPrev;
        }
      }
    }
  }

  // 无必演项时，空节目单是保底解（价值 0，代价 0）
  let best = requiredMask === 0
    ? { cost: 0, orderIdx: [], value: 0, usedDuration: 0, mask: 0, last: -1 }
    : null;

  for (let mask = 0; mask <= fullMask; mask++) {
    if ((mask & requiredMask) !== requiredMask) continue;
    if (durSum[mask] > timeLimit) continue;
    const row = dp[mask];
    if (!row) continue;
    let last = -1;
    let c = Infinity;
    for (let j = 0; j < n; j++) {
      if (row[j] < c) { c = row[j]; last = j; }
    }
    if (last === -1) continue;
    const value = valSum[mask];
    const take = !best
      || value > best.value
      || (value === best.value && c < best.cost);
    // 价值、代价都相同：保留先到达者（mask 升序）→ 结果确定
    if (take) best = { cost: c, value, usedDuration: durSum[mask], mask, last };
  }
  if (!best) return null;

  const orderIdx = [];
  let mask = best.mask;
  let last = best.last;
  while (last !== -1) {
    orderIdx.push(last);
    const prev = parent[mask][last];
    mask ^= (1 << last);
    last = prev;
  }
  orderIdx.reverse();
  return { cost: best.cost, orderIdx, value: best.value, usedDuration: best.usedDuration, mask: best.mask };
}

/* ============================================================
 * 备选节目单（k-best）
 * ============================================================
 *
 * 用户可一次请求最多 MAX_ALTERNATIVES 条顺序互不相同的可行编排。
 * 与单解 DP 不同，这里每个 (集合, 末尾) 状态保留至多 K 条互不相同的
 * 最优路径（K-best on a DAG / 子集格），因此不会因某个中间状态只留下
 * 一条最优路径而丢掉次优但同样可行的完整编排。
 *
 * 排序规则：
 *  - classic：总操作数（开场布置 + 各次换景）升序；
 *  - timed：① 入选可选场景价值降序 → ② 总操作数升序；
 *  - 完全同分：按"场景下标序列字典序"稳定排序（等价于按场景录入顺序，
 *    第一个出现分歧的位置取录入更靠前的场景）。
 *
 * 单段上限 opLimit 与依赖 / 固定序位 / 禁止相邻在每条边上逐段校验，
 * 因此返回的每一条备选都满足全部约束。
 */

/** 规范化备选条数：接受 1..MAX_ALTERNATIVES 的整数，其余视为不请求（1）。 */
function normAlternatives(v) {
  const n = Number(v);
  return (Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= MAX_ALTERNATIVES) ? n : 1;
}

/** 两个下标序列按字典序比较：a < b 返回 -1，a > b 返回 1，完全相同返回 0。 */
function lexCompare(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
}

/** 同状态桶的排序键：代价升序 → 路径字典序升序。返回 sort 比较器语义（-1/0/1）。 */
function entryCompare(x, y) {
  if (x.cost !== y.cost) return x.cost < y.cost ? -1 : 1;
  return lexCompare(x.path, y.path);
}

/**
 * 对状态桶就地排序、按路径去重并截断到至多 K 条。
 * 状态 dp[mask] 只在"向更大集合的转移开始前"剪枝（读桶前），
 * 此时对 dp[mask] 的全部写入均已完成，故按每状态保留 K 条不会漏解。
 */
function pruneBucket(bucket, K) {
  if (bucket.length <= 1) return;
  bucket.sort(entryCompare);
  let w = 0;
  for (let i = 0; i < bucket.length; i++) {
    if (w > 0 && lexCompare(bucket[i].path, bucket[w - 1].path) === 0) continue;
    bucket[w++] = bucket[i];
    if (w === K) break;
  }
  bucket.length = w;
}

/**
 * classic k-best：状态 (已排集合, 末尾场景) 各保留至多 K 条最优路径。
 * 返回按（代价升序、路径字典序升序）排列的至多 K 条完整编排，每条为
 * { cost, path: [全局场景下标...] }；无解返回空数组。
 */
function runDPKBest(model, opLimit = Infinity, K = MAX_ALTERNATIVES) {
  const { n, prereq, fixedPosOfScene, sceneAtPos, bad, cost, setupCost } = model;
  const fullMask = (1 << n) - 1;

  const allowedAt = (j, pos) =>
    (fixedPosOfScene[j] === -1 || fixedPosOfScene[j] === pos) &&
    (sceneAtPos[pos] === -1 || sceneAtPos[pos] === j);

  // dp[mask][last]：该状态的路径桶（惰性创建）
  const dp = new Array(1 << n);
  const ensure = (m, last) => {
    if (!dp[m]) dp[m] = Array.from({ length: n }, () => null);
    if (!dp[m][last]) dp[m][last] = [];
    return dp[m][last];
  };

  for (let j = 0; j < n; j++) {
    if (prereq[j] !== 0) continue;
    if (!allowedAt(j, 0)) continue;
    if (setupCost[j] > opLimit) continue;
    ensure(1 << j, j).push({ cost: setupCost[j], path: [j] });
  }

  for (let mask = 1; mask <= fullMask; mask++) {
    const layer = dp[mask];
    if (!layer) continue;
    const pos = popcount(mask); // 追加场景所在序位（0 起）
    if (pos >= n) continue;
    for (let last = 0; last < n; last++) {
      const bucket = layer[last];
      if (!bucket) continue;
      pruneBucket(bucket, K); // 即将作为前驱被读取：剪枝
      for (const entry of bucket) {
        for (let j = 0; j < n; j++) {
          const bit = 1 << j;
          if (mask & bit) continue;
          if ((prereq[j] & ~mask) !== 0) continue;
          if (!allowedAt(j, pos)) continue;
          if (bad[last][j]) continue;
          if (cost[last][j] > opLimit) continue;
          ensure(mask | bit, j).push({ cost: entry.cost + cost[last][j], path: entry.path.concat(j) });
        }
      }
    }
  }

  const full = dp[fullMask];
  if (!full) return [];
  const all = [];
  for (let last = 0; last < n; last++) {
    const bucket = full[last];
    if (bucket) for (const e of bucket) all.push(e);
  }
  pruneBucket(all, K);
  return all;
}

/**
 * timed k-best：全局子集 DP，每个 (入选集合, 末尾场景) 状态保留至多 K 条
 * 最优排列路径。最终在全部"含必演、不超时"的候选路径中，按
 * （价值降序、代价升序、路径字典序升序）取至多 K 条；不同备选允许
 * 入选不同的场景子集。无必演时空节目单恒为一条可行备选。
 */
function runTimedDPKBest(model, timeLimit, opLimit = Infinity, K = MAX_ALTERNATIVES) {
  const { n, prereq, fixedMask, bad, cost, setupCost, durations, values, requiredMask } = model;
  const fullMask = (1 << n) - 1;

  const fixedAt = (j, p) => {
    const fm = fixedMask[j];
    return fm === 0 || fm === (1 << p);
  };

  // succMask[a]：必须排在 a 之后的场景集合
  const succMask = new Array(n).fill(0);
  for (let b = 0; b < n; b++) {
    let m = prereq[b];
    while (m) {
      const bit = m & -m;
      const a = 31 - Math.clz32(bit);
      succMask[a] |= (1 << b);
      m ^= bit;
    }
  }

  const durSum = new Float64Array(1 << n);
  const valSum = new Float64Array(1 << n);
  for (let m = 1; m <= fullMask; m++) {
    const bit = m & -m;
    const i = 31 - Math.clz32(bit);
    const pm = m ^ bit;
    durSum[m] = durSum[pm] + durations[i];
    valSum[m] = valSum[pm] + values[i];
  }

  const dp = new Array(1 << n);
  const ensure = (m, last) => {
    if (!dp[m]) dp[m] = Array.from({ length: n }, () => null);
    if (!dp[m][last]) dp[m][last] = [];
    return dp[m][last];
  };

  for (let j = 0; j < n; j++) {
    if (!fixedAt(j, 0)) continue;
    if (setupCost[j] > opLimit) continue;
    ensure(1 << j, j).push({ cost: setupCost[j], path: [j] });
  }

  for (let mask = 1; mask <= fullMask; mask++) {
    const layer = dp[mask];
    if (!layer) continue;
    const posAfter = popcount(mask);
    for (let last = 0; last < n; last++) {
      const bit = 1 << last;
      if (mask & bit) continue;
      const nm = mask | bit;
      if (!fixedAt(last, posAfter)) continue;
      if (succMask[last] & mask) continue;
      // (nm,last) 的前驱集合唯一（nm\\{last} = mask），本轮结束后该桶写入完毕
      let w = null;
      for (let prev = 0; prev < n; prev++) {
        const bucket = layer[prev];
        if (!bucket) continue;
        pruneBucket(bucket, K); // 作为前驱读取前剪枝
        if (bad[prev][last]) continue;
        if (cost[prev][last] > opLimit) continue;
        if (!w) w = ensure(nm, last);
        for (const e of bucket) {
          w.push({ cost: e.cost + cost[prev][last], path: e.path.concat(last) });
        }
      }
      if (w) pruneBucket(w, K);
    }
  }

  // 全局择优：价值降序 → 代价升序 → 路径字典序升序，在线维护至多 K 条
  const better = (x, y) =>
    x.value > y.value
    || (x.value === y.value && (x.cost < y.cost
      || (x.cost === y.cost && lexCompare(x.path, y.path) < 0)));

  const winners = []; // [{ cost, path, value, usedDuration, mask }]
  const consider = (entry, mask) => {
    const cand = {
      cost: entry.cost, path: entry.path, value: valSum[mask],
      usedDuration: durSum[mask], mask,
    };
    if (winners.length < K || better(cand, winners[winners.length - 1])) {
      winners.push(cand);
      let i = winners.length - 1;
      while (i > 0 && better(winners[i], winners[i - 1])) {
        [winners[i - 1], winners[i]] = [winners[i], winners[i - 1]];
        i--;
      }
      if (winners.length > K) winners.pop();
    }
  };

  // 无必演项：空节目单（价值 0、代价 0）恒为可行备选
  if (requiredMask === 0) {
    consider({ cost: 0, path: [] }, 0);
  }

  for (let mask = 0; mask <= fullMask; mask++) {
    if (mask === 0) continue;
    if ((mask & requiredMask) !== requiredMask) continue;
    if (durSum[mask] > timeLimit) continue;
    const layer = dp[mask];
    if (!layer) continue;
    for (let last = 0; last < n; last++) {
      const bucket = layer[last];
      if (!bucket) continue;
      pruneBucket(bucket, K);
      // 同 (mask,last) 内可有"同价值、同代价但顺序不同"的多条路径，
      // 它们都可能进入备选（同分按路径字典序稳定排序），须全部参选。
      for (const e of bucket) consider(e, mask);
    }
  }
  return winners;
}

/** 检测依赖环，返回构成环的依赖约束数组，无环返回 null。 */
function findDepCycle(scenes, deps) {
  const index = new Map(scenes.map((s, i) => [s.id, i]));
  const adj = scenes.map(() => []);
  for (const d of deps || []) {
    const a = index.get(d.before);
    const b = index.get(d.after);
    if (a === undefined || b === undefined) continue;
    adj[a].push({ to: b, dep: d });
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Array(scenes.length).fill(WHITE);
  const stack = [];
  let result = null;

  function dfs(u) {
    color[u] = GRAY;
    stack.push(u);
    for (const e of adj[u]) {
      if (result) return;
      if (color[e.to] === GRAY) {
        const start = stack.indexOf(e.to);
        const nodes = stack.slice(start).concat([e.to]);
        const cyc = [];
        for (let k = 0; k < nodes.length - 1; k++) {
          const edge = adj[nodes[k]].find(x => x.to === nodes[k + 1]);
          cyc.push(edge.dep);
        }
        result = cyc;
        return;
      }
      if (color[e.to] === WHITE) dfs(e.to);
    }
    stack.pop();
    color[u] = BLACK;
  }

  for (let i = 0; i < scenes.length && !result; i++) {
    if (color[i] === WHITE) dfs(i);
  }
  return result;
}

function describeConstraint(scenes, kind, data) {
  const name = (id) => {
    const s = scenes.find(x => x.id === id);
    return s ? s.name : String(id);
  };
  if (kind === 'dependency') {
    return { kind, data, text: `「${name(data.before)}」必须排在「${name(data.after)}」之前` };
  }
  if (kind === 'fixedPosition') {
    return { kind, data, text: `「${name(data.sceneId)}」固定在第 ${data.position} 位` };
  }
  return { kind, data, text: `「${name(data.a)}」与「${name(data.b)}」禁止相邻` };
}

/**
 * 经典模式无解时给出一组可复现的冲突约束：
 * 1. 若依赖存在环，直接返回环上的依赖（本身即最小冲突）；
 * 2. 否则做贪心极小化：逐条尝试移除约束，若仍无解则永久移除，
 *    剩余集合即为"去掉任意一条即可有解"的极小冲突核心。
 */
function analyzeConflict(scenes, constraints) {
  const cycle = findDepCycle(scenes, (constraints && constraints.dependencies) || []);
  if (cycle) {
    return {
      type: 'dependency-cycle',
      message: '场景依赖关系存在循环，无法排出满足全部先后约束的顺序：',
      constraints: cycle.map(d => describeConstraint(scenes, 'dependency', d)),
    };
  }

  const all = [];
  for (const d of (constraints && constraints.dependencies) || []) all.push({ kind: 'dependency', data: d });
  for (const f of (constraints && constraints.fixedPositions) || []) all.push({ kind: 'fixedPosition', data: f });
  for (const f of (constraints && constraints.forbiddenAdjacencies) || []) all.push({ kind: 'forbiddenAdjacency', data: f });

  const satisfiable = (items) => {
    const c = { dependencies: [], fixedPositions: [], forbiddenAdjacencies: [] };
    for (const it of items) {
      if (it.kind === 'dependency') c.dependencies.push(it.data);
      else if (it.kind === 'fixedPosition') c.fixedPositions.push(it.data);
      else c.forbiddenAdjacencies.push(it.data);
    }
    return runDP(buildModel(scenes, c)) !== null;
  };

  let core = all.slice();
  for (const item of all) {
    if (core.length <= 1) break;
    const trial = core.filter(x => x !== item);
    if (!satisfiable(trial)) core = trial;
  }

  return {
    type: 'constraint-set',
    message: '以下约束组合相互冲突（移除其中任意一条即可恢复有解）：',
    constraints: core.map(it => describeConstraint(scenes, it.kind, it.data)),
  };
}

/** 在给定约束集合上做贪心极小化，返回"去掉任意一条即可行"的极小冲突核心。 */
function greedyCore(scenes, deps, fixed, noAdj, feasible) {
  const all = [];
  for (const d of deps || []) all.push({ kind: 'dependency', data: d });
  for (const f of fixed || []) all.push({ kind: 'fixedPosition', data: f });
  for (const f of noAdj || []) all.push({ kind: 'forbiddenAdjacency', data: f });

  let core = all.slice();
  for (const item of all) {
    if (core.length <= 1) break;
    const trial = core.filter(x => x !== item);
    if (!feasible(trial)) core = trial;
  }
  return core;
}

/**
 * 结构可行性 DP：不受时长限制，可选场景可自由取舍、充当缓冲，
 * 只检查必演项能否在约束下排成（固定序位按全局序列计）。
 * 必演场景必须全部排入，可选场景仅在有助于满足约束（如禁止相邻缓冲、
 * 填补固定序位前的位置）时才需要排入。
 *
 * 传入的依赖 / 禁止相邻保留全部端点（涉及可选场景的边，只要该可选场景
 * 被用作缓冲就必须满足；不用它时边自然失效——DP 可自由跳过可选场景），
 * 固定序位只保留必演场景上的（可选场景的固定序位可通过不选它而失效）。
 * 状态 (已排集合 mask, 末尾场景 last)。
 */
const hasBit = (m, i) => (m & (1 << i)) !== 0;
function structuralFeasible(reqScenes, allScenes, deps, fixedRequired, noAdj) {
  if (reqScenes.length === 0) return true;
  const model = buildModel(allScenes, {
    dependencies: deps,
    fixedPositions: fixedRequired,
    forbiddenAdjacencies: noAdj,
  });
  const { n, prereq, fixedMask, sceneAtPos, bad, requiredMask } = model;
  const fullMask = (1 << n) - 1;
  const index = new Map(allScenes.map((s, i) => [s.id, i]));
  const fixedAt = (j, p) => {
    const fm = fixedMask[j];
    return fm === 0 || fm === (1 << p);
  };

  // succReq[j]：j（通常是可选场景）必须排在其之前的必演场景集合
  const succReq = new Array(n).fill(0);
  for (const d of deps || []) {
    const a = index.get(d.before);
    const b = index.get(d.after);
    if (a === undefined || b === undefined) continue;
    if (hasBit(requiredMask, b)) succReq[a] |= (1 << b);
  }

  const dp = new Array(1 << n);
  const ensure = (m) => { if (!dp[m]) dp[m] = new Uint8Array(n); };

  // 首位没有前驱，不检查禁止相邻。
  for (let j = 0; j < n; j++) {
    if (hasBit(requiredMask, j) && (prereq[j] & requiredMask) !== 0) continue; // 必演首位不能有必演前置
    if (!hasBit(requiredMask, j) && prereq[j] !== 0) continue;                  // 可选缓冲首位不能有任何前置
    if (!fixedAt(j, 0)) continue;
    ensure(1 << j);
    dp[1 << j][j] = 1;
  }

  for (let mask = 1; mask <= fullMask; mask++) {
    const row = dp[mask];
    if (!row) continue;
    if ((mask & requiredMask) === requiredMask) return true;
    const pos = popcount(mask);
    for (let last = 0; last < n; last++) {
      if (!row[last]) continue;
      for (let j = 0; j < n; j++) {
        const bit = 1 << j;
        if (mask & bit) continue;
        if (!fixedAt(j, pos)) continue; // 固定到其它序位（含同一场景被固定多位）的场景不能在此追加
        if (hasBit(requiredMask, j)) {
          // 必演：必演前置必须已排入（可选前置在该可选被使用时由其自身后继约束保证）
          if ((prereq[j] & requiredMask & ~mask) !== 0) continue;
          // 不能占据其它必演场景固定的序位
          if (sceneAtPos[pos] !== -1 && sceneAtPos[pos] !== j) continue;
        } else {
          // 可选缓冲：其全部前置依赖必须已满足，且不能排在它必须先导的必演场景之后
          if ((prereq[j] & ~mask) !== 0) continue;
          if ((succReq[j] & mask) !== 0) continue;
          if (sceneAtPos[pos] !== -1) continue; // 不能占据必演的固定序位
        }
        if (bad[last][j]) continue;
        const nm = mask | bit;
        ensure(nm);
        dp[nm][j] = 1;
      }
    }
  }
  return false;
}

/**
 * timed 模式无可行编排时的归因分析。
 * 必演项总是参演，因此：
 *  - 必演项之间的依赖环、必演项固定序位冲突等"结构性"矛盾，
 *    不可能靠取舍可选场景或提高时长上限解除；
 *  - 结构上可行（可选场景可充当缓冲）但在时长上限内不可行，
 *    则是缓冲场景放不下，给出提高上限 / 放宽约束的提示。
 */
function analyzeTimedInfeasible(scenes, constraints, model, timeLimit) {
  const reqScenes = scenes.filter(s => s.required);
  const reqIds = new Set(reqScenes.map(s => s.id));
  const deps = ((constraints && constraints.dependencies) || []);
  const fixedAll = ((constraints && constraints.fixedPositions) || [])
    .filter(f => reqIds.has(f.sceneId));
  const noAdjAll = ((constraints && constraints.forbiddenAdjacencies) || []);

  // 1. 必演项之间的依赖环
  const cycle = findDepCycle(reqScenes, deps.filter(d => reqIds.has(d.before) && reqIds.has(d.after)));
  if (cycle) {
    return {
      type: 'dependency-cycle',
      message: '必演场景之间的依赖关系存在循环，舍弃可选场景也无法解除：',
      constraints: cycle.map(d => describeConstraint(reqScenes, 'dependency', d)),
    };
  }

  // 2. 两个必演场景固定在同一序位
  const byPos = new Map();
  for (const f of fixedAll) {
    if (!byPos.has(f.position)) byPos.set(f.position, []);
    byPos.get(f.position).push(f);
  }
  for (const arr of byPos.values()) {
    if (arr.length >= 2) {
      return {
        type: 'constraint-set',
        message: '以下必演场景被固定在同一序位，互相冲突：',
        constraints: arr.slice(0, 2).map(f => describeConstraint(reqScenes, 'fixedPosition', f)),
      };
    }
  }

  // 3. 结构可行性（不限时长、可选场景可自由充当缓冲）仍失败 → 硬冲突核心。
  //    依赖 / 禁止相邻取全部（涉及可选的边在该可选不被使用时自然失效），
  //    固定序位只取必演场景上的。
  if (!structuralFeasible(reqScenes, scenes, deps, fixedAll, noAdjAll)) {
    const core = greedyCore(reqScenes, deps, fixedAll, noAdjAll, (items) => {
      const d2 = [], f2 = [], n2 = [];
      for (const it of items) {
        if (it.kind === 'dependency') d2.push(it.data);
        else if (it.kind === 'fixedPosition') f2.push(it.data);
        else n2.push(it.data);
      }
      return structuralFeasible(reqScenes, scenes, d2, f2, n2);
    });
    return {
      type: 'constraint-set',
      message: '必演场景的以下约束组合相互冲突（取舍可选场景、提高时长上限均无法解除）：',
      constraints: core.map(it => describeConstraint(scenes, it.kind, it.data)),
    };
  }

  // 4. 结构上可行但时长上限内不可行：缓冲场景放不下
  const noAdjReq = noAdjAll.filter(f => reqIds.has(f.a) && reqIds.has(f.b));
  return {
    type: 'timed-infeasible',
    message: '必演项总时长虽未超限，但在时长上限内找不到满足全部约束的可行编排：'
      + '必演项之间的禁止相邻等约束可能需要插入额外场景作为缓冲，而剩余时长不足以容纳。'
      + '请提高时长上限、调整必演项或放宽约束。',
    constraints: noAdjReq.map(f => describeConstraint(reqScenes, 'forbiddenAdjacency', f)),
  };
}

/**
 * ============================================================
 * 演出中重排（replan）
 * ============================================================
 *
 * 用户在一次求解结果上确认"已完成的连续前缀"（顺序不可改变），
 * 并录入当前舞台上的实际道具，系统只重排剩余场景：
 *  - 前缀与剩余之间的依赖按"完成事实"校验（前缀场景事实上先于一切剩余场景）；
 *  - 固定序位仍按整场绝对位次（1 起的绝对位置）计算；
 *  - 时长受限模式：扣除前缀已用时长（含上限），前缀可选场景的价值计入结果，
 *    剩余选择继续按"价值最高 → 换景最少"择优；
 *  - 首个剩余场景的代价按"当前实际道具 → 该场景道具"计算，而非原计划的末场景；
 *  - 前缀本身违反约束时，逐条指出具体冲突，不做重排。
 */

const setDiffSize = (a, b) => {
  let c = 0;
  for (const p of a) if (!b.has(p)) c++;
  return c;
};
const symDiffSize = (a, b) => setDiffSize(a, b) + setDiffSize(b, a);

/**
 * 校验已完成前缀，返回冲突描述数组（空数组表示前缀合法）。
 * 前缀是给定的 index 数组（下标顺序即实际演出顺序）。
 * timed 为 true 时，可选场景被固定到前缀位次不算冲突（可不选它），仅必演场景才算。
 */
function findPrefixConflicts(scenes, model, constraints, prefixIdx, timed) {
  const { n, prereq, fixedMask, bad } = model;
  const posInPrefix = new Array(n).fill(-1);
  prefixIdx.forEach((g, k) => { posInPrefix[g] = k; });

  const conflicts = [];
  const seen = new Set();
  const push = (type, message, data) => {
    const key = type + '|' + JSON.stringify(data || {});
    if (seen.has(key)) return;
    seen.add(key);
    conflicts.push({ type, message, data });
  };

  // 1. 前后依赖：
  //    - 两端都在前缀中：实际先后必须满足；
  //    - before 在前缀、after 在剩余：天然满足（完成事实）；
  //    - after 在前缀、before 在剩余：事实上不可能满足 → 冲突。
  for (const d of (constraints && constraints.dependencies) || []) {
    const a = indexOfScene(scenes, d.before);
    const b = indexOfScene(scenes, d.after);
    if (a === -1 || b === -1) continue;
    const pa = posInPrefix[a], pb = posInPrefix[b];
    if (pa !== -1 && pb !== -1 && pa > pb) {
      push('dependency-order',
        `已完成顺序违反依赖：${scenes[a].name} 实际排在第 ${pa + 1} 位，晚于第 ${pb + 1} 位的 ${scenes[b].name}`,
        { before: d.before, after: d.after, beforePosition: pa + 1, afterPosition: pb + 1 });
    } else if (pa === -1 && pb !== -1) {
      push('dependency-cross',
        `已完成前缀与依赖冲突：${scenes[b].name} 已在第 ${pb + 1} 位演完，而它的前置场景 ${scenes[a].name} 尚未演出，无法补救`,
        { before: d.before, after: d.after, afterPosition: pb + 1 });
    }
  }

  // 2. 固定序位按整场绝对位次计算：前缀场景必须恰在其固定位；
  //    剩余场景被固定到前缀占住的绝对位次，也已不可能满足。
  //    timed 模式下剩余的是可选场景时，可通过不选它使其固定约束失效——只有必演才算冲突。
  for (const f of (constraints && constraints.fixedPositions) || []) {
    const g = indexOfScene(scenes, f.sceneId);
    if (g === -1) continue;
    const p = Number(f.position) - 1;
    const pg = posInPrefix[g];
    if (pg !== -1 && pg !== p) {
      push('fixed-position-prefix',
        `已完成顺序违反固定序位：${scenes[g].name} 实际排在第 ${pg + 1} 位，却被固定在第 ${f.position} 位`,
        { sceneId: f.sceneId, position: f.position, actualPosition: pg + 1 });
    } else if (pg === -1 && p < prefixIdx.length && (!timed || (model.requiredMask & (1 << g)))) {
      push('fixed-position-occupied',
        timed
          ? `固定序位冲突：必演场景 ${scenes[g].name} 被固定在第 ${f.position} 位，但该位次已由 ${scenes[prefixIdx[p]].name} 完成`
          : `固定序位冲突：${scenes[g].name} 被固定在第 ${f.position} 位，但该位次已由 ${scenes[prefixIdx[p]].name} 完成`,
        { sceneId: f.sceneId, position: f.position, occupiedBy: scenes[prefixIdx[p]].id });
    }
  }

  // 3. 禁止相邻：前缀内部相邻的场景不能构成禁止相邻对
  for (let k = 0; k + 1 < prefixIdx.length; k++) {
    const a = prefixIdx[k], b = prefixIdx[k + 1];
    if (bad[a][b]) {
      push('forbidden-adjacency-prefix',
        `已完成顺序违反禁止相邻：${scenes[a].name} 与 ${scenes[b].name} 在第 ${k + 1}、${k + 2} 位紧挨着演出`,
        { a: scenes[a].id, b: scenes[b].id, position: k + 1 });
    }
  }

  return conflicts;
}

function indexOfScene(scenes, id) {
  for (let i = 0; i < scenes.length; i++) if (scenes[i].id === id) return i;
  return -1;
}

/**
 * 构建后缀上下文：前缀/剩余场景划分、活动约束划分。
 * activeDeps 只保留两端都在剩余集合中的依赖（跨前缀依赖按事实判定，无需进入 DP）。
 */
function buildSuffixContext(scenes, model, constraints, prefixIdx, prefixMask) {
  const n = scenes.length;
  const remainingIdx = [];
  for (let i = 0; i < n; i++) if (!(prefixMask & (1 << i))) remainingIdx.push(i);
  const remMask = ((1 << n) - 1) ^ prefixMask;
  const inRem = (g) => g !== -1 && (remMask & (1 << g)) !== 0;

  const activeDeps = [];
  for (const d of (constraints && constraints.dependencies) || []) {
    if (inRem(indexOfScene(scenes, d.before)) && inRem(indexOfScene(scenes, d.after))) {
      activeDeps.push(d);
    }
  }
  const activeFixed = [];
  for (const f of (constraints && constraints.fixedPositions) || []) {
    if (inRem(indexOfScene(scenes, f.sceneId))) activeFixed.push(f);
  }
  const activeNoAdj = [];
  for (const f of (constraints && constraints.forbiddenAdjacencies) || []) {
    if (inRem(indexOfScene(scenes, f.a)) && inRem(indexOfScene(scenes, f.b))) {
      activeNoAdj.push(f);
    }
  }
  return { remainingIdx, remMask, activeDeps, activeFixed, activeNoAdj };
}

/**
 * 经典模式后缀 DP：全部剩余场景必须排入。
 * startCost[j] = 从当前实际道具到首个剩余场景 j 的代价（= |stageProps △ props[j]|）。
 * 固定序位按绝对位次检查（绝对位 = k + k0）。
 * 约束以参数形式给出，便于冲突分析时逐个剔除。
 * 返回 { cost, orderIdx } 或 null。orderIdx 使用全局场景下标。
 */
function solveClassicSuffix(scenes, model, suffix, stageProps, deps, fixed, noAdj, boundaryBadMask,
                           opLimit = Infinity) {
  const n = scenes.length;
  const k0 = n - suffix.remainingIdx.length; // 前缀长度 = 首个剩余场景的绝对序位（0 起）

  const local = suffix.remainingIdx;
  const m = local.length;
  if (m === 0) return { cost: 0, orderIdx: [] };
  const localOf = new Array(n).fill(-1);
  local.forEach((g, li) => { localOf[g] = li; });

  const prereqLocal = new Array(m).fill(0);
  for (const d of deps) {
    const a = localOf[indexOfScene(scenes, d.before)];
    const b = localOf[indexOfScene(scenes, d.after)];
    if (a === -1 || b === -1) continue;
    prereqLocal[b] |= (1 << a);
  }

  // 固定序位（按绝对位次）
  const fixedMaskLocal = new Array(m).fill(0);
  for (const f of fixed) {
    const g = localOf[indexOfScene(scenes, f.sceneId)];
    if (g === -1) continue;
    const p = Number(f.position) - 1;
    if (p < k0 || p >= n) continue; // 前缀位次在进入前已校验
    fixedMaskLocal[g] |= (1 << (p - k0));
  }
  const fixedAt = (g, relPos) => {
    const fm = fixedMaskLocal[g];
    return fm === 0 || fm === (1 << relPos);
  };

  const badLocal = Array.from({ length: m }, () => new Array(m).fill(false));
  for (const f of noAdj) {
    const a = localOf[indexOfScene(scenes, f.a)];
    const b = localOf[indexOfScene(scenes, f.b)];
    if (a === -1 || b === -1) continue;
    badLocal[a][b] = badLocal[b][a] = true;
  }

  const startCost = local.map(g => symDiffSize(stageProps, model.propSets[g]));
  const full = (1 << m) - 1;
  const dp = new Array(1 << m);
  const parent = new Array(1 << m);
  const ensure = (x) => {
    if (!dp[x]) {
      dp[x] = new Float64Array(m).fill(Infinity);
      parent[x] = new Int8Array(m).fill(-1);
    }
  };

  for (let g = 0; g < m; g++) {
    if (prereqLocal[g] !== 0) continue;
    if (!fixedAt(g, 0)) continue;
    // 与前缀最后一个已完成场景的禁止相邻（边界冲突）
    const gg = local[g];
    if (boundaryBadMask & (1 << gg)) continue;
    if (startCost[g] > opLimit) continue; // 从当前实际道具切入的首段超出上限
    ensure(1 << g);
    dp[1 << g][g] = startCost[g];
  }

  for (let mask = 1; mask <= full; mask++) {
    const row = dp[mask];
    if (!row) continue;
    const relPos = popcount(mask);
    if (relPos >= m) continue;
    for (let last = 0; last < m; last++) {
      const cur = row[last];
      if (cur === Infinity) continue;
      for (let g = 0; g < m; g++) {
        const bit = 1 << g;
        if (mask & bit) continue;
        if ((prereqLocal[g] & ~mask) !== 0) continue;
        if (!fixedAt(g, relPos)) continue;
        if (badLocal[last][g]) continue;
        if (model.cost[local[last]][local[g]] > opLimit) continue; // 本次换景超出单段上限
        const nm = mask | bit;
        const nc = cur + model.cost[local[last]][local[g]];
        ensure(nm);
        if (nc < dp[nm][g]) {
          dp[nm][g] = nc;
          parent[nm][g] = last;
        }
      }
    }
  }

  const fullRow = dp[full];
  if (!fullRow) return null;
  let best = Infinity, bestLast = -1;
  for (let g = 0; g < m; g++) {
    if (fullRow[g] < best) { best = fullRow[g]; bestLast = g; }
  }
  if (bestLast === -1) return null;

  const localOrder = [];
  let mask = full, last = bestLast;
  while (true) {
    localOrder.push(last);
    const p = parent[mask][last];
    if (p === -1) break;
    mask ^= (1 << last);
    last = p;
  }
  localOrder.reverse();
  return { cost: best, orderIdx: localOrder.map(li => local[li]) };
}

/**
 * 时长受限模式后缀 DP：从剩余场景中选择含全部"剩余必演"的子集。
 *  - 固定序位按"前缀 + 入选后缀"的整场绝对位次计算（绝对位 = k0 + 后缀内位置）；
 *  - 价值/时长只统计新入选的后缀场景（前缀部分由调用方累加）；
 *  - 首个场景代价由当前实际道具计算（startCost）。
 * 返回 { cost, orderIdx, value, usedDuration, mask } 或 null。
 * mask 为全局场景位掩码（仅后缀位置位）。
 */
function solveTimedSuffix(scenes, model, suffix, stageProps, timeBudget,
                         deps, fixed, noAdj, boundaryBadMask, opLimit = Infinity) {
  const n = scenes.length;
  const { requiredMask } = model;
  const k0 = n - suffix.remainingIdx.length;
  const local = suffix.remainingIdx;
  const m = local.length;
  const localOf = new Array(n).fill(-1);
  local.forEach((g, li) => { localOf[g] = li; });

  const remReqLocal = local
    .map((g, li) => ((requiredMask & (1 << g)) ? li : -1))
    .filter(x => x !== -1);
  const reqLocalMask = remReqLocal.reduce((acc, li) => acc | (1 << li), 0);

  // 后缀内依赖（prereqLocal），及"必须排在其后"集合（用于末尾归纳，仅后缀范围）
  const prereqLocal = new Array(m).fill(0);
  for (const d of deps) {
    const a = localOf[indexOfScene(scenes, d.before)];
    const b = localOf[indexOfScene(scenes, d.after)];
    if (a === -1 || b === -1) continue;
    prereqLocal[b] |= (1 << a);
  }
  const succLocal = new Array(m).fill(0);
  for (let b = 0; b < m; b++) {
    let mm = prereqLocal[b];
    while (mm) {
      const bit = mm & -mm;
      const a = 31 - Math.clz32(bit);
      succLocal[a] |= (1 << b);
      mm ^= bit;
    }
  }

  const fixedMaskLocal = new Array(m).fill(0);
  let bannedLocal = 0; // 被固定到前缀位次（绝对位 < k0）的剩余场景：不可入选
  for (const f of fixed) {
    const g = localOf[indexOfScene(scenes, f.sceneId)];
    if (g === -1) continue;
    const p = Number(f.position) - 1;
    if (p < k0 || p >= n) {
      if (p < k0) bannedLocal |= (1 << g);
      continue;
    }
    fixedMaskLocal[g] |= (1 << (p - k0));
  }
  const fixedAt = (g, relPos) => {
    const fm = fixedMaskLocal[g];
    return fm === 0 || fm === (1 << relPos);
  };

  const badLocal = Array.from({ length: m }, () => new Array(m).fill(false));
  for (const f of noAdj) {
    const a = localOf[indexOfScene(scenes, f.a)];
    const b = localOf[indexOfScene(scenes, f.b)];
    if (a === -1 || b === -1) continue;
    badLocal[a][b] = badLocal[b][a] = true;
  }

  const durLocal = local.map(g => model.durations[g]);
  const valLocal = local.map(g => model.values[g]);
  const durSum = new Float64Array(1 << m);
  const valSum = new Float64Array(1 << m);
  for (let x = 1; x <= (1 << m) - 1; x++) {
    const bit = x & -x;
    const li = 31 - Math.clz32(bit);
    const px = x ^ bit;
    durSum[x] = durSum[px] + durLocal[li];
    valSum[x] = valSum[px] + valLocal[li];
  }

  const startCost = local.map(g => symDiffSize(stageProps, model.propSets[g]));
  const full = (1 << m) - 1;
  const dp = new Array(1 << m);
  const parent = new Array(1 << m);
  const ensure = (x) => {
    if (!dp[x]) {
      dp[x] = new Float64Array(m).fill(Infinity);
      parent[x] = new Int8Array(m).fill(-1);
    }
  };

  for (let g = 0; g < m; g++) {
    if (bannedLocal & (1 << g)) continue;
    if (!fixedAt(g, 0)) continue;
    if (boundaryBadMask & (1 << local[g])) continue;
    if (startCost[g] > opLimit) continue; // 从当前实际道具切入的首段超出上限
    ensure(1 << g);
    dp[1 << g][g] = startCost[g];
  }

  for (let mask = 1; mask <= full; mask++) {
    const row = dp[mask];
    if (!row) continue;
    const relPos = popcount(mask);
    for (let last = 0; last < m; last++) {
      const bit = 1 << last;
      if (mask & bit) continue;
      if (bannedLocal & bit) continue;
      const nm = mask | bit;
      if (!fixedAt(last, relPos)) continue;
      if (succLocal[last] & mask) continue;
      let best = Infinity, bestPrev = -1;
      for (let prev = 0; prev < m; prev++) {
        const v = row[prev];
        if (v === Infinity) continue;
        if (badLocal[prev][last]) continue;
        if (model.cost[local[prev]][local[last]] > opLimit) continue; // 本次换景超出单段上限
        const nc = v + model.cost[local[prev]][local[last]];
        if (nc < best) { best = nc; bestPrev = prev; }
      }
      if (bestPrev !== -1) {
        ensure(nm);
        if (best < dp[nm][last]) {
          dp[nm][last] = best;
          parent[nm][last] = bestPrev;
        }
      }
    }
  }

  // 无剩余必演时，空后缀是保底解
  let best = reqLocalMask === 0
    ? { cost: 0, localOrder: [], value: 0, usedDuration: 0, mask: 0, last: -1 }
    : null;

  for (let mask = 0; mask <= full; mask++) {
    if ((mask & reqLocalMask) !== reqLocalMask) continue;
    if (durSum[mask] > timeBudget) continue;
    const row = dp[mask];
    if (!row) continue;
    let last = -1, c = Infinity;
    for (let g = 0; g < m; g++) {
      if (row[g] < c) { c = row[g]; last = g; }
    }
    if (last === -1) continue;
    const value = valSum[mask];
    const take = !best
      || value > best.value
      || (value === best.value && c < best.cost);
    if (take) {
      const localOrder = [];
      let x = mask, lg = last;
      while (lg !== -1) {
        localOrder.push(lg);
        const pv = parent[x][lg];
        x ^= (1 << lg);
        lg = pv;
      }
      localOrder.reverse();
      best = { cost: c, localOrder, value, usedDuration: durSum[mask], mask, last };
    }
  }
  if (!best) return null;

  return {
    cost: best.cost,
    orderIdx: best.localOrder.map(li => local[li]),
    value: best.value,
    usedDuration: best.usedDuration,
    mask: best.mask,
  };
}

/**
 * 后缀结构可行性（用于 timed 无解归因）：
 * 剩余必演必须全部排入，剩余可选可充当缓冲；不受时长限制。
 *  - 剩余必演的前置只要"在剩余必演中"的已排入即可（前缀前置按事实满足；
 *    剩余可选前置在该可选被使用时由其自身后继约束保证）；
 *  - 剩余可选必须在它先导的剩余必演之前；
 *  - 固定序位按绝对位次；
 *  - 边界禁止相邻由 boundaryBadMask 给出。
 */
function suffixStructuralFeasible(scenes, model, suffix, deps, fixed, noAdj, boundaryBadMask) {
  const n = scenes.length;
  const { requiredMask } = model;
  const k0 = n - suffix.remainingIdx.length;
  const local = suffix.remainingIdx;
  const m = local.length;
  const localOf = new Array(n).fill(-1);
  local.forEach((g, li) => { localOf[g] = li; });

  const isReqLocal = new Array(m).fill(false);
  let reqMaskLocal = 0;
  local.forEach((g, li) => {
    if (requiredMask & (1 << g)) { isReqLocal[li] = true; reqMaskLocal |= (1 << li); }
  });
  if (reqMaskLocal === 0) return true;

  const prereqLocal = new Array(m).fill(0);
  const succReqLocal = new Array(m).fill(0);
  for (const d of deps) {
    const a = localOf[indexOfScene(scenes, d.before)];
    const b = localOf[indexOfScene(scenes, d.after)];
    if (a === -1 || b === -1) continue;
    prereqLocal[b] |= (1 << a);
    if (isReqLocal[b]) succReqLocal[a] |= (1 << b);
  }

  const fixedMaskLocal = new Array(m).fill(0);
  let bannedLocal = 0; // 固定到前缀位次的剩余场景：既不能入选，也不能充当缓冲
  const localAtPos = new Array(n).fill(-1); // 只登记"必演场景"占住的序位
  for (const f of fixed) {
    const g = localOf[indexOfScene(scenes, f.sceneId)];
    if (g === -1) continue;
    const p = Number(f.position) - 1;
    if (p < k0 || p >= n) {
      if (p < k0) bannedLocal |= (1 << g);
      continue;
    }
    fixedMaskLocal[g] |= (1 << (p - k0));
    if (isReqLocal[g]) localAtPos[p - k0] = g;
  }
  const fixedAt = (g, relPos) => {
    const fm = fixedMaskLocal[g];
    return fm === 0 || fm === (1 << relPos);
  };

  const badLocal = Array.from({ length: m }, () => new Array(m).fill(false));
  for (const f of noAdj) {
    const a = localOf[indexOfScene(scenes, f.a)];
    const b = localOf[indexOfScene(scenes, f.b)];
    if (a === -1 || b === -1) continue;
    badLocal[a][b] = badLocal[b][a] = true;
  }

  // 被固定到前缀位次的必演场景绝无可能排入 → 直接不可行（通常在 findPrefixConflicts 已拦）
  if (bannedLocal & reqMaskLocal) return false;

  const dp = new Array(1 << m);
  const ensure = (x) => { if (!dp[x]) dp[x] = new Uint8Array(m); };

  for (let g = 0; g < m; g++) {
    if (bannedLocal & (1 << g)) continue;
    if (isReqLocal[g] && (prereqLocal[g] & reqMaskLocal) !== 0) continue;
    if (!isReqLocal[g] && prereqLocal[g] !== 0) continue;
    if (!fixedAt(g, 0)) continue;
    if (boundaryBadMask & (1 << local[g])) continue;
    ensure(1 << g);
    dp[1 << g][g] = 1;
  }

  const full = (1 << m) - 1;
  for (let mask = 1; mask <= full; mask++) {
    const row = dp[mask];
    if (!row) continue;
    if ((mask & reqMaskLocal) === reqMaskLocal) return true;
    const relPos = popcount(mask);
    for (let last = 0; last < m; last++) {
      if (!row[last]) continue;
      for (let g = 0; g < m; g++) {
        const bit = 1 << g;
        if (mask & bit) continue;
        if (bannedLocal & bit) continue;
        if (!fixedAt(g, relPos)) continue;
        if (isReqLocal[g]) {
          if ((prereqLocal[g] & reqMaskLocal & ~mask) !== 0) continue;
          if (localAtPos[relPos] !== -1 && localAtPos[relPos] !== g) continue;
        } else {
          if ((prereqLocal[g] & ~mask) !== 0) continue;
          if ((succReqLocal[g] & mask) !== 0) continue;
          if (localAtPos[relPos] !== -1) continue;
        }
        if (badLocal[last][g]) continue;
        const nm = mask | bit;
        ensure(nm);
        dp[nm][g] = 1;
      }
    }
  }
  return false;
}

/** 把约束条目分为三类（条目引用都在剩余场景内，跨边界依赖已被排除）。 */
function classifyActive(items, suffix, scenes) {
  const deps = [], fixed = [], noAdj = [];
  for (const it of items) {
    if (it.kind === 'dependency') deps.push(it.data);
    else if (it.kind === 'fixedPosition') fixed.push(it.data);
    else noAdj.push(it.data);
  }
  return { deps, fixed, noAdj };
}

/** 经典模式后缀无解时的冲突分析：跨前缀硬冲突优先，否则贪心极小化活动约束核心。 */
function analyzeClassicSuffix(scenes, model, constraints, suffix, prefixIdx, boundaryBadMask) {
  // 跨前缀依赖：after 已完成、before 在剩余 —— 在 findPrefixConflicts 已报，
  // 能走到这里说明没有此类冲突；这里只需处理后缀内/边界问题。

  // 剩余场景之间的依赖环（含跨前缀反向边不可能成环：前缀节点无出边到剩余）
  const remScenes = suffix.remainingIdx.map(g => scenes[g]);
  const cycle = findDepCycle(remScenes, suffix.activeDeps);
  if (cycle) {
    return {
      type: 'dependency-cycle',
      message: '剩余场景的依赖关系存在循环，无法在不改变已完成顺序的前提下重排：',
      constraints: cycle.map(d => describeConstraint(scenes, 'dependency', d)),
    };
  }

  const all = [];
  for (const d of suffix.activeDeps) all.push({ kind: 'dependency', data: d });
  for (const f of suffix.activeFixed) all.push({ kind: 'fixedPosition', data: f });
  for (const f of suffix.activeNoAdj) all.push({ kind: 'forbiddenAdjacency', data: f });

  // 与前缀末场景的边界禁止相邻：作为可参与极小化的特殊条目
  let boundaryItems = [];
  if (prefixIdx.length > 0) {
    const lastG = prefixIdx[prefixIdx.length - 1];
    for (const f of (constraints && constraints.forbiddenAdjacencies) || []) {
      const a = indexOfScene(scenes, f.a);
      const b = indexOfScene(scenes, f.b);
      if (a === -1 || b === -1) continue;
      const other = a === lastG ? b : (b === lastG ? a : -1);
      if (other !== -1 && (suffix.remMask & (1 << other))) {
        boundaryItems.push({ kind: 'boundary-adjacency', data: f });
      }
    }
  }

  const satisfiable = (items) => {
    const { deps, fixed, noAdj } = classifyActive(items, suffix, scenes);
    let bbMask = 0;
    for (const it of items) {
      if (it.kind !== 'boundary-adjacency') continue;
      const f = it.data;
      bbMask |= (1 << indexOfScene(scenes, f.a)) | (1 << indexOfScene(scenes, f.b));
    }
    return solveClassicSuffix(scenes, model, suffix, new Set(), deps, fixed, noAdj, bbMask) !== null;
  };

  const coreAll = all.concat(boundaryItems);
  let core = coreAll.slice();
  for (const item of coreAll) {
    if (core.length <= 1) break;
    const trial = core.filter(x => x !== item);
    if (!satisfiable(trial)) core = trial;
  }

  return {
    type: 'constraint-set',
    message: '在不改变已完成顺序的前提下，以下约束组合导致剩余场景无法重排（移除其中任意一条即可恢复有解）：',
    constraints: core.map(it => it.kind === 'boundary-adjacency'
      ? describeConstraint(scenes, 'forbiddenAdjacency', it.data)
      : describeConstraint(scenes, it.kind, it.data)),
  };
}

/** 时长受限模式后缀无解归因。 */
function analyzeTimedSuffix(scenes, model, constraints, suffix, prefixIdx, prefixDuration,
                           timeLimit, timeBudget, boundaryBadMask) {
  const remReq = suffix.remainingIdx.filter(g => model.requiredMask & (1 << g));

  // 1. 剩余必演间的依赖环
  const remReqScenes = remReq.map(g => scenes[g]);
  const remReqIds = new Set(remReqScenes.map(s => s.id));
  const cycle = findDepCycle(remReqScenes,
    suffix.activeDeps.filter(d => remReqIds.has(d.before) && remReqIds.has(d.after)));
  if (cycle) {
    return {
      type: 'dependency-cycle',
      message: '剩余必演场景之间的依赖关系存在循环，舍弃可选场景也无法解除：',
      constraints: cycle.map(d => describeConstraint(scenes, 'dependency', d)),
    };
  }

  // 2. 剩余必演固定到同一绝对序位
  const fixedReq = suffix.activeFixed.filter(f => remReqIds.has(f.sceneId));
  const byPos = new Map();
  for (const f of fixedReq) {
    if (!byPos.has(f.position)) byPos.set(f.position, []);
    byPos.get(f.position).push(f);
  }
  for (const arr of byPos.values()) {
    if (arr.length >= 2) {
      return {
        type: 'constraint-set',
        message: '以下剩余必演场景被固定在同一序位，互相冲突：',
        constraints: arr.slice(0, 2).map(f => describeConstraint(scenes, 'fixedPosition', f)),
      };
    }
  }

  // 3. 结构可行性（可选场景可缓冲、不限时长）
  const feasibleNoTime = (deps, fixed, noAdj, bbMask) =>
    suffixStructuralFeasible(scenes, model, suffix, deps, fixed, noAdj, bbMask);

  if (!feasibleNoTime(suffix.activeDeps, fixedReq, suffix.activeNoAdj, boundaryBadMask)) {
    const all = [];
    for (const d of suffix.activeDeps) all.push({ kind: 'dependency', data: d });
    for (const f of fixedReq) all.push({ kind: 'fixedPosition', data: f });
    for (const f of suffix.activeNoAdj) all.push({ kind: 'forbiddenAdjacency', data: f });
    if (prefixIdx.length > 0) {
      const lastG = prefixIdx[prefixIdx.length - 1];
      for (const f of (constraints && constraints.forbiddenAdjacencies) || []) {
        const a = indexOfScene(scenes, f.a), b = indexOfScene(scenes, f.b);
        const other = a === lastG ? b : (b === lastG ? a : -1);
        if (other !== -1 && (suffix.remMask & (1 << other))) {
          all.push({ kind: 'boundary-adjacency', data: f });
        }
      }
    }
    let core = all.slice();
    for (const item of all) {
      if (core.length <= 1) break;
      const trial = core.filter(x => x !== item);
      const { deps, fixed, noAdj } = classifyActive(trial, suffix, scenes);
      let bbMask = 0;
      for (const it of trial) {
        if (it.kind !== 'boundary-adjacency') continue;
        bbMask |= (1 << indexOfScene(scenes, it.data.a)) | (1 << indexOfScene(scenes, it.data.b));
      }
      if (!feasibleNoTime(deps, fixed, noAdj, bbMask)) core = trial;
    }
    return {
      type: 'constraint-set',
      message: '剩余必演场景的以下约束组合相互冲突（取舍可选场景、提高时长上限均无法解除）：',
      constraints: core.map(it => it.kind === 'boundary-adjacency'
        ? describeConstraint(scenes, 'forbiddenAdjacency', it.data)
        : describeConstraint(scenes, it.kind, it.data)),
    };
  }

  // 4. 结构可行但剩余时长不足
  return {
    type: 'timed-infeasible',
    message: `已完成前缀占用 ${prefixDuration} 分钟，剩余时长只有 ${timeBudget} 分钟：`
      + '剩余必演项之间的约束可能需要插入额外可选场景作为缓冲，而剩余时长不足以容纳。'
      + '请提高整场时长上限、调整必演项或放宽约束。',
    constraints: [],
  };
}

/** 生成重排结果的步骤明细：前缀标 done，首个后缀场景由当前实际道具切入。 */
function buildReplanSteps(model, scenes, prefixIdx, suffixIdx, stageProps) {
  const steps = [];
  prefixIdx.forEach((g, k) => {
    if (k === 0) {
      const added = [...model.propSets[g]];
      steps.push({
        type: 'setup', phase: 'done', scene: scenes[g].id,
        added, removed: [], count: added.length,
      });
    } else {
      const a = prefixIdx[k - 1], b = g;
      const removed = [...model.propSets[a]].filter(p => !model.propSets[b].has(p));
      const added = [...model.propSets[b]].filter(p => !model.propSets[a].has(p));
      steps.push({
        type: 'transition', phase: 'done', from: scenes[a].id, to: scenes[b].id,
        removed, added, count: removed.length + added.length,
      });
    }
  });

  if (suffixIdx.length > 0) {
    const first = suffixIdx[0];
    const removed = [...stageProps].filter(p => !model.propSets[first].has(p));
    const added = [...model.propSets[first]].filter(p => !stageProps.has(p));
    steps.push({
      type: 'transition', phase: 'suffix', fromStage: true,
      from: prefixIdx.length ? scenes[prefixIdx[prefixIdx.length - 1]].id : null,
      to: scenes[first].id,
      removed, added, count: removed.length + added.length,
    });
    for (let k = 1; k < suffixIdx.length; k++) {
      const a = suffixIdx[k - 1], b = suffixIdx[k];
      const rem = [...model.propSets[a]].filter(p => !model.propSets[b].has(p));
      const add = [...model.propSets[b]].filter(p => !model.propSets[a].has(p));
      steps.push({
        type: 'transition', phase: 'suffix', from: scenes[a].id, to: scenes[b].id,
        removed: rem, added: add, count: rem.length + add.length,
      });
    }
  }
  return steps;
}

/**
 * 演出中重排入口。
 * @param {object} options.replan { prefixIds: string[], stageProps: string[],
 *                                  originalOrder?: string[] }
 * @returns 见模块顶部说明；前缀冲突返回 { ok:false, conflict:{ type:'prefix-conflict', conflicts: [...] } }
 */
function replan(scenes, constraints, options = {}) {
  const model = buildModel(scenes, constraints);
  const rp = options.replan || {};
  const prefixIds = Array.isArray(rp.prefixIds) ? rp.prefixIds.map(String) : [];
  const stageProps = new Set(normalizeProps(rp.stageProps));
  const opLimit = normOpLimit(options.opLimit);
  const opLimitOut = opLimit === Infinity ? null : opLimit;

  // 解析前缀：必须是存在的场景且无重复，按给定顺序
  const prefixIdx = [];
  const prefixSeen = new Set();
  for (const id of prefixIds) {
    const g = indexOfScene(scenes, id);
    if (g === -1) {
      return {
        ok: false,
        conflict: {
          type: 'invalid-prefix',
          message: `已完成前缀引用了不存在的场景：${id}`,
          constraints: [],
        },
      };
    }
    if (prefixSeen.has(id)) {
      return {
        ok: false,
        conflict: {
          type: 'invalid-prefix',
          message: `已完成前缀中场景重复：${scenes[g].name}`,
          constraints: [],
        },
      };
    }
    prefixSeen.add(id);
    prefixIdx.push(g);
  }
  const prefixMask = prefixIdx.reduce((acc, g) => acc | (1 << g), 0);

  const timed = options.mode === 'timed';
  const timeLimit = Number(options.timeLimit) || 0;

  // 1. 前缀合法性（跨前缀依赖按完成事实校验、固定序位按绝对位次）
  const prefixConflicts = findPrefixConflicts(scenes, model, constraints || {}, prefixIdx, timed);
  if (prefixConflicts.length) {
    return {
      ok: false,
      conflict: {
        type: 'prefix-conflict',
        message: '已完成前缀与约束冲突，无法在此基础上重排：',
        conflicts: prefixConflicts,
        constraints: [],
      },
    };
  }

  // 前缀时长 / 价值
  let prefixDuration = 0, prefixValue = 0, prefixCost = 0;
  prefixIdx.forEach((g, k) => {
    if (timed) {
      prefixDuration += model.durations[g];
      prefixValue += model.values[g];
    }
    prefixCost += k === 0
      ? model.setupCost[g]
      : model.cost[prefixIdx[k - 1]][g];
  });

  if (timed && prefixDuration > timeLimit) {
    return {
      ok: false,
      conflict: {
        type: 'prefix-overtime',
        message: `已完成场景总时长 ${prefixDuration} 分钟，已超过整场时长上限 ${timeLimit} 分钟，无法继续编排。`,
        prefixDuration,
        timeLimit,
        constraints: [],
      },
    };
  }

  const suffix = buildSuffixContext(scenes, model, constraints || {}, prefixIdx, prefixMask);

  // 与前缀末场景的边界禁止相邻
  let boundaryBadMask = 0;
  if (prefixIdx.length > 0) {
    const lastG = prefixIdx[prefixIdx.length - 1];
    for (const f of (constraints && constraints.forbiddenAdjacencies) || []) {
      const a = indexOfScene(scenes, f.a);
      const b = indexOfScene(scenes, f.b);
      if (a === -1 || b === -1) continue;
      const other = a === lastG ? b : (b === lastG ? a : -1);
      if (other !== -1 && (suffix.remMask & (1 << other))) {
        boundaryBadMask |= (1 << other);
      }
    }
  }

  // 原计划参照信息
  const origOrder = Array.isArray(rp.originalOrder)
    ? rp.originalOrder.map(String).map(id => indexOfScene(scenes, id)).filter(g => g !== -1)
    : [];
  const origTotalCost = origOrder.length
    ? origOrder.reduce((acc, g, k) => acc + (k === 0 ? model.setupCost[g] : model.cost[origOrder[k - 1]][g]), 0)
    : null;
  let origTailCost = null;
  if (origOrder.length >= prefixIdx.length) {
    origTailCost = 0;
    const cut = prefixIdx.length;
    if (cut > 0 && cut < origOrder.length) {
      origTailCost += model.cost[origOrder[cut - 1]][origOrder[cut]];
      for (let k = cut + 1; k < origOrder.length; k++) {
        origTailCost += model.cost[origOrder[k - 1]][origOrder[k]];
      }
    } else if (cut === 0 && origOrder.length > 0) {
      // 空前缀：原"后缀"即原整场（含开场布置）
      origTailCost += model.setupCost[origOrder[0]];
      for (let k = 1; k < origOrder.length; k++) {
        origTailCost += model.cost[origOrder[k - 1]][origOrder[k]];
      }
    }
  }

  if (!timed) {
    const res = solveClassicSuffix(scenes, model, suffix, stageProps,
      suffix.activeDeps, suffix.activeFixed, suffix.activeNoAdj, boundaryBadMask, opLimit);
    if (!res) {
      if (opLimit !== Infinity) {
        const resNoCap = solveClassicSuffix(scenes, model, suffix, stageProps,
          suffix.activeDeps, suffix.activeFixed, suffix.activeNoAdj, boundaryBadMask);
        if (resNoCap) {
          const hi = suffixMaxEdge(model, suffix, stageProps);
          const minCap = minCapByBinarySearch(hi, l => solveClassicSuffix(scenes, model, suffix, stageProps,
            suffix.activeDeps, suffix.activeFixed, suffix.activeNoAdj, boundaryBadMask, l) !== null);
          return { ok: false, conflict: buildPropLimitConflict(opLimit, minCap, false, true) };
        }
      }
      return { ok: false, conflict: analyzeClassicSuffix(scenes, model, constraints || {}, suffix, prefixIdx, boundaryBadMask) };
    }
    const suffixIdx = res.orderIdx;
    const suffixCost = res.cost;
    const newTotalCost = prefixCost + suffixCost;
    const steps = buildReplanSteps(model, scenes, prefixIdx, suffixIdx, stageProps);

    const newIdSet = new Set([...prefixIdx, ...suffixIdx].map(g => scenes[g].id));
    const addedScenes = [];
    const droppedScenes = [];

    return {
      ok: true,
      mode: 'classic',
      replanned: true,
      order: [...prefixIdx, ...suffixIdx].map(g => scenes[g].id),
      originalOrder: origOrder.map(g => scenes[g].id),
      prefixIds: prefixIdx.map(g => scenes[g].id),
      suffixIds: suffixIdx.map(g => scenes[g].id),
      stageProps: [...stageProps],
      totalCost: newTotalCost,
      opLimit: opLimitOut,
      prefixCost,
      suffixCost,
      originalTailCost: origTailCost,
      originalTotalCost: origTotalCost,
      costDelta: origTotalCost === null ? null : newTotalCost - origTotalCost,
      droppedScenes,
      addedScenes,
      steps,
    };
  }

  // timed
  const timeBudget = timeLimit - prefixDuration;

  // 剩余必演自身已超剩余时长：给出明确的超时提示（与单段上限无关，优先判定）
  let remRequiredDur = 0;
  for (const g of suffix.remainingIdx) {
    if (model.requiredMask & (1 << g)) remRequiredDur += model.durations[g];
  }
  if (remRequiredDur > timeBudget) {
    return {
      ok: false,
      conflict: {
        type: 'required-overtime',
        message: `剩余必演场景共需 ${remRequiredDur} 分钟，但扣除已完成的 ${prefixDuration} 分钟后仅剩 ${timeBudget} 分钟，无法继续编排。`,
        requiredTotal: prefixDuration + remRequiredDur,
        timeLimit,
        prefixDuration,
        timeBudget,
        constraints: [],
      },
    };
  }

  const res = solveTimedSuffix(scenes, model, suffix, stageProps, timeBudget,
    suffix.activeDeps, suffix.activeFixed, suffix.activeNoAdj, boundaryBadMask, opLimit);
  if (!res) {
    if (opLimit !== Infinity) {
      const resNoCap = solveTimedSuffix(scenes, model, suffix, stageProps, timeBudget,
        suffix.activeDeps, suffix.activeFixed, suffix.activeNoAdj, boundaryBadMask);
      if (resNoCap) {
        const hi = suffixMaxEdge(model, suffix, stageProps);
        const minCap = minCapByBinarySearch(hi, l => solveTimedSuffix(scenes, model, suffix, stageProps, timeBudget,
          suffix.activeDeps, suffix.activeFixed, suffix.activeNoAdj, boundaryBadMask, l) !== null);
        return { ok: false, conflict: buildPropLimitConflict(opLimit, minCap, true, true) };
      }
    }
    return {
      ok: false,
      conflict: analyzeTimedSuffix(scenes, model, constraints || {}, suffix, prefixIdx,
        prefixDuration, timeLimit, timeBudget, boundaryBadMask),
    };
  }

  const suffixIdx = res.orderIdx;
  const suffixCost = res.cost;
  const newTotalCost = prefixCost + suffixCost;
  const totalValue = prefixValue + res.value;
  const usedDuration = prefixDuration + res.usedDuration;
  const steps = buildReplanSteps(model, scenes, prefixIdx, suffixIdx, stageProps);

  const selectedIds = [...prefixIdx, ...suffixIdx].map(g => scenes[g].id);
  const selectedSet = new Set(selectedIds);
  const excludedIds = scenes.map(s => s.id).filter(id => !selectedSet.has(id));

  const origIdSet = new Set(origOrder.map(g => scenes[g].id));
  const droppedScenes = origOrder.map(g => scenes[g].id).filter(id => !selectedSet.has(id));
  const addedScenes = selectedIds.filter(id => !origIdSet.has(id));
  let originalTotalValue = null;
  if (origOrder.length) {
    originalTotalValue = origOrder.reduce((acc, g) => acc + model.values[g], 0);
  }

  return {
    ok: true,
    mode: 'timed',
    replanned: true,
    order: selectedIds,
    originalOrder: origOrder.map(g => scenes[g].id),
    prefixIds: prefixIdx.map(g => scenes[g].id),
    suffixIds: suffixIdx.map(g => scenes[g].id),
    stageProps: [...stageProps],
    selectedIds,
    excludedIds,
    totalCost: newTotalCost,
    opLimit: opLimitOut,
    totalValue,
    prefixValue,
    suffixValue: res.value,
    usedDuration,
    remainingDuration: timeLimit - usedDuration,
    timeLimit,
    prefixDuration,
    suffixDuration: res.usedDuration,
    timeBudget,
    prefixCost,
    suffixCost,
    originalTailCost: origTailCost,
    originalTotalCost: origTotalCost,
    originalTotalValue,
    costDelta: origTotalCost === null ? null : newTotalCost - origTotalCost,
    valueDelta: originalTotalValue === null ? null : totalValue - originalTotalValue,
    droppedScenes,
    addedScenes,
    steps,
  };
}

/** 根据入选顺序生成开场布置与换景明细。 */
function buildSteps(model, scenes, orderIdx) {
  const steps = [];
  if (orderIdx.length === 0) return steps;
  const first = orderIdx[0];
  const firstProps = [...model.propSets[first]];
  steps.push({
    type: 'setup',
    scene: scenes[first].id,
    added: firstProps,
    removed: [],
    count: firstProps.length,
  });
  for (let k = 1; k < orderIdx.length; k++) {
    const a = orderIdx[k - 1];
    const b = orderIdx[k];
    const removed = [...model.propSets[a]].filter(p => !model.propSets[b].has(p));
    const added = [...model.propSets[b]].filter(p => !model.propSets[a].has(p));
    steps.push({
      type: 'transition',
      from: scenes[a].id,
      to: scenes[b].id,
      removed,
      added,
      count: removed.length + added.length,
    });
  }
  return steps;
}

/**
 * 在 [0, hi] 上二分"可行编排所需的最小单段上限"。
 * 可行性关于上限单调（放宽只会让更多换景边可用）；调用方须保证不限上限时可行。
 * @param {number} hi 任意可行编排中单段操作数的理论最大值
 * @param {(l:number)=>boolean} feasible 给定上限时是否存在可行编排
 * @returns {number} 最小可行上限
 */
function minCapByBinarySearch(hi, feasible) {
  if (feasible(0)) return 0;
  let lo = 1, ans = hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (feasible(mid)) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return ans;
}

/** 主问题（开场布置 + 全部换景）中最大的单段操作数，作为二分上界。 */
function mainMaxEdge(model) {
  let hi = 0;
  const { n, setupCost, cost } = model;
  for (let j = 0; j < n; j++) hi = Math.max(hi, setupCost[j]);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (i !== j) hi = Math.max(hi, cost[i][j]);
  return hi;
}

/** 后缀问题（当前实际道具切入首段 + 后缀内部换景）中最大的单段操作数。 */
function suffixMaxEdge(model, suffix, stageProps) {
  let hi = 0;
  const local = suffix.remainingIdx;
  for (const g of local) hi = Math.max(hi, symDiffSize(stageProps, model.propSets[g]));
  for (const a of local)
    for (const b of local)
      if (a !== b) hi = Math.max(hi, model.cost[a][b]);
  return hi;
}

/**
 * 构造"单段道具操作上限导致无解"的冲突提示。
 * 仅当不限上限时存在可行编排时调用；minCap 为放开到该件数即恢复有解。
 * @param {number} opLimit 当前（导致无解的）上限
 * @param {number|null} minCap 最小可行上限
 * @param {boolean} timed 是否时长受限模式
 * @param {boolean} suffix 是否演出中重排的后缀
 */
function buildPropLimitConflict(opLimit, minCap, timed, suffix) {
  const where = suffix
    ? '已完成前缀不可改变，而剩余部分（含"从当前舞台实际道具"切入的首段及之后的每次换景）中'
    : '在满足全部既有约束的候选编排中';
  let message = `单段道具操作上限 ${opLimit} 件过低：${where}，至少有一段的撤下与上台道具合计超过 ${opLimit} 件，`
    + (timed ? '即使按时长上限取舍场景，' : '')
    + '节目单仍无解。';
  if (minCap !== null) {
    message += ` 将上限放宽到 ${minCap} 件即可恢复有解（求解器仍会在可行候选中按原目标取最优顺序）；`;
  }
  message += '请调高单段道具操作上限，或放宽相关约束、调整相邻场景的道具集合。';
  return {
    type: 'prop-limit-infeasible',
    message,
    opLimit,
    minRequiredLimit: minCap,
    constraints: [],
  };
}

/**
 * 求解入口。
 * @param {object} options { mode?: 'classic'|'timed', timeLimit?: number,
 *   opLimit?: number, alternatives?: number }
 *   opLimit 为可选的单段道具操作上限（正整数；缺省表示不限）。
 *   alternatives 为 1..MAX_ALTERNATIVES 的整数：为 1（或缺省）时完全保持
 *   原有单条响应；>=2 时额外返回 alternatives 数组，含至多该数量条
 *   互不相同、已按规则排序的可行节目单（第 1 条即原有最优解）。
 * @returns 经典有解：{ ok:true, order, totalCost, opLimit, steps }
 *          时长受限有解：{ ok:true, mode:'timed', order, selectedIds, excludedIds,
 *                          totalCost, totalValue, usedDuration, remainingDuration, timeLimit, opLimit, steps }
 *          请求备选时以上字段仍在顶层（描述第 1 条方案），并额外带 alternatives。
 *          无解：{ ok:false, conflict }（时长超限额外带 reason:'required-overtime'；
 *                上限导致无解时 conflict.type 为 'prop-limit-infeasible' 并带 minRequiredLimit）
 */
function solve(scenes, constraints, options = {}) {
  const model = buildModel(scenes, constraints);
  const opLimit = normOpLimit(options.opLimit);
  const opLimitOut = opLimit === Infinity ? null : opLimit;
  const altCount = normAlternatives(options.alternatives);

  if (options.mode !== 'timed') {
    if (altCount > 1) {
      const entries = runDPKBest(model, opLimit, altCount);
      if (!entries.length) {
        if (opLimit !== Infinity && runDP(model) !== null) {
          const minCap = minCapByBinarySearch(mainMaxEdge(model), l => runDP(model, l) !== null);
          return { ok: false, conflict: buildPropLimitConflict(opLimit, minCap, false, false) };
        }
        return { ok: false, conflict: analyzeConflict(scenes, constraints || {}) };
      }
      const alternatives = entries.map(e => ({
        rank: 0,
        order: e.path.map(i => scenes[i].id),
        totalCost: e.cost,
        opLimit: opLimitOut,
        steps: buildSteps(model, scenes, e.path),
      }));
      alternatives.forEach((a, i) => { a.rank = i + 1; });
      return {
        ok: true,
        order: alternatives[0].order,
        totalCost: alternatives[0].totalCost,
        opLimit: opLimitOut,
        steps: alternatives[0].steps,
        alternatives,
      };
    }

    const res = runDP(model, opLimit);
    if (!res) {
      if (opLimit !== Infinity && runDP(model) !== null) {
        const minCap = minCapByBinarySearch(mainMaxEdge(model), l => runDP(model, l) !== null);
        return { ok: false, conflict: buildPropLimitConflict(opLimit, minCap, false, false) };
      }
      return { ok: false, conflict: analyzeConflict(scenes, constraints || {}) };
    }
    return {
      ok: true,
      order: res.orderIdx.map(i => scenes[i].id),
      totalCost: res.cost,
      opLimit: opLimitOut,
      steps: buildSteps(model, scenes, res.orderIdx),
    };
  }

  const timeLimit = Number(options.timeLimit) || 0;

  // 必演场景总时长已超限：直接判定无解
  let requiredTotal = 0;
  for (let i = 0; i < model.n; i++) {
    if (model.requiredMask & (1 << i)) requiredTotal += model.durations[i];
  }
  if (requiredTotal > timeLimit) {
    return {
      ok: false,
      reason: 'required-overtime',
      conflict: {
        type: 'required-overtime',
        message: `必演场景总时长 ${requiredTotal} 分钟，已超过整场时长上限 ${timeLimit} 分钟，无法编排。`,
        requiredTotal,
        timeLimit,
        constraints: [],
      },
    };
  }

  const res = runTimedDP(model, timeLimit, opLimit);

  /** 把一条 timed k-best 路径组装成与单解响应同构的方案对象。 */
  const buildTimedAlternative = (entry, rank) => {
    const selectedIds = entry.path.map(i => scenes[i].id);
    const selectedSet = new Set(selectedIds);
    const excludedIds = scenes.map(s => s.id).filter(id => !selectedSet.has(id));
    return {
      rank,
      order: selectedIds,
      selectedIds,
      excludedIds,
      totalCost: entry.cost,
      opLimit: opLimitOut,
      totalValue: entry.value,
      usedDuration: entry.usedDuration,
      remainingDuration: timeLimit - entry.usedDuration,
      timeLimit,
      steps: buildSteps(model, scenes, entry.path),
    };
  };

  if (altCount > 1) {
    const entries = runTimedDPKBest(model, timeLimit, opLimit, altCount);
    if (!entries.length) {
      if (opLimit !== Infinity && runTimedDP(model, timeLimit) !== null) {
        const minCap = minCapByBinarySearch(mainMaxEdge(model), l => runTimedDP(model, timeLimit, l) !== null);
        return { ok: false, conflict: buildPropLimitConflict(opLimit, minCap, true, false) };
      }
      return { ok: false, conflict: analyzeTimedInfeasible(scenes, constraints || {}, model, timeLimit) };
    }
    const alternatives = entries.map((e, i) => buildTimedAlternative(e, i + 1));
    const first = alternatives[0];
    return {
      ok: true,
      mode: 'timed',
      order: first.order,
      selectedIds: first.selectedIds,
      excludedIds: first.excludedIds,
      totalCost: first.totalCost,
      totalValue: first.totalValue,
      usedDuration: first.usedDuration,
      remainingDuration: first.remainingDuration,
      timeLimit,
      opLimit: opLimitOut,
      steps: first.steps,
      alternatives,
    };
  }

  if (!res) {
    if (opLimit !== Infinity && runTimedDP(model, timeLimit) !== null) {
      const minCap = minCapByBinarySearch(mainMaxEdge(model), l => runTimedDP(model, timeLimit, l) !== null);
      return { ok: false, conflict: buildPropLimitConflict(opLimit, minCap, true, false) };
    }
    return { ok: false, conflict: analyzeTimedInfeasible(scenes, constraints || {}, model, timeLimit) };
  }

  const selectedIds = res.orderIdx.map(i => scenes[i].id);
  const selectedSet = new Set(selectedIds);
  const excludedIds = scenes.map(s => s.id).filter(id => !selectedSet.has(id));

  return {
    ok: true,
    mode: 'timed',
    order: selectedIds,
    selectedIds,
    excludedIds,
    totalCost: res.cost,
    totalValue: res.value,
    usedDuration: res.usedDuration,
    remainingDuration: timeLimit - res.usedDuration,
    timeLimit,
    opLimit: opLimitOut,
    steps: buildSteps(model, scenes, res.orderIdx),
  };
}

module.exports = { solve, replan, MAX_SCENES, MAX_ALTERNATIVES, normalizeProps };

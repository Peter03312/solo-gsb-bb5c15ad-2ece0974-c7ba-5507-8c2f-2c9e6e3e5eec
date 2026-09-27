'use strict';

/**
 * 换景人员排班：为节目单中"待执行"的开场布置与每次换景安排搬运人员。
 *
 * 输入（均由调用方校验）：
 *  - workers：2～4 名工作人员（同一人一次只能处理一件道具，不同人可并行）；
 *  - durations：每件道具单次搬运所需的正整数分钟数（撤下 / 摆上同值）；
 *  - pendingSteps：待执行步骤（phase 不为 'done'），每步含 removed（撤下）
 *    与 added（摆上）两组道具。
 *
 * 规则：
 *  - 每段（开场或一次换景）必须先完成全部撤下，摆上才能开始；
 *  - 撤下与摆上各为一个独立的"同速平行机"阶段：m 个人并行搬运若干件
 *    互不相干的道具，每件占一人连续工作 w 分钟，求最短完工时间；
 *  - 各段按节目单顺序串行（段间是正式演出），全场搬运耗时 = 各段耗时之和。
 *
 * 每阶段任务数 ≤ MAX_TASKS_PER_PHASE（14），超限在校验阶段直接拦截。
 *
 * 算法：P_m || Cmax 的判定问题等价于"容量 T 的箱子能否用至多 m 个装下全部
 * 任务"（同速平行机 ⇔ 一维装箱）。用 O(n·2^n) 的装箱 DP 做可行性判定
 * （dp[mask] = 已开最少箱数、used[mask] = 最后一箱已用容量，(箱数, 已用)
 * 按字典序占优），再在 [max(max w, ⌈Σw/m⌉), Σw] 上二分最短完工时间。
 * n ≤ 14 时一次判定约 23 万次转移，毫秒级完成；重构出的分箱按"箱内最早
 * 任务、箱间最早任务"稳定映射到 1..m 号人员，同输入结果恒定。
 */

const { normalizeProps } = require('./solver');

/** 每阶段（撤下或摆上）最多可排班的任务件数。 */
const MAX_TASKS_PER_PHASE = 14;
/** 工作人员数量范围。 */
const MIN_WORKERS = 2;
const MAX_WORKERS = 4;

/**
 * 校验并规范化排班载荷
 * { workers: string[], durations: { 道具名: 正整数 }, steps: Step[] }。
 * steps 中 phase === 'done' 的（已完成前缀）不参与排班。
 * 返回 { errors, workers, pendingSteps, durations }：
 *  - workers: 去空白、去重后的 2～4 名人员名；
 *  - pendingSteps: [{ type, scene, from, to, fromStage, removed, added }]；
 *  - durations: 仅含待排班道具的正整数工时映射。
 */
function validateSchedule(body) {
  const errors = [];

  // ---- 工作人员 ----
  const rawWorkers = body && body.workers;
  const workers = [];
  if (!Array.isArray(rawWorkers)) {
    errors.push('工作人员必须是 2～4 个姓名组成的数组');
  } else {
    if (rawWorkers.length < MIN_WORKERS || rawWorkers.length > MAX_WORKERS) {
      errors.push(`工作人员需 ${MIN_WORKERS}～${MAX_WORKERS} 名（当前 ${rawWorkers.length} 名）`);
    }
    const seen = new Set();
    for (const w0 of rawWorkers) {
      const w = String(w0 == null ? '' : w0).trim();
      if (!w) { errors.push('工作人员姓名不能为空'); continue; }
      if (seen.has(w)) { errors.push(`工作人员姓名重复：${w}`); continue; }
      seen.add(w);
      workers.push(w);
    }
  }

  // ---- 待执行步骤 ----
  const rawSteps = body && body.steps;
  const pendingSteps = [];
  const allSteps = [];
  if (!Array.isArray(rawSteps)) {
    errors.push('缺少待排班的节目单步骤（steps 必须是数组）');
  } else {
    for (const s0 of rawSteps) {
      if (!s0 || typeof s0 !== 'object') continue;
      const norm = {
        type: s0.type === 'setup' ? 'setup' : 'transition',
        scene: s0.scene != null ? String(s0.scene) : null,
        from: s0.from != null ? String(s0.from) : null,
        to: s0.to != null ? String(s0.to) : null,
        fromStage: !!s0.fromStage,
        removed: normalizeProps(s0.removed),
        added: normalizeProps(s0.added),
      };
      allSteps.push(norm);
      if (s0.phase !== 'done') pendingSteps.push(norm); // 已完成前缀不再排班
    }
    if (pendingSteps.length === 0) {
      errors.push('当前节目单没有待执行的开场或换景步骤（可能已全部完成），无需排班');
    }
  }

  // ---- 每阶段任务上限（阶段 = 某段的"撤下"或"摆上"，二者各自独立排班）----
  pendingSteps.forEach((s, i) => {
    const segDesc = s.type === 'setup'
      ? `开场布置（→「${s.scene || s.to || '?'}」）`
      : s.fromStage
        ? `从当前舞台实际道具切入「${s.to || '?'}」的换景`
        : `换景「${s.from || '?'}」→「${s.to || '?'}」`;
    if (s.removed.length > MAX_TASKS_PER_PHASE) {
      errors.push(`第 ${i + 1} 段（${segDesc}）的撤下阶段有 ${s.removed.length} 项搬运任务，`
        + `超过每阶段 ${MAX_TASKS_PER_PHASE} 项上限，无法排班；请调整节目单或道具集合`);
    }
    if (s.added.length > MAX_TASKS_PER_PHASE) {
      errors.push(`第 ${i + 1} 段（${segDesc}）的摆上阶段有 ${s.added.length} 项搬运任务，`
        + `超过每阶段 ${MAX_TASKS_PER_PHASE} 项上限，无法排班；请调整节目单或道具集合`);
    }
  });

  // ---- 工时 ----
  // 待排班道具按"段顺序、先撤下后摆上、段内顺序"汇总去重，错误提示也按此顺序
  const needed = [];
  const neededSet = new Set();
  for (const s of pendingSteps) {
    for (const p of [...s.removed, ...s.added]) {
      if (!neededSet.has(p)) { neededSet.add(p); needed.push(p); }
    }
  }
  // 已完成（done）步骤里出现的道具允许携带工时（前端透传全部 steps），
  // 只是不强制、也不参与排班；真正"多余"的道具以全部步骤并集为准。
  const knownSet = new Set();
  for (const s of allSteps) {
    for (const p of [...s.removed, ...s.added]) knownSet.add(p);
  }

  const rawDurations = body && body.durations;
  const durations = {};
  if (rawDurations === undefined || rawDurations === null || typeof rawDurations !== 'object'
      || Array.isArray(rawDurations)) {
    errors.push('道具工时配置缺失或格式无效：应为 { 道具名: 正整数分钟 }');
  } else {
    for (const name of needed) {
      const w = Number(rawDurations[name]);
      if (!Number.isFinite(w) || !Number.isInteger(w) || w <= 0) {
        errors.push(`缺少道具「${name}」的单次搬运工时，或其值不是正整数分钟`);
      } else {
        durations[name] = w;
      }
    }
    for (const key of Object.keys(rawDurations)) {
      if (!neededSet.has(String(key)) && !knownSet.has(String(key))) {
        errors.push(`工时配置中包含待排班步骤没有的道具：${key}`);
      }
    }
  }

  return { errors, workers, pendingSteps, durations };
}

/**
 * 容量判定 + 分箱重构：能否用至多 m 个容量 cap 的箱子装下全部任务。
 * 经典 O(n·2^n) 装箱 DP：
 *  - bins[mask]：装下 mask 所需的最少箱数（含一只已打开的当前箱）；
 *  - used[mask]：该方案当前（最后）箱已用容量，箱数相同时已用越少越占优；
 *  - 新任务能放进当前箱就不放新箱（另开新箱只会更差，不影响最优性）。
 * parent 链用于重构：箱数在某条转移上 +1 即表示该任务开启了一只新箱。
 * 返回各箱的任务下标数组（按开箱顺序），不可行返回 null。
 */
function binPack(weights, m, cap) {
  const n = weights.length;
  if (n === 0) return [];
  const size = 1 << n;
  const INF = n + 1;
  const bins = new Int16Array(size).fill(INF);
  const used = new Int32Array(size).fill(0);
  const parent = new Int32Array(size).fill(-1);
  const parentItem = new Int8Array(size).fill(-1);
  bins[0] = 1; // 先打开一只空箱

  for (let mask = 0; mask < size; mask++) {
    if (bins[mask] === INF) continue;
    for (let i = 0; i < n; i++) {
      const bit = 1 << i;
      if (mask & bit) continue;
      const w = weights[i];
      const nm = mask | bit;
      let nb, nu;
      if (used[mask] + w <= cap) {
        // 放入当前箱
        nb = bins[mask];
        nu = used[mask] + w;
      } else if (bins[mask] < m && w <= cap) {
        // 当前箱放不下但还有人（箱）可用：另开一只
        nb = bins[mask] + 1;
        nu = w;
      } else {
        continue;
      }
      // 严格按 (箱数升序, 已用升序) 取优；i 升序遍历 → 同分结果确定
      if (nb < bins[nm] || (nb === bins[nm] && nu < used[nm])) {
        bins[nm] = nb;
        used[nm] = nu;
        parent[nm] = mask;
        parentItem[nm] = i;
      }
    }
  }

  const full = size - 1;
  if (bins[full] === INF || bins[full] > m) return null;

  // 沿 parent 链还原"开箱事件"，正向切分各箱
  const chain = [];
  let mask = full;
  while (mask > 0) {
    const pm = parent[mask];
    chain.push({ item: parentItem[mask], openedNew: bins[mask] !== bins[pm] });
    mask = pm;
  }
  chain.reverse();

  const binList = [];
  let current = [];
  for (const { item, openedNew } of chain) {
    if (openedNew && current.length) { binList.push(current); current = []; }
    current.push(item);
  }
  if (current.length) binList.push(current);
  return binList;
}

/**
 * 求一个阶段（撤下或摆上）的最短完工排班。
 * tasks: [{ prop, minutes }]（顺序即节目单中的稳定顺序）。
 * 返回 { taskCount, makespan, assignments }：
 *  assignments 按 (开始时间, 人员序号, 任务序号) 稳定排序，时间以本阶段
 *  起点为 0；同一人员的任务首尾相接、互不重叠。
 */
function schedulePhase(tasks, workers) {
  const m = workers.length;
  const n = tasks.length;
  if (n === 0) return { taskCount: 0, makespan: 0, assignments: [] };

  const weights = tasks.map(t => t.minutes);
  const sumW = weights.reduce((a, b) => a + b, 0);
  const lower = Math.max(Math.max(...weights), Math.ceil(sumW / m));

  // 二分最短可行容量（即最短完工时间）
  let lo = lower, hi = sumW, best = sumW;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (binPack(weights, m, mid)) { best = mid; hi = mid - 1; }
    else lo = mid + 1;
  }

  // 在最优容量处重构，得到确定的分箱
  let binList = binPack(weights, m, best);
  if (!binList) binList = weights.map((_, i) => [i]); // 理论不可达（best 可行）的防御

  // 箱内任务按下标排序；箱间按箱内最早任务下标排序 → 稳定映射到人员
  binList = binList
    .map(bin => bin.slice().sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);

  const assignments = new Array(n);
  binList.forEach((bin, workerIndex) => {
    let t = 0;
    for (const i of bin) {
      assignments[i] = {
        prop: tasks[i].prop,
        minutes: tasks[i].minutes,
        worker: workers[workerIndex],
        workerIndex,
        _order: i,
        start: t,
        end: t + tasks[i].minutes,
      };
      t += tasks[i].minutes;
    }
  });

  assignments.sort((a, b) =>
    a.start - b.start
    || a.workerIndex - b.workerIndex
    || a._order - b._order);
  for (const a of assignments) delete a._order;

  return { taskCount: n, makespan: best, assignments };
}

/**
 * 对全部待执行步骤排班（入参须先经 validateSchedule 校验）。
 * 每段串行：段内先撤下后摆上，段间按节目单顺序。
 * 返回 { ok, workers, workerCount, segments, totalDuration }。
 */
function scheduleSteps(pendingSteps, workers, durations) {
  const toTasks = (names) => names.map(prop => ({ prop, minutes: durations[prop] }));

  let cursor = 0;
  const segments = pendingSteps.map((s, i) => {
    const remove = schedulePhase(toTasks(s.removed), workers);
    const add = schedulePhase(toTasks(s.added), workers);
    const duration = remove.makespan + add.makespan;
    const seg = {
      index: i + 1,
      type: s.type,
      scene: s.scene,
      from: s.from,
      to: s.to,
      fromStage: s.fromStage,
      taskCount: s.removed.length + s.added.length,
      remove,
      add,
      duration,
      start: cursor,
      end: cursor + duration,
    };
    cursor += duration;
    return seg;
  });

  return {
    ok: true,
    workers: workers.slice(),
    workerCount: workers.length,
    segments,
    totalDuration: cursor,
  };
}

module.exports = {
  validateSchedule,
  scheduleSteps,
  schedulePhase,
  binPack,
  MAX_TASKS_PER_PHASE,
  MIN_WORKERS,
  MAX_WORKERS,
};

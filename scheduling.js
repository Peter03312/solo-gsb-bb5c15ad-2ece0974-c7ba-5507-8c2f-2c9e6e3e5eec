'use strict';

/**
 * 换景人员排班（crew scheduling）
 * ============================================================
 *
 * 在一次求解 / 采用备选 / 演出中重排得到的节目单之后，为其中**待执行**的
 * 开场布置与每次换景步骤安排 2～4 名换景工作人员。用户逐件给出道具的
 * 单次搬运分钟数（正整数）。
 *
 * 每段（开场布置或一次换景）分两个阶段：
 *  1. 撤下（remove）：把上一舞台状态（开场为空舞台；重排首段为当前舞台
 *     实际道具）有、本场景没有的道具撤下；
 *  2. 摆上（add）：把本场景有、上一状态没有的道具摆上台。
 *
 * 规则：
 *  - 每段必须**先完成全部撤下**才能开始摆上（两段之间有闸门 gate）；
 *  - 同一人一次只搬运一件道具（机台串行），不同人可并行（同构并行机）；
 *  - 单件道具一次搬运占用其工时 minutes 分钟，不可中断。
 *
 * 因此单阶段是经典的 P_m||C_max（m 台同构并行机、最小化最大完工时间）：
 * 完工时间只取决于每段两阶段各自的最优 makespan，各段按节目单顺序串行，
 * 所以逐段、逐阶段独立取最优即得全场最短完工时间。
 *
 * 每阶段任务数不超过 14（MAX_PHASE_TASKS），n=14 时 3^n 约 480 万，
 * 数毫秒即可完成。除了最短工时，还要求分工**可执行且稳定**：
 * 重构分配时在全部最优方案中取"人员分配向量字典序最小"的一个
 * （最早的任务尽量分给编号最小的人，同组任务再按道具顺序），
 * 因此重复排班、参数不变时结果逐字节一致，现场可照表执行。
 */

const { normalizeProps } = require('./solver');

/** 换景工作人员人数范围。 */
const MIN_WORKERS = 2;
const MAX_WORKERS = 4;
/** 每段单个阶段（撤下 / 摆上）最多 14 项搬运任务。 */
const MAX_PHASE_TASKS = 14;

function segmentLabel(step, names) {
  const nm = (id) => (id == null ? '' : (names.get(String(id)) || String(id)));
  if (step.type === 'setup') return `开场布置 →「${nm(step.scene)}」`;
  if (step.fromStage) return `从当前舞台实际道具 →「${nm(step.to)}」`;
  return `换景：「${nm(step.from)}」→「${nm(step.to)}」`;
}

/**
 * 校验并规范化排班载荷：
 * { workers?: 2..4, workerNames?: string[], minutes: { 道具名: 正整数 },
 *   scenes?: [{ id, name }]（仅用于段标签）,
 *   steps: [{ type:'setup'|'transition', scene?, from?, to?, fromStage?, removed[], added[] }] }
 *
 * 只做结构与取值校验，steps 即"待执行"步骤（调用方应已剔除 phase==='done'
 * 的已完成前缀段）。返回 { errors, workers, workerNames, steps }。
 */
function validateSchedule(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};

  // 工作人员人数：2～4 的整数
  let workers = Number(b.workers);
  if (!Number.isInteger(workers) || workers < MIN_WORKERS || workers > MAX_WORKERS) {
    errors.push(`换景工作人员人数必须是 ${MIN_WORKERS} 到 ${MAX_WORKERS} 之间的整数`);
    workers = Math.min(MAX_WORKERS, Math.max(MIN_WORKERS, workers || MIN_WORKERS));
  }

  // 工作人员姓名（可选）：给出时必须与人数一致且非空
  const workerNames = [];
  for (let k = 0; k < workers; k++) workerNames.push(`人员 ${k + 1}`);
  if (b.workerNames !== undefined && b.workerNames !== null) {
    if (!Array.isArray(b.workerNames)) {
      errors.push('工作人员姓名必须是字符串数组');
    } else {
      const given = b.workerNames;
      if (given.length !== workers) {
        errors.push(`工作人员姓名数量（${given.length}）必须与人数（${workers}）一致`);
      }
      const seen = new Set();
      given.slice(0, workers).forEach((raw, i) => {
        const name = String(raw == null ? '' : raw).trim();
        if (!name) {
          errors.push(`第 ${i + 1} 名工作人员的姓名不能为空`);
        } else if (seen.has(name)) {
          errors.push(`工作人员姓名重复：${name}`);
        }
        seen.add(name);
        workerNames[i] = name || `人员 ${i + 1}`;
      });
    }
  }

  // 场景名表（仅用于生成可读的段标签）
  const names = new Map();
  if (b.scenes !== undefined && b.scenes !== null) {
    if (!Array.isArray(b.scenes)) {
      errors.push('场景数据格式无效：应为数组');
    } else {
      for (const s0 of b.scenes) {
        if (!s0 || typeof s0 !== 'object') continue;
        const id = String(s0.id);
        const name = String(s0.name == null ? '' : s0.name).trim() || id;
        if (id) names.set(id, name);
      }
    }
  }

  // 待排班步骤
  const rawSteps = b.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    errors.push('没有待排班的开场或换景步骤：当前节目单无需排班（可能全部场景已演完或节目单为空）');
  }

  const steps = [];
  if (Array.isArray(rawSteps)) {
    rawSteps.forEach((raw0, i) => {
      const where = `第 ${i + 1} 段`;
      if (!raw0 || typeof raw0 !== 'object') {
        errors.push(`${where}步骤格式无效`);
        return;
      }
      const type = raw0.type === 'transition' ? 'transition'
        : raw0.type === 'setup' ? 'setup' : null;
      if (!type) {
        errors.push(`${where}步骤类型必须是 setup（开场布置）或 transition（换景）`);
        return;
      }
      const removed = normalizeProps(raw0.removed);
      const added = normalizeProps(raw0.added);

      let step;
      if (type === 'setup') {
        const scene = raw0.scene == null ? '' : String(raw0.scene);
        if (!scene) errors.push(`${where}开场布置步骤缺少场景标识`);
        step = { type, scene, removed, added: [] };
      } else {
        const to = raw0.to == null ? '' : String(raw0.to);
        const from = raw0.from == null ? null : String(raw0.from);
        if (!to) errors.push(`${where}换景步骤缺少目标场景标识`);
        step = { type, from: from || null, to, fromStage: !!raw0.fromStage, removed, added: [] };
      }
      step.removed = removed;
      step.added = added;

      if (removed.length > MAX_PHASE_TASKS) {
        errors.push(`${where}（${segmentLabel(step, names)}）需撤下 ${removed.length} 件道具，`
          + `超过每阶段最多 ${MAX_PHASE_TASKS} 项任务的上限，无法排班`);
      }
      if (added.length > MAX_PHASE_TASKS) {
        errors.push(`${where}（${segmentLabel(step, names)}）需摆上 ${added.length} 件道具，`
          + `超过每阶段最多 ${MAX_PHASE_TASKS} 项任务的上限，无法排班`);
      }
      steps.push(step);
    });
  }

  // 工时表：当待执行步骤引用到道具时，必须为 { 道具名: 正整数 }
  const rawMinutes = b.minutes;
  const referenced = [];
  const refSeen = new Set();
  for (const st of steps) {
    for (const p of [...st.removed, ...st.added]) {
      if (!refSeen.has(p)) { refSeen.add(p); referenced.push(p); }
    }
  }
  const minutesOk = rawMinutes && typeof rawMinutes === 'object' && !Array.isArray(rawMinutes);
  if (rawMinutes !== undefined && rawMinutes !== null && !minutesOk) {
    errors.push('工时配置格式无效：应为 { 道具名: 正整数分钟 }');
  }

  // 工时：所有被待执行步骤引用到的道具都必须给出正整数分钟
  const minutes = {};
  for (const name0 of referenced) {
    if (!minutesOk || !(name0 in rawMinutes)) {
      errors.push(`缺少道具「${name0}」的单次搬运工时（正整数分钟）`);
      continue;
    }
    const v = Number(rawMinutes[name0]);
    if (!Number.isInteger(v) || v <= 0) {
      errors.push(`道具「${name0}」的单次搬运工时必须是正整数分钟`);
      continue;
    }
    minutes[name0] = v;
  }

  return { errors, workers, workerNames, steps, minutes, names };
}

/**
 * 单阶段同构并行机调度 P_m||C_max：给定任务工时数组，求最短最大完工时间，
 * 并返回**分配向量字典序最小**的稳定分工。
 *
 * @param {number[]} durations 任务工时（按下标即道具在该阶段中的顺序）
 * @param {number} m 并行人数（允许部分人空闲）
 * @returns {{ makespan:number, groups:number[][] }} groups[k] 为分给第 k 人
 *          （0 起）的任务下标数组（升序）；部分数组可为空
 */
function schedulePhase(durations, m) {
  const n = durations.length;
  const size = 1 << n;
  const full = size - 1;

  if (n === 0) return { makespan: 0, groups: Array.from({ length: m }, () => []) };

  // 子集工时和
  const sum = new Float64Array(size);
  for (let mask = 1; mask < size; mask++) {
    const bit = mask & -mask;
    const i = 31 - Math.clz32(bit);
    sum[mask] = sum[mask ^ bit] + durations[i];
  }

  // dp[k][mask]：至多 k 人（允许空组）覆盖 mask 的最小最大负载。
  // 转移利用人员对称性：新增的那一组固定包含 mask 中录入最早的任务
  // （anchor = 最低位），只需枚举含 anchor 的子集 s，枚举量减半；
  // 空组（该人空闲）由 cur 初值继承 prev 覆盖。
  const layers = [new Float64Array(size).fill(Infinity)];
  layers[0][0] = 0;
  let effective = 0; // 之后各层与之完全相同的最高层数（再加人也无任何改善）
  for (let k = 1; k <= m; k++) {
    const prev = layers[layers.length - 1];
    const cur = new Float64Array(prev); // 允许第 k 人空闲
    for (let mask = 1; mask < size; mask++) {
      const anchor = mask & -mask;
      const rest0 = mask ^ anchor;
      let best = cur[mask];
      for (let t = rest0; ; t = (t - 1) & rest0) {
        const s = t | anchor;
        const rest = mask ^ s;
        const pv = prev[rest];
        if (pv !== Infinity) {
          const load = sum[s];
          const cand = pv >= load ? pv : load;
          if (cand < best) best = cand;
        }
        if (t === 0) break;
      }
      cur[mask] = best;
    }
    layers.push(cur);
    effective = k;
    // 仅当"每个掩码"都不再改善时，后续层才与本层完全相同；
    // 只看 fullMask 达到下界并不够（重构会查询任意子集）。
    let stable = true;
    for (let mask = 0; mask < size; mask++) {
      if (cur[mask] !== prev[mask]) { stable = false; break; }
    }
    if (stable) break;
  }
  // 超过 effective 的层与 layers[effective] 同构（空闲人员不改变最优值）
  const layerAt = (k) => layers[Math.min(k, effective)];

  const makespan = layerAt(m)[full];

  // 重构：依次为第 k 人选组。剩余任务中录入顺序最早的一件必入当前组
  //（人员对称，总可把含该任务的组换标签到当前）；在保持后续可在剩余人数内
  // 不超过 makespan 完成的候选中，取"成员指示向量字典序最大"的组——
  // 即尽量把最早的任务分给编号最小的人，最终得到分配向量字典序最小的最优解。
  const groups = [];
  let remaining = full;
  for (let k = 0; k < m; k++) {
    let chosen = 0;
    if (remaining) {
      const after = layerAt(m - k - 1);
      const low = remaining & -remaining;
      for (let s = remaining; s; s = (s - 1) & remaining) {
        if (!(s & low)) continue;
        if (sum[s] > makespan) continue;
        if (after[remaining ^ s] > makespan) continue;
        if (indicatorGreater(s, chosen)) chosen = s;
      }
    }
    const group = [];
    for (let x = chosen; x; x &= x - 1) group.push(31 - Math.clz32(x & -x));
    groups.push(group);
    remaining ^= chosen;
  }

  return { makespan, groups };
}

/**
 * 以最低位任务为最高优先级比较子集指示向量：s 是否"字典序更大"
 * （下标 0 为首位）。best=0 时任何非空 s 都更大。
 */
function indicatorGreater(s, best) {
  if (best === 0) return s !== 0;
  const diff = s ^ best;
  if (diff === 0) return false;
  const lowDiff = diff & -diff; // 最早分歧的任务
  return (s & lowDiff) !== 0;
}

/**
 * 由分组构造每人的可执行时间线：同一人按任务在该阶段中的顺序串行，
 * 不同人并行。
 * @param {Array<{prop:string, minutes:number}>} tasks 阶段任务（有序）
 * @param {number[][]} groups schedulePhase 返回的分组
 * @param {number} timeOffset 该阶段在段内的起始分钟（撤下为 0，摆上为闸门）
 */
function buildPhaseWorkers(tasks, groups, timeOffset) {
  return groups.map((group, k) => {
    const list = [];
    let cursor = 0;
    for (const i of group) { // group 已按下标升序
      const start = cursor;
      const end = start + tasks[i].minutes;
      list.push({
        prop: tasks[i].prop,
        minutes: tasks[i].minutes,
        start: timeOffset + start,
        end: timeOffset + end,
      });
      cursor = end;
    }
    return {
      worker: k + 1, // 1 起，便于直接展示
      busy: cursor,
      tasks: list,
    };
  });
}

/** 为一段（开场 / 换景）排班：撤下全部完成（闸门）后才可摆上。 */
function scheduleSegment(step, index, workers, workerNames, minutes, names, segStart) {
  const removeTasks = step.removed.map(prop => ({ prop, minutes: minutes[prop] }));
  const addTasks = step.added.map(prop => ({ prop, minutes: minutes[prop] }));

  const removePlan = schedulePhase(removeTasks.map(t => t.minutes), workers);
  const addPlan = schedulePhase(addTasks.map(t => t.minutes), workers);

  const gate = removePlan.makespan;
  const removeWorkers = buildPhaseWorkers(removeTasks, removePlan.groups, 0);
  const addWorkers = buildPhaseWorkers(addTasks, addPlan.groups, gate);
  const addMakespan = addPlan.makespan;
  const duration = gate + addMakespan;

  return {
    index,
    type: step.type,
    label: segmentLabel(step, names),
    scene: step.type === 'setup' ? step.scene : step.to,
    from: step.type === 'transition' ? step.from : null,
    to: step.type === 'transition' ? step.to : null,
    fromStage: step.type === 'transition' ? !!step.fromStage : false,
    removeCount: step.removed.length,
    addCount: step.added.length,
    taskCount: step.removed.length + step.added.length,
    start: segStart,
    gate,
    end: segStart + duration,
    duration,
    wait: gate, // 摆上阶段在段内等待撤下完成的时长
    remove: { makespan: gate, workers: removeWorkers },
    add: { makespan: addMakespan, offset: gate, workers: addWorkers },
  };
}

/**
 * 排班入口。入参须先经 validateSchedule 校验（errors 为空）。
 * 各段按节目单顺序串行；段内"先撤后摆"。
 * 返回 { ok, workers, workerNames, segments, segmentCount, totalDuration,
 *        totalWait, totalTaskCount }。
 */
function scheduleCrew(steps, workers, workerNames, minutes, names) {
  const segments = [];
  let cursor = 0;
  let totalWait = 0;
  let totalTaskCount = 0;
  steps.forEach((step, i) => {
    const seg = scheduleSegment(step, i + 1, workers, workerNames, minutes, names, cursor);
    segments.push(seg);
    cursor = seg.end;
    totalWait += seg.wait;
    totalTaskCount += seg.taskCount;
  });
  return {
    ok: true,
    workers,
    workerNames: workerNames.slice(),
    segments,
    segmentCount: segments.length,
    totalDuration: cursor,
    totalWait,
    totalTaskCount,
  };
}

module.exports = {
  scheduleCrew,
  validateSchedule,
  schedulePhase,
  MIN_WORKERS,
  MAX_WORKERS,
  MAX_PHASE_TASKS,
};

'use strict';

const assert = require('assert');
const { solve, replan } = require('../solver');

const S = (id, props) => ({ id, name: id, props });
// 时长受限场景：T(id, props, duration, required, value)
const T = (id, props, duration, required, value) => ({ id, name: id, props, duration, required, value });
const empty = { dependencies: [], fixedPositions: [], forbiddenAdjacencies: [] };
const C = (over) => ({ ...empty, ...over });
const timed = (timeLimit) => ({ mode: 'timed', timeLimit });

/* 1. 无约束时选择道具变化最少的顺序 */
{
  const scenes = [
    S('A', ['桌', '椅']),
    S('B', ['桌', '椅', '灯']),
    S('C', ['树']),
  ];
  const r = solve(scenes, C());
  assert.strictEqual(r.ok, true);
  // 最优为 C->A->B：开场 1（树）+ C→A 3（撤树上桌椅）+ A→B 1（上灯）= 5
  assert.strictEqual(r.totalCost, 5);
  assert.deepStrictEqual(r.order, ['C', 'A', 'B']);
  assert.strictEqual(r.steps.length, 3);
  assert.strictEqual(r.steps[0].type, 'setup');
}

/* 2. 依赖约束 */
{
  const scenes = [S('A', ['x']), S('B', ['y']), S('C', ['z'])];
  const r = solve(scenes, C({ dependencies: [{ before: 'C', after: 'A' }] }));
  assert.strictEqual(r.ok, true);
  assert.ok(r.order.indexOf('C') < r.order.indexOf('A'));
}

/* 3. 固定序位 */
{
  const scenes = [S('A', []), S('B', []), S('C', [])];
  const r = solve(scenes, C({ fixedPositions: [{ sceneId: 'B', position: 1 }] }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.order[0], 'B');
}

/* 4. 禁止相邻 */
{
  const scenes = [S('A', []), S('B', []), S('C', [])];
  const r = solve(scenes, C({ forbiddenAdjacencies: [{ a: 'A', b: 'B' }] }));
  assert.strictEqual(r.ok, true);
  for (let i = 0; i + 1 < r.order.length; i++) {
    const pair = [r.order[i], r.order[i + 1]].sort().join(',');
    assert.notStrictEqual(pair, 'A,B');
  }
}

/* 5. 依赖环 → 无解并指出环 */
{
  const scenes = [S('A', []), S('B', []), S('C', [])];
  const r = solve(scenes, C({
    dependencies: [
      { before: 'A', after: 'B' },
      { before: 'B', after: 'C' },
      { before: 'C', after: 'A' },
    ],
  }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflict.type, 'dependency-cycle');
  assert.strictEqual(r.conflict.constraints.length, 3);
}

/* 6. 固定序位冲突（两个场景同一位）→ 极小冲突核心 */
{
  const scenes = [S('A', []), S('B', [])];
  const r = solve(scenes, C({
    fixedPositions: [
      { sceneId: 'A', position: 1 },
      { sceneId: 'B', position: 1 },
    ],
  }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflict.type, 'constraint-set');
  assert.strictEqual(r.conflict.constraints.length, 2);
}

/* 7. 依赖与固定序位冲突 */
{
  const scenes = [S('A', []), S('B', [])];
  const r = solve(scenes, C({
    dependencies: [{ before: 'A', after: 'B' }],
    fixedPositions: [{ sceneId: 'B', position: 1 }],
  }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflict.constraints.length, 2);
}

/* 8. 禁止相邻导致的无解（2 个场景互不相邻） */
{
  const scenes = [S('A', []), S('B', [])];
  const r = solve(scenes, C({ forbiddenAdjacencies: [{ a: 'A', b: 'B' }] }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflict.constraints.length, 1);
}

/* 9. 12 个场景性能冒烟测试（应远小于 1 秒） */
{
  const scenes = [];
  for (let i = 0; i < 12; i++) scenes.push(S(`S${i}`, [`p${i}`, `p${i + 1}`]));
  const t0 = Date.now();
  const r = solve(scenes, C({
    dependencies: [{ before: 'S0', after: 'S11' }],
    fixedPositions: [{ sceneId: 'S5', position: 6 }],
    forbiddenAdjacencies: [{ a: 'S1', b: 'S2' }],
  }));
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.order.length, 12);
  assert.ok(elapsed < 1000, `求解耗时 ${elapsed}ms，超过预期`);
}

/* 10. 换景明细账目核对：总次数 = 各步之和 */
{
  const scenes = [
    S('A', ['桌', '椅', '灯']),
    S('B', ['椅', '灯', '幕']),
    S('C', ['幕', '鼓']),
  ];
  const r = solve(scenes, C());
  assert.strictEqual(r.ok, true);
  const sum = r.steps.reduce((acc, s) => acc + s.count, 0);
  assert.strictEqual(sum, r.totalCost);
  // 最优顺序为 C->B->A：开场 2（幕鼓）+ C→B 3（撤鼓上椅灯）+ B→A 2（撤幕上桌）= 7
  assert.strictEqual(r.totalCost, 7);
  assert.deepStrictEqual(r.order, ['C', 'B', 'A']);
}

/* ================= 时长受限编排（timed）================= */

/* 11. 无必演、无约束：在时长内全部入选，价值最大；输出字段完整 */
{
  const scenes = [
    T('A', ['x'], 10, false, 5),
    T('B', ['x'], 10, false, 8),
  ];
  const r = solve(scenes, C(), timed(20));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mode, 'timed');
  assert.deepStrictEqual(r.order.sort(), ['A', 'B']);
  assert.deepStrictEqual(r.selectedIds.sort(), ['A', 'B']);
  assert.deepStrictEqual(r.excludedIds, []);
  assert.strictEqual(r.totalValue, 13);
  assert.strictEqual(r.usedDuration, 20);
  assert.strictEqual(r.remainingDuration, 0);
  assert.strictEqual(r.timeLimit, 20);
  assert.ok(Array.isArray(r.steps));
  // steps 账目：总次数 = 各步之和
  assert.strictEqual(r.steps.reduce((a, s) => a + s.count, 0), r.totalCost);
}

/* 12. 时长放不下全部可选场景：选价值最高的子集（必演恒入选） */
{
  const scenes = [
    T('A', ['x'], 10, true, 0),
    T('B', ['x'], 10, false, 5),
    T('C', ['y'], 10, false, 8),
  ];
  const r = solve(scenes, C(), timed(20));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.order, ['C', 'A']);
  assert.strictEqual(r.totalValue, 8);
  assert.strictEqual(r.usedDuration, 20);
  assert.deepStrictEqual(r.excludedIds, ['B']);
}

/* 13. 同分（价值相同）时最小化道具增减次数 */
{
  // B 与必演 A 道具相同（相邻代价 0），C 与 A 完全不同（相邻代价 2）；二者价值相同
  const scenes = [
    T('A', ['x'], 10, true, 0),
    T('B', ['x'], 10, false, 5),
    T('C', ['z'], 10, false, 5),
  ];
  const r = solve(scenes, C(), timed(20));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.order, ['B', 'A']);
  assert.strictEqual(r.totalValue, 5);
  assert.strictEqual(r.totalCost, 1); // 开场布置 1 件，B→A 无变化
}

/* 14. 未入选场景不参与约束：它的禁止相邻与固定序位均被忽略 */
{
  const scenes = [
    T('A', [], 10, true, 0),
    T('B', [], 10, false, 0), // 价值 0，最优解不选它
    T('C', [], 10, true, 0),
  ];
  const r = solve(scenes, C({
    forbiddenAdjacencies: [{ a: 'B', b: 'A' }],
    fixedPositions: [{ sceneId: 'C', position: 2 }],
  }), timed(30));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.order, ['A', 'C']);
  assert.deepStrictEqual(r.excludedIds, ['B']);
}

/* 15. 固定序位按入选后的演出序列计算：舍弃 C 后 B 在第 2 位满足约束 */
{
  const scenes = [
    T('A', [], 5, true, 0),
    T('B', [], 5, false, 10),
    T('C', [], 5, false, 1),
    T('D', [], 5, true, 0),
  ];
  // 上限 15：必演 A、D 共 10 分钟，只能再带 1 个可选；选价值 10 的 B。
  // C 被舍弃，其固定第 2 位失效；B 本身无固定约束，序列为 D、B、A。
  const r = solve(scenes, C({ fixedPositions: [{ sceneId: 'C', position: 2 }] }), timed(15));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.order, ['D', 'B', 'A']);
  assert.deepStrictEqual(r.excludedIds, ['C']);
}

/* 16. 必演场景总时长超限 → 专门的超时无解提示 */
{
  const scenes = [
    T('A', [], 11, true, 0),
    T('B', [], 10, true, 0),
  ];
  const r = solve(scenes, C(), timed(20));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'required-overtime');
  assert.strictEqual(r.conflict.type, 'required-overtime');
  assert.strictEqual(r.conflict.requiredTotal, 21);
  assert.strictEqual(r.conflict.timeLimit, 20);
}

/* 17. 必演之间的依赖环 → 指出环，且说明取舍可选也无法解除 */
{
  const scenes = [
    T('A', [], 5, true, 0),
    T('B', [], 5, true, 0),
    T('C', [], 5, false, 10),
  ];
  const r = solve(scenes, C({
    dependencies: [
      { before: 'A', after: 'B' },
      { before: 'B', after: 'A' },
    ],
  }), timed(20));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflict.type, 'dependency-cycle');
  assert.strictEqual(r.conflict.constraints.length, 2);
}

/* 18. 两个必演场景固定同一序位 → 冲突提示 */
{
  const scenes = [
    T('A', [], 5, true, 0),
    T('B', [], 5, true, 0),
  ];
  const r = solve(scenes, C({
    fixedPositions: [
      { sceneId: 'A', position: 1 },
      { sceneId: 'B', position: 1 },
    ],
  }), timed(20));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflict.type, 'constraint-set');
  assert.strictEqual(r.conflict.constraints.length, 2);
}

/* 19. 必演禁止相邻需要缓冲：上限放不下缓冲 → timed-infeasible；放宽上限后可解 */
{
  const scenes = [
    T('A', [], 10, true, 0),
    T('B', [], 10, true, 0),
    T('C', [], 5, false, 1), // 唯一缓冲
  ];
  const cons = C({ forbiddenAdjacencies: [{ a: 'A', b: 'B' }] });
  const tight = solve(scenes, cons, timed(20));
  assert.strictEqual(tight.ok, false);
  assert.strictEqual(tight.conflict.type, 'timed-infeasible');

  const loose = solve(scenes, cons, timed(25));
  assert.strictEqual(loose.ok, true);
  assert.deepStrictEqual(loose.order, ['B', 'C', 'A']);
  assert.strictEqual(loose.totalValue, 1);
  assert.strictEqual(loose.usedDuration, 25);
}

/* 20. 结构性硬冲突：唯一缓冲的位置被依赖锁死，提高时长上限也无解 */
{
  const scenes = [
    T('A', [], 10, true, 0),   // 固定第 1 位
    T('B', [], 10, true, 0),   // 固定第 3 位，且与 A 禁止相邻 → 需要第 2 位缓冲
    T('X', [], 1, false, 1),   // 唯一缓冲，但 B 必须在 X 之前 → X 不能放第 2 位
  ];
  const r = solve(scenes, C({
    fixedPositions: [
      { sceneId: 'A', position: 1 },
      { sceneId: 'B', position: 3 },
    ],
    forbiddenAdjacencies: [{ a: 'A', b: 'B' }],
    dependencies: [{ before: 'B', after: 'X' }],
  }), timed(200));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflict.type, 'constraint-set');
  const kinds = r.conflict.constraints.map(c => c.kind).sort();
  assert.ok(kinds.includes('dependency'));
  assert.ok(kinds.includes('fixedPosition'));
}

/* 21. 确定性：价值与代价都同分时，两次求解结果一致 */
{
  const scenes = [
    T('A', [], 5, true, 0),
    T('B', [], 5, false, 3),
    T('C', [], 5, false, 3),
  ];
  const r1 = solve(scenes, C(), timed(15));
  const r2 = solve(scenes, C(), timed(15));
  assert.strictEqual(r1.ok, true);
  assert.deepStrictEqual(r1.order, r2.order);
  assert.deepStrictEqual(r1.order, ['C', 'B', 'A']);
}

/* 22. 无必演且上限放不下任何场景：空节目单是合法解 */
{
  const scenes = [T('A', [], 10, false, 5)];
  const r = solve(scenes, C(), timed(5));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.order, []);
  assert.deepStrictEqual(r.selectedIds, []);
  assert.deepStrictEqual(r.excludedIds, ['A']);
  assert.strictEqual(r.totalValue, 0);
  assert.strictEqual(r.totalCost, 0);
  assert.strictEqual(r.usedDuration, 0);
  assert.strictEqual(r.remainingDuration, 5);
  assert.deepStrictEqual(r.steps, []);
}

/* 23. 依赖仅在双方都入选时生效；仅涉及被舍弃可选场景的依赖不影响求解 */
{
  const scenes = [
    T('A', [], 10, true, 0),
    T('X', [], 10, false, 5),
  ];
  // A→X 与 X→A 成环，但 X 可被舍弃，舍弃后只剩 A，有解
  const r = solve(scenes, C({
    dependencies: [
      { before: 'A', after: 'X' },
      { before: 'X', after: 'A' },
    ],
  }), timed(10));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.order, ['A']);
  assert.deepStrictEqual(r.excludedIds, ['X']);
}

/* 24. 必演固定序位超出必演数量：需要且能够插入可选缓冲填满前置序位 */
{
  const scenes = [
    T('A', [], 5, true, 0),
    T('B', [], 5, false, 3),
    T('C', [], 5, true, 0), // 固定第 3 位
  ];
  const r = solve(scenes, C({ fixedPositions: [{ sceneId: 'C', position: 3 }] }), timed(15));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.order, ['B', 'A', 'C']);
  assert.strictEqual(r.order[2], 'C');
}

/* 25. 12 个场景 timed 模式性能冒烟（应远小于 1 秒） */
{
  const scenes = [];
  for (let i = 0; i < 12; i++) scenes.push(T(`S${i}`, [`p${i}`, `p${i + 1}`], 5, i < 3, i));
  const t0 = Date.now();
  const r = solve(scenes, C({
    dependencies: [{ before: 'S0', after: 'S11' }],
    fixedPositions: [{ sceneId: 'S5', position: 6 }],
    forbiddenAdjacencies: [{ a: 'S1', b: 'S2' }],
  }), timed(60));
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.ok, true);
  // 必演 3 个（15 分钟），上限 60 分钟最多再放 9 个，共 12 个
  assert.strictEqual(r.order.length, 12);
  for (const id of ['S0', 'S1', 'S2']) assert.ok(r.selectedIds.includes(id));
  assert.ok(elapsed < 1000, `timed 求解耗时 ${elapsed}ms，超过预期`);
}

/* 26. 必演场景上的 value 不参与价值统计（必演恒入选，价值恒为 0 贡献） */
{
  const scenes = [
    T('A', [], 10, true, 999),
    T('B', [], 10, false, 7),
  ];
  const r = solve(scenes, C(), timed(20));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.totalValue, 7);
}

/* ================= 演出中重排（replan）================= */

const R = (opts) => ({ replan: opts });

/* 27. 经典重排：前缀固定，剩余重排；首个剩余代价按实际道具；账目一致 */
{
  const scenes = [
    S('A', ['x']),
    S('B', ['x']),
    S('C', ['y']),
    S('D', ['y']),
  ];
  const r = replan(scenes, C(), R({ prefixIds: ['A'], stageProps: ['z'], originalOrder: ['B', 'A', 'D', 'C'] }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.replanned, true);
  assert.deepStrictEqual(r.prefixIds, ['A']);
  assert.strictEqual(r.order[0], 'A'); // 前缀不可改变
  // 舞台实际 {z}：剩余 B{x}, C{y}, D{y} 首场景代价都是 2；后缀内部 C、D 相同
  assert.deepStrictEqual(r.suffixIds.slice().sort(), ['B', 'C', 'D']);
  // 第一个后缀步骤：从实际道具 {z} 切入
  const firstSuffixStep = r.steps.find(s => s.fromStage);
  assert.ok(firstSuffixStep);
  assert.deepStrictEqual(firstSuffixStep.removed.sort(), ['z']);
  assert.strictEqual(r.prefixCost, 1); // 开场 A{x} = 1
  assert.strictEqual(r.totalCost, r.prefixCost + r.suffixCost);
  assert.strictEqual(r.steps.reduce((a, s) => a + s.count, 0), r.totalCost);
  // 与原计划的整场代价对比：B{x}=1, B→A 0, A→D 2, D→C 0 → 3
  assert.strictEqual(r.originalTotalCost, 3);
  assert.strictEqual(r.costDelta, r.totalCost - r.originalTotalCost);
}

/* 28. 跨前缀依赖按完成事实校验：
   - before 已完成、after 在剩余：合法；
   - after 已完成、before 在剩余：具体冲突。 */
{
  const scenes = [S('A', []), S('B', []), S('C', [])];
  const ok = replan(scenes, C({ dependencies: [{ before: 'A', after: 'B' }] }),
    R({ prefixIds: ['A'], stageProps: [] }));
  assert.strictEqual(ok.ok, true);
  assert.ok(ok.order.indexOf('A') < ok.order.indexOf('B'));

  const bad = replan(scenes, C({ dependencies: [{ before: 'C', after: 'A' }] }),
    R({ prefixIds: ['A'], stageProps: [] }));
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.conflict.type, 'prefix-conflict');
  assert.strictEqual(bad.conflict.conflicts[0].type, 'dependency-cross');
}

/* 29. 前缀内部顺序违反依赖 / 禁止相邻：指出具体冲突 */
{
  const scenes = [S('A', []), S('B', []), S('C', [])];
  const dep = replan(scenes, C({ dependencies: [{ before: 'B', after: 'A' }] }),
    R({ prefixIds: ['A', 'B'], stageProps: [] }));
  assert.strictEqual(dep.ok, false);
  assert.strictEqual(dep.conflict.conflicts[0].type, 'dependency-order');

  const adj = replan(scenes, C({ forbiddenAdjacencies: [{ a: 'A', b: 'B' }] }),
    R({ prefixIds: ['A', 'B'], stageProps: [] }));
  assert.strictEqual(adj.ok, false);
  assert.strictEqual(adj.conflict.conflicts[0].type, 'forbidden-adjacency-prefix');
}

/* 30. 固定序位按整场绝对位次：前缀场景错位 / 剩余场景固定在前缀位次 */
{
  const scenes = [S('A', []), S('B', []), S('C', [])];
  const wrong = replan(scenes, C({ fixedPositions: [{ sceneId: 'B', position: 3 }] }),
    R({ prefixIds: ['A', 'B'], stageProps: [] }));
  assert.strictEqual(wrong.ok, false);
  assert.strictEqual(wrong.conflict.conflicts[0].type, 'fixed-position-prefix');

  const occupied = replan(scenes, C({ fixedPositions: [{ sceneId: 'C', position: 2 }] }),
    R({ prefixIds: ['A', 'B'], stageProps: [] }));
  assert.strictEqual(occupied.ok, false);
  assert.strictEqual(occupied.conflict.conflicts[0].type, 'fixed-position-occupied');

  // B 固定第 2 位，前缀 A、B 恰好满足；后缀 C 可以排
  const good = replan(scenes, C({ fixedPositions: [{ sceneId: 'B', position: 2 }] }),
    R({ prefixIds: ['A', 'B'], stageProps: [] }));
  assert.strictEqual(good.ok, true);
  assert.deepStrictEqual(good.order, ['A', 'B', 'C']);
}

/* 31. 边界禁止相邻：前缀末场景与首个剩余场景不得相邻；无缓冲 → 后缀冲突核心 */
{
  const scenes = [S('A', []), S('B', [])];
  const r = replan(scenes, C({ forbiddenAdjacencies: [{ a: 'A', b: 'B' }] }),
    R({ prefixIds: ['A'], stageProps: [] }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflict.type, 'constraint-set');
  assert.strictEqual(r.conflict.constraints.length, 1);

  // 有缓冲 C 时可行：首个剩余必为 C
  const scenes3 = [S('A', []), S('B', []), S('C', [])];
  const ok = replan(scenes3, C({ forbiddenAdjacencies: [{ a: 'A', b: 'B' }] }),
    R({ prefixIds: ['A'], stageProps: [] }));
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.suffixIds[0], 'C');
}

/* 32. timed 重排：扣除已用时长；前缀可选价值计入；价值优先、换景次优 */
{
  const scenes = [
    T('A', ['x'], 10, true, 0),
    T('B', ['x'], 10, false, 5),
    T('C', ['y'], 10, false, 8),
  ];
  // 原计划 C,A（价值 8，20 分钟）；演完 C（前缀，价值 8 计入），剩 10 分钟只能再带 A
  const r = replan(scenes, C(), { mode: 'timed', timeLimit: 20,
    replan: { prefixIds: ['C'], stageProps: ['y'], originalOrder: ['C', 'A'] } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.order, ['C', 'A']);
  assert.strictEqual(r.totalValue, 8);
  assert.strictEqual(r.prefixValue, 8);
  assert.strictEqual(r.suffixValue, 0);
  assert.strictEqual(r.prefixDuration, 10);
  assert.strictEqual(r.timeBudget, 10);
  assert.strictEqual(r.usedDuration, 20);
  assert.strictEqual(r.remainingDuration, 0);
  assert.deepStrictEqual(r.excludedIds, ['B']);
  assert.strictEqual(r.totalCost, r.prefixCost + r.suffixCost);
}

/* 33. timed 重排：剩余时长内可新增可选场景，价值优先于换景 */
{
  const scenes = [
    T('A', [], 10, true, 0),
    T('B', [], 10, false, 5),
    T('C', [], 10, false, 9),
  ];
  // 前缀 A 完成（10 分钟），剩余 20 分钟可带 B、C 两个；价值 14 最大
  const r = replan(scenes, C(), { mode: 'timed', timeLimit: 30,
    replan: { prefixIds: ['A'], stageProps: [] } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.order[0], 'A');
  assert.deepStrictEqual(r.suffixIds.slice().sort(), ['B', 'C']);
  assert.strictEqual(r.totalValue, 14);
}

/* 34. timed 重排：舍弃场景按"原计划有、新计划无"列出 */
{
  const scenes = [
    T('A', [], 10, true, 0),
    T('B', [], 10, false, 5),
    T('C', [], 10, false, 8),
  ];
  // 原计划 A,C（10+10=20 内价值 8 最优）；演完 A 后只剩 5 分钟 → C 也放不下
  const r = replan(scenes, C(), { mode: 'timed', timeLimit: 15,
    replan: { prefixIds: ['A'], stageProps: [], originalOrder: ['A', 'C'] } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.order, ['A']);
  assert.deepStrictEqual(r.droppedScenes, ['C']);
  assert.strictEqual(r.totalValue, 0);
  assert.strictEqual(r.usedDuration, 10);
  assert.strictEqual(r.remainingDuration, 5);
}

/* 35. timed 前缀超时 / 剩余必演超时 */
{
  const scenes = [
    T('A', [], 15, true, 0),
    T('B', [], 10, true, 0),
  ];
  const over = replan(scenes, C(), { mode: 'timed', timeLimit: 20,
    replan: { prefixIds: ['A'], stageProps: [] } });
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.conflict.type, 'required-overtime');
  assert.strictEqual(over.conflict.timeBudget, 5);

  const prefixOver = replan(scenes, C(), { mode: 'timed', timeLimit: 20,
    replan: { prefixIds: ['A', 'B'], stageProps: [] } });
  assert.strictEqual(prefixOver.ok, false);
  assert.strictEqual(prefixOver.conflict.type, 'prefix-overtime');
}

/* 36. timed：可选场景固定到前缀位次不报错（被禁选）；必演则报前缀冲突 */
{
  const scenes = [
    T('A', [], 10, true, 0),
    T('X', [], 10, false, 9),
    T('B', [], 10, true, 0),
  ];
  const cons = C({ fixedPositions: [{ sceneId: 'X', position: 1 }] });
  const ok = replan(scenes, cons, { mode: 'timed', timeLimit: 30,
    replan: { prefixIds: ['A'], stageProps: [] } });
  assert.strictEqual(ok.ok, true);
  assert.ok(!ok.order.includes('X'));
  assert.deepStrictEqual(ok.excludedIds, ['X']);

  const scenes2 = [T('A', [], 10, true, 0), T('R', [], 10, true, 0)];
  const bad = replan(scenes2, C({ fixedPositions: [{ sceneId: 'R', position: 1 }] }),
    { mode: 'timed', timeLimit: 30, replan: { prefixIds: ['A'], stageProps: [] } });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.conflict.conflicts[0].type, 'fixed-position-occupied');
}

/* 37. 空前缀：从当前实际道具开场；全前缀：空后缀直接完成 */
{
  const scenes = [S('A', ['x']), S('B', ['y'])];
  const r = replan(scenes, C(), R({ prefixIds: [], stageProps: ['q', 'x'] }));
  assert.strictEqual(r.ok, true);
  // {q,x} 与 A{x} 对称差 1，与 B{y} 对称差 2 → A 首位更优
  assert.strictEqual(r.order[0], 'A');
  assert.strictEqual(r.steps[0].fromStage, true);
  assert.strictEqual(r.steps[0].count, 1); // 撤 q

  const done = replan([S('A', []), S('B', [])], C({ dependencies: [{ before: 'A', after: 'B' }] }),
    R({ prefixIds: ['A', 'B'], stageProps: [] }));
  assert.strictEqual(done.ok, true);
  assert.deepStrictEqual(done.suffixIds, []);
  assert.strictEqual(done.suffixCost, 0);
  assert.deepStrictEqual(done.steps.map(s => s.phase), ['done', 'done']);
}

/* 38. 连续重排：可基于重排结果继续重排，前缀只能延长 */
{
  const scenes = [
    S('A', ['x']),
    S('B', ['y']),
    S('C', ['x', 'y']),
  ];
  const r1 = replan(scenes, C(), R({ prefixIds: ['A'], stageProps: ['x'], originalOrder: ['C', 'B', 'A'] }));
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.order[0], 'A');
  // 再演完 r1 的第二个场景，前缀延长为 2
  const r2 = replan(scenes, C(), R({
    prefixIds: r1.order.slice(0, 2),
    stageProps: ['x', 'y'],
    originalOrder: r1.order,
  }));
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.prefixIds.length, 2);
  assert.deepStrictEqual(r2.prefixIds, r1.order.slice(0, 2));
  assert.strictEqual(r2.suffixIds.length, 1);
  assert.strictEqual(r2.steps.filter(s => s.phase === 'done').length, 2);
}

/* 39. 非法前缀：引用不存在的场景 / 场景重复 */
{
  const scenes = [S('A', [])];
  const missing = replan(scenes, C(), R({ prefixIds: ['ZZZ'], stageProps: [] }));
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.conflict.type, 'invalid-prefix');
  const dup = replan([S('A', []), S('B', [])], C(), R({ prefixIds: ['A', 'A'], stageProps: [] }));
  assert.strictEqual(dup.ok, false);
  assert.strictEqual(dup.conflict.type, 'invalid-prefix');
}

/* 40. 12 场景重排性能冒烟（应远小于 1 秒） */
{
  const scenes = [];
  for (let i = 0; i < 12; i++) scenes.push(S(`S${i}`, [`p${i}`, `p${i + 1}`]));
  const t0 = Date.now();
  const r = replan(scenes, C({
    dependencies: [{ before: 'S0', after: 'S11' }],
    fixedPositions: [{ sceneId: 'S5', position: 6 }],
    forbiddenAdjacencies: [{ a: 'S1', b: 'S2' }],
  }), R({ prefixIds: ['S0', 'S1'], stageProps: ['p0', 'p1'] }));
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.order.length, 12);
  assert.deepStrictEqual(r.prefixIds, ['S0', 'S1']);
  assert.ok(elapsed < 1000, `重排耗时 ${elapsed}ms，超过预期`);
}

/* ================= 单段道具操作上限（opLimit）================= */

/* 41. 不带 opLimit 时行为不变；带 opLimit 时每段操作数不超过上限 */
{
  const scenes = [
    S('A', ['桌', '椅']),
    S('B', ['桌', '椅', '灯']),
    S('C', ['树']),
  ];
  const free = solve(scenes, C());
  assert.strictEqual(free.opLimit, null);

  // cap=3：原最优 C->A->B 的各段为 1/3/1，可行且仍最优
  const cap3 = solve(scenes, C(), { opLimit: 3 });
  assert.strictEqual(cap3.ok, true);
  assert.deepStrictEqual(cap3.order, ['C', 'A', 'B']);
  assert.strictEqual(cap3.totalCost, 5);
  assert.strictEqual(cap3.opLimit, 3);
  for (const step of cap3.steps) assert.ok(step.count <= 3);

  // cap=2：任何顺序都含至少 3 件的一段 → 无解
  const cap2 = solve(scenes, C(), { opLimit: 2 });
  assert.strictEqual(cap2.ok, false);
  assert.strictEqual(cap2.conflict.type, 'prop-limit-infeasible');
  assert.strictEqual(cap2.conflict.opLimit, 2);
  assert.strictEqual(cap2.conflict.minRequiredLimit, 3);
  assert.ok(cap2.conflict.message.includes('3 件'));
}

/* 42. 上限可行但收紧可行域：在满足上限的候选中仍按原目标择优（代价可严格变大） */
{
  const scenes = [
    S('s0', ['p2', 'p4', 'p6']),
    S('s1', ['p5', 'p1', 'p6']),
    S('s2', ['p4']),
    S('s3', ['p5', 'p3']),
  ];
  const free = solve(scenes, C());
  assert.deepStrictEqual(free.order, ['s2', 's0', 's1', 's3']);
  assert.strictEqual(free.totalCost, 10);
  assert.deepStrictEqual(free.steps.map(s => s.count), [1, 2, 4, 3]);

  const capped = solve(scenes, C(), { opLimit: 3 });
  assert.strictEqual(capped.ok, true);
  assert.deepStrictEqual(capped.order, ['s1', 's3', 's2', 's0']);
  assert.strictEqual(capped.totalCost, 11); // 原最优含 4 件的一段被禁，次优为 11
  for (const step of capped.steps) assert.ok(step.count <= 3);
}

/* 43. 上限与既有约束并存：不限上限仍无解时按原归因（依赖环 / 约束核心），不嫁祸给上限 */
{
  const scenes = [S('A', []), S('B', [])];
  const cyc = solve(scenes, C({
    dependencies: [{ before: 'A', after: 'B' }, { before: 'B', after: 'A' }],
  }), { opLimit: 3 });
  assert.strictEqual(cyc.ok, false);
  assert.strictEqual(cyc.conflict.type, 'dependency-cycle');

  const fixed = solve(scenes, C({
    fixedPositions: [{ sceneId: 'A', position: 1 }, { sceneId: 'B', position: 1 }],
  }), { opLimit: 3 });
  assert.strictEqual(fixed.ok, false);
  assert.strictEqual(fixed.conflict.type, 'constraint-set');
}

/* 44. 重排：上限只约束后缀（含从当前实际道具切入的首段）；已完成前缀段不校验 */
{
  const scenes = [
    S('A', ['桌', '椅']),
    S('B', ['桌', '椅', '灯']),
    S('C', ['树']),
  ];

  // 实际舞台恰好为 {桌椅}：切入 A 为 0 件、A→B 上灯 1 件，cap=1 可排
  const ok = replan(scenes, C(), { opLimit: 1, replan: {
    prefixIds: ['C'], stageProps: ['桌', '椅'], originalOrder: ['C', 'A', 'B'],
  } });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.order, ['C', 'A', 'B']);
  assert.strictEqual(ok.opLimit, 1);
  const suffixSteps = ok.steps.filter(s => s.phase === 'suffix');
  for (const s of suffixSteps) assert.ok(s.count <= 1);

  // 实际舞台 {树桌}：首段切入最少 2 件，cap=1 无解 → 明确上限提示
  const bad = replan(scenes, C(), { opLimit: 1, replan: {
    prefixIds: ['C'], stageProps: ['树', '桌'], originalOrder: ['C', 'A', 'B'],
  } });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.conflict.type, 'prop-limit-infeasible');
  assert.ok(bad.conflict.minRequiredLimit >= 1);
}

/* 45. timed 模式：价值优先不变，仅在满足上限的候选中择优；空节目单不受上限影响 */
{
  const scenes = [
    T('A', ['桌', '椅'], 10, true, 0),
    T('B', ['灯'], 10, false, 5),
    T('C', ['树'], 10, false, 8),
  ];
  const tcap = solve(scenes, C(), { mode: 'timed', timeLimit: 30, opLimit: 1 });
  assert.strictEqual(tcap.ok, false);
  assert.strictEqual(tcap.conflict.type, 'prop-limit-infeasible');
  assert.strictEqual(tcap.conflict.minRequiredLimit, 2);

  const tcap3 = solve(scenes, C(), { mode: 'timed', timeLimit: 30, opLimit: 3 });
  assert.strictEqual(tcap3.ok, true);
  assert.strictEqual(tcap3.totalValue, 13); // 价值仍最大化
  for (const s of tcap3.steps) assert.ok(s.count <= 3);

  const emptyProg = solve([T('Z', ['x', 'y', 'z'], 10, false, 5)], C(),
    { mode: 'timed', timeLimit: 5, opLimit: 1 });
  assert.strictEqual(emptyProg.ok, true);
  assert.deepStrictEqual(emptyProg.order, []);
}

/* 46. 12 场景带上限性能冒烟（含无解路径的二分诊断，应远小于 1 秒） */
{
  const scenes = [];
  for (let i = 0; i < 12; i++) scenes.push(S(`S${i}`, [`p${i}`, `p${i + 1}`, `q${i}`]));
  const t0 = Date.now();
  const r = solve(scenes, C(), { opLimit: 1 }); // 开场至少 3 件，必然因上限无解
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflict.type, 'prop-limit-infeasible');
  assert.ok(elapsed < 1000, `带诊断的求解耗时 ${elapsed}ms，超过预期`);
}

/* ================= 备选节目单（alternatives）================= */

/* 47. 不请求备选时响应完全保持原样：没有 alternatives 字段 */
{
  const scenes = [S('A', []), S('B', []), S('C', [])];
  const r = solve(scenes, C());
  assert.strictEqual(r.ok, true);
  assert.ok(!('alternatives' in r));
  const r1 = solve(scenes, C(), { alternatives: 1 });
  assert.ok(!('alternatives' in r1));
  // 非法值（0、负数、非整数、超过上限）一律按不请求处理
  for (const bad of [0, -1, 1.5, 4, 99, null, 'x']) {
    const rb = solve(scenes, C(), { alternatives: bad });
    assert.ok(!('alternatives' in rb), `alternatives=${JSON.stringify(bad)} 不应返回备选`);
  }
}

/* 48. classic 备选：按道具操作总数升序，顺序互不相同，顶层字段描述第 1 条 */
{
  const scenes = [
    S('A', ['桌', '椅']),
    S('B', ['桌', '椅', '灯']),
    S('C', ['树']),
  ];
  // 最优 C->A->B=5，其后 C->B->A=6、A->B->C=7（枚举核对）
  const r = solve(scenes, C(), { alternatives: 3 });
  assert.strictEqual(r.ok, true);
  assert.ok(Array.isArray(r.alternatives));
  assert.strictEqual(r.alternatives.length, 3);
  assert.deepStrictEqual(r.alternatives.map(a => a.totalCost), [5, 6, 7]);
  assert.deepStrictEqual(r.alternatives.map(a => a.order), [
    ['C', 'A', 'B'], ['C', 'B', 'A'], ['A', 'B', 'C'],
  ]);
  assert.deepStrictEqual(r.order, r.alternatives[0].order);
  assert.strictEqual(r.totalCost, r.alternatives[0].totalCost);
  r.alternatives.forEach((a, i) => {
    assert.strictEqual(a.rank, i + 1);
    assert.strictEqual(a.steps.reduce((x, s) => x + s.count, 0), a.totalCost);
  });
  // 顺序两两不同
  const keys = new Set(r.alternatives.map(a => a.order.join(',')));
  assert.strictEqual(keys.size, 3);
}

/* 49. classic 完全同分：按场景录入顺序（下标序列字典序）稳定排序 */
{
  const scenes = [S('A', []), S('B', []), S('C', []), S('D', [])];
  const r = solve(scenes, C(), { alternatives: 3 });
  assert.strictEqual(r.alternatives.length, 3);
  assert.deepStrictEqual(r.alternatives.map(a => a.order), [
    ['A', 'B', 'C', 'D'],
    ['A', 'B', 'D', 'C'],
    ['A', 'C', 'B', 'D'],
  ]);
  // 确定性：重复求解结果一致
  const r2 = solve(scenes, C(), { alternatives: 3 });
  assert.deepStrictEqual(r.alternatives.map(a => a.order), r2.alternatives.map(a => a.order));
}

/* 50. 每条备选都必须满足依赖、固定序位、禁止相邻；可行解不足时只返回存在的条数 */
{
  const scenes = [
    S('A', ['桌', '椅']),
    S('B', ['桌', '椅', '灯']),
    S('C', ['树']),
  ];
  const cons = C({
    dependencies: [{ before: 'C', after: 'A' }],
    forbiddenAdjacencies: [{ a: 'A', b: 'B' }],
  });
  const r = solve(scenes, cons, { alternatives: 3 });
  assert.strictEqual(r.ok, true);
  // C 必须在 A 前且 A/B 不得相邻：唯一可行排列为 B-C-A
  assert.strictEqual(r.alternatives.length, 1);
  assert.deepStrictEqual(r.alternatives[0].order, ['B', 'C', 'A']);

  // 仅依赖（C 在 A 前）时存在 3 条可行排列，按代价升序返回
  const r2 = solve(scenes, C({ dependencies: [{ before: 'C', after: 'A' }] }), { alternatives: 3 });
  assert.strictEqual(r2.alternatives.length, 3);
  for (const a of r2.alternatives) assert.ok(a.order.indexOf('C') < a.order.indexOf('A'));
  const costs = r2.alternatives.map(a => a.totalCost);
  assert.deepStrictEqual(costs, costs.slice().sort((x, y) => x - y));
  assert.strictEqual(new Set(r2.alternatives.map(a => a.order.join())).size, 3);
}

/* 51. 单段上限对每条备选逐段生效；上限导致全部无解时仍走上限诊断 */
{
  const scenes = [
    S('A', ['桌', '椅']),
    S('B', ['桌', '椅', '灯']),
    S('C', ['树']),
  ];
  const r = solve(scenes, C(), { alternatives: 3, opLimit: 3 });
  assert.strictEqual(r.ok, true);
  // 含 4 件换景的排列被排除：只剩 2 条可行
  assert.strictEqual(r.alternatives.length, 2);
  for (const a of r.alternatives) {
    for (const s of a.steps) assert.ok(s.count <= 3);
  }
  assert.deepStrictEqual(r.alternatives.map(a => a.order), [['C', 'A', 'B'], ['B', 'A', 'C']]);

  const bad = solve(scenes, C(), { alternatives: 3, opLimit: 2 });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.conflict.type, 'prop-limit-infeasible');
  assert.strictEqual(bad.conflict.minRequiredLimit, 3);
}

/* 52. timed 备选：先按可选场景价值降序、再按操作总数升序；可跨不同入选子集 */
{
  const scenes = [
    T('A', ['x'], 10, true, 0),
    T('B', ['x'], 10, false, 5),
    T('C', ['y'], 10, false, 8),
  ];
  const r = solve(scenes, C(), { mode: 'timed', timeLimit: 20, alternatives: 3 });
  assert.strictEqual(r.ok, true);
  // 价值 8 的两条顺序（A-C 与 C-A，代价均 3）在前；其后才是价值 5 的 A-B（代价 1）
  assert.deepStrictEqual(r.alternatives.map(a => a.totalValue), [8, 8, 5]);
  assert.deepStrictEqual(r.alternatives.map(a => a.totalCost), [3, 3, 1]);
  assert.deepStrictEqual(r.alternatives.map(a => a.order), [['A', 'C'], ['C', 'A'], ['A', 'B']]);
  assert.deepStrictEqual(r.alternatives[0].excludedIds, ['B']);
  assert.deepStrictEqual(r.alternatives[2].excludedIds, ['C']);
  assert.strictEqual(r.totalValue, 8);
  assert.strictEqual(r.usedDuration, r.alternatives[0].usedDuration);
}

/* 53. timed 完全同分：同子集同代价的不同排列按录入顺序字典序稳定排序 */
{
  // 全部场景道具相同、时长相同：价值恒为 B+C=6，代价恒为开场 0
  const scenes = [
    T('A', [], 5, true, 0),
    T('B', [], 5, false, 3),
    T('C', [], 5, false, 3),
  ];
  const r = solve(scenes, C(), { mode: 'timed', timeLimit: 15, alternatives: 3 });
  assert.strictEqual(r.alternatives.length, 3);
  for (const a of r.alternatives) {
    assert.strictEqual(a.totalValue, 6);
    assert.strictEqual(a.totalCost, 0);
    assert.strictEqual(a.usedDuration, 15);
  }
  assert.deepStrictEqual(r.alternatives.map(a => a.order), [
    ['A', 'B', 'C'], ['A', 'C', 'B'], ['B', 'A', 'C'],
  ]);
}

/* 54. timed 备选不超时、不含未入选必演，且固定序位按入选序列计算 */
{
  const scenes = [
    T('A', [], 5, true, 0),
    T('B', [], 5, false, 10),
    T('C', [], 5, false, 1),
    T('D', [], 5, true, 0),
  ];
  // 上限 15：必演 A、D 外只能再带 1 个可选；价值 10 的 B 入选，C 舍弃。
  // {D,B,A} 与 {B,D,A}？D 的序位无固定；枚举可行排列取前 3
  const r = solve(scenes, C({ fixedPositions: [{ sceneId: 'C', position: 2 }] }),
    { mode: 'timed', timeLimit: 15, alternatives: 3 });
  assert.strictEqual(r.ok, true);
  for (const a of r.alternatives) {
    assert.ok(a.usedDuration <= 15);
    assert.ok(a.order.includes('A') && a.order.includes('D'));
    assert.ok(!a.order.includes('C')); // C 的固定第 2 位随其舍弃而失效，且选 C 价值更低
    assert.strictEqual(a.totalValue, 10);
  }
}

/* 55. 备选请求 3 条但只有空节目单可行：返回 1 条空编排 */
{
  const scenes = [T('Z', ['x', 'y', 'z'], 10, false, 5)];
  const r = solve(scenes, C(), { mode: 'timed', timeLimit: 5, opLimit: 1, alternatives: 3 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.alternatives.length, 1);
  assert.deepStrictEqual(r.alternatives[0].order, []);
  assert.deepStrictEqual(r.alternatives[0].steps, []);
  assert.strictEqual(r.alternatives[0].totalCost, 0);
  assert.strictEqual(r.alternatives[0].remainingDuration, 5);
}

/* 56. 12 场景备选性能冒烟（3 条，classic 与 timed 均应远小于 1 秒） */
{
  const scenes = [];
  for (let i = 0; i < 12; i++) scenes.push(S(`S${i}`, [`p${i}`, `p${i + 1}`]));
  let t0 = Date.now();
  const rc = solve(scenes, C({
    dependencies: [{ before: 'S0', after: 'S11' }],
    fixedPositions: [{ sceneId: 'S5', position: 6 }],
    forbiddenAdjacencies: [{ a: 'S1', b: 'S2' }],
  }), { alternatives: 3 });
  assert.ok(Date.now() - t0 < 1000);
  assert.strictEqual(rc.alternatives.length, 3);
  assert.strictEqual(new Set(rc.alternatives.map(a => a.order.join())).size, 3);

  const tscenes = scenes.map((s, i) => T(s.id, s.props, 5, i < 3, i));
  t0 = Date.now();
  const rt = solve(tscenes, C({
    dependencies: [{ before: 'S0', after: 'S11' }],
    fixedPositions: [{ sceneId: 'S5', position: 6 }],
    forbiddenAdjacencies: [{ a: 'S1', b: 'S2' }],
  }), { mode: 'timed', timeLimit: 60, alternatives: 3 });
  assert.ok(Date.now() - t0 < 1000);
  assert.strictEqual(rt.alternatives.length, 3);
  for (const a of rt.alternatives) assert.ok(a.usedDuration <= 60);
}

console.log('全部测试通过 ✔');

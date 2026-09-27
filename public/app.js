'use strict';

/* ================= 状态 ================= */
const MAX_SCENES = 12;
const MAX_PACK_ITEMS = 14;
let uidCounter = 0;
const uid = () => `s${Date.now().toString(36)}_${uidCounter++}`;

const state = {
  planId: null,
  mode: 'classic', // 'classic' | 'timed'
  timeLimit: 120,
  opLimit: null, // 单段道具操作上限（件）；null 表示不限
  alternatives: 1, // 一次请求的备选节目单条数（1..3）；1 表示只要原有单条结果
  scenes: [], // classic: { id, name, props }；timed 额外带 { duration, required, value }
  constraints: { dependencies: [], fixedPositions: [], forbiddenAdjacencies: [] },
  live: null, // 最近一次求解/重排结果（当前节目单）
  replan: null, // 演出中重排会话：{ prefixIds, chainStartOrder, kDraft, stageProps }
  savedReplan: null, // 随方案保存的重排状态（载入后用于自动恢复）
  packing: null, // 巡演装箱配置：{ capacity, weights: { 道具名: 重量 }, pairs: [{ a, b }] }
};

const isTimed = () => state.mode === 'timed';

const $ = (sel) => document.querySelector(sel);
const sceneName = (id) => {
  const s = state.scenes.find(x => x.id === id);
  return s ? s.name : '（已删除）';
};
const sceneById = (id) => state.scenes.find(x => x.id === id) || null;

/* ================= 场景编辑 ================= */
function renderSceneHead() {
  const thead = $('#scene-thead');
  thead.innerHTML = '';
  const tr = document.createElement('tr');
  const cells = ['<th class="col-idx">#</th>', '<th>场景名称</th>', '<th>道具（用逗号分隔）</th>'];
  if (isTimed()) {
    cells.push('<th class="col-dur">时长(分)</th>', '<th class="col-req">必演</th>', '<th class="col-val">可选价值</th>');
  }
  cells.push('<th class="col-op"></th>');
  tr.innerHTML = cells.join('');
  thead.appendChild(tr);
}

function renderScenes() {
  renderSceneHead();
  const tbody = $('#scene-tbody');
  tbody.innerHTML = '';
  state.scenes.forEach((s, i) => {
    const tr = document.createElement('tr');

    const tdIdx = document.createElement('td');
    tdIdx.textContent = i + 1;

    const tdName = document.createElement('td');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'scene-name';
    nameInput.value = s.name;
    nameInput.placeholder = `场景 ${i + 1}`;
    nameInput.addEventListener('input', () => {
      s.name = nameInput.value;
      renderConstraintForms(); // 名称变化同步到下拉框
    });
    tdName.appendChild(nameInput);

    const tdProps = document.createElement('td');
    const propsInput = document.createElement('input');
    propsInput.type = 'text';
    propsInput.className = 'scene-props';
    propsInput.value = s.props.join(', ');
    propsInput.placeholder = '如：长桌, 椅子, 烛台';
    propsInput.addEventListener('input', () => {
      s.props = propsInput.value.split(/[,，]/).map(x => x.trim()).filter(Boolean);
      renderPacking(); // 道具变化同步到装箱清单（不重建本输入框，不打断输入）
    });
    tdProps.appendChild(propsInput);

    const tds = [tdIdx, tdName, tdProps];

    if (isTimed()) {
      const tdDur = document.createElement('td');
      const durInput = document.createElement('input');
      durInput.type = 'number';
      durInput.className = 'scene-duration';
      durInput.min = '0';
      durInput.step = '1';
      durInput.value = s.duration ?? 0;
      durInput.addEventListener('input', () => {
        s.duration = Math.max(0, Math.floor(Number(durInput.value) || 0));
        updateRequiredHint();
      });
      tdDur.appendChild(durInput);

      const tdReq = document.createElement('td');
      const reqBox = document.createElement('input');
      reqBox.type = 'checkbox';
      reqBox.className = 'scene-required';
      reqBox.checked = !!s.required;
      reqBox.title = '勾选后该场景为必演项';
      reqBox.addEventListener('change', () => {
        s.required = reqBox.checked;
        if (s.required) {
          s.value = 0;
          valInput.value = 0;
        }
        valInput.disabled = s.required;
        valInput.title = s.required ? '必演场景不参与可选价值统计' : '入选时获得的价值';
        updateRequiredHint();
      });
      tdReq.appendChild(reqBox);

      const tdVal = document.createElement('td');
      const valInput = document.createElement('input');
      valInput.type = 'number';
      valInput.className = 'scene-value';
      valInput.min = '0';
      valInput.step = '1';
      valInput.value = s.value ?? 0;
      valInput.disabled = !!s.required;
      valInput.title = s.required ? '必演场景不参与可选价值统计' : '入选时获得的价值';
      valInput.addEventListener('input', () => {
        s.value = Math.max(0, Math.floor(Number(valInput.value) || 0));
      });
      tdVal.appendChild(valInput);

      tds.push(tdDur, tdReq, tdVal);
    }

    const tdOp = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'btn btn-sm btn-danger';
    del.textContent = '删除';
    del.addEventListener('click', () => {
      if (state.replan && !confirm('删除场景将取消当前演出中重排进度，确定继续？')) return;
      state.scenes.splice(i, 1);
      // 清理引用该场景的约束
      const c = state.constraints;
      c.dependencies = c.dependencies.filter(d => d.before !== s.id && d.after !== s.id);
      c.fixedPositions = c.fixedPositions.filter(f => f.sceneId !== s.id);
      c.forbiddenAdjacencies = c.forbiddenAdjacencies.filter(f => f.a !== s.id && f.b !== s.id);
      state.live = null;
      state.replan = null;
      renderAll();
    });
    tdOp.appendChild(del);
    tds.push(tdOp);

    tr.append(...tds);
    tbody.appendChild(tr);
  });

  $('#scene-count').textContent = `共 ${state.scenes.length} / ${MAX_SCENES} 个场景`;
  $('#btn-add-scene').disabled = state.scenes.length >= MAX_SCENES;
  updateRequiredHint();
}

function updateRequiredHint() {
  if (!isTimed()) return;
  const total = state.scenes.reduce((acc, s) => acc + (s.required ? (s.duration || 0) : 0), 0);
  const el = $('#required-duration-hint');
  el.textContent = `必演场景共 ${state.scenes.filter(s => s.required).length} 个，合计 ${total} 分钟（上限 ${state.timeLimit} 分钟）`;
  el.classList.toggle('hint-over', total > state.timeLimit);
}

/* ================= 单段道具操作上限 ================= */
function syncOpLimitUI() {
  const enabled = state.opLimit !== null;
  const cb = $('#op-limit-enabled');
  cb.checked = enabled;
  $('#op-limit-fields').hidden = !enabled;
  $('#op-limit').value = enabled ? state.opLimit : 3;
  $('#op-limit').disabled = !enabled;
  $('#op-limit-hint').textContent = enabled
    ? `每段撤下 + 上台合计不得超过 ${state.opLimit} 件；求解器将在满足该上限的候选中按原目标选最优顺序。`
    : '不勾选时不限制每段的道具操作件数。';
}

/* ================= 模式切换 ================= */
function applyMode(mode) {
  state.mode = mode;
  document.querySelectorAll('input[name="mode"]').forEach(r => { r.checked = r.value === mode; });
  $('#timed-settings').hidden = !isTimed();
  $('#constraint-mode-hint').textContent = isTimed()
    ? '未入选场景不参与约束；固定序位按入选后的演出序列计算。'
    : '';
  if (isTimed()) {
    state.scenes.forEach(s => {
      if (s.duration === undefined) s.duration = 0;
      if (s.value === undefined) s.value = 0;
      if (s.required === undefined) s.required = false;
    });
  }
  $('#result-card').hidden = true;
  state.live = null;
  state.replan = null;
  syncOpLimitUI();
  renderAll();
}

/* ================= 约束编辑 ================= */
function fillSelect(sel, selectedId) {
  sel.innerHTML = '';
  for (const s of state.scenes) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name || '(未命名)';
    sel.appendChild(opt);
  }
  if (selectedId && state.scenes.some(s => s.id === selectedId)) sel.value = selectedId;
}

function renderConstraintForms() {
  fillSelect($('#dep-form [data-role="before"]'));
  fillSelect($('#dep-form [data-role="after"]'));
  fillSelect($('#fixed-form [data-role="scene"]'));
  fillSelect($('#noadj-form [data-role="a"]'));
  fillSelect($('#noadj-form [data-role="b"]'));
  const posInput = $('#fixed-form [data-role="position"]');
  posInput.max = Math.max(1, state.scenes.length);
  renderConstraintLists();
}

function renderConstraintLists() {
  const depList = $('#dep-list');
  depList.innerHTML = '';
  state.constraints.dependencies.forEach((d, i) => {
    depList.appendChild(constraintItem(
      `「${sceneName(d.before)}」必须在「${sceneName(d.after)}」之前`,
      () => { state.constraints.dependencies.splice(i, 1); renderConstraintLists(); }
    ));
  });

  const fixedList = $('#fixed-list');
  fixedList.innerHTML = '';
  state.constraints.fixedPositions.forEach((f, i) => {
    fixedList.appendChild(constraintItem(
      `「${sceneName(f.sceneId)}」固定在第 ${f.position} 位`,
      () => { state.constraints.fixedPositions.splice(i, 1); renderConstraintLists(); }
    ));
  });

  const noadjList = $('#noadj-list');
  noadjList.innerHTML = '';
  state.constraints.forbiddenAdjacencies.forEach((f, i) => {
    noadjList.appendChild(constraintItem(
      `「${sceneName(f.a)}」与「${sceneName(f.b)}」禁止相邻`,
      () => { state.constraints.forbiddenAdjacencies.splice(i, 1); renderConstraintLists(); }
    ));
  });
}

function constraintItem(text, onRemove) {
  const li = document.createElement('li');
  const span = document.createElement('span');
  span.textContent = text;
  const del = document.createElement('button');
  del.className = 'btn btn-sm btn-danger';
  del.textContent = '✕';
  del.addEventListener('click', onRemove);
  li.append(span, del);
  return li;
}

function renderAll() {
  renderScenes();
  renderConstraintForms();
  renderPacking();
}

/* ================= 巡演装箱 ================= */
/** 从当前场景道具汇总去重待运输道具（保持场景序、场景内顺序）。 */
let lastPackingItemsKey = null;
function collectPackingItems() {
  const seen = new Set();
  const out = [];
  for (const s of state.scenes) {
    for (const p of s.props || []) {
      const name = String(p).trim();
      if (name && !seen.has(name)) { seen.add(name); out.push(name); }
    }
  }
  return out;
}

function defaultPacking() {
  return { capacity: 10, weights: {}, pairs: [] };
}

/**
 * 按当前场景道具校对装箱配置：为新道具补默认重量 1；
 * 删除已不存在的重量，清理引用了已删除道具的互斥对。
 */
function reconcilePacking(items) {
  if (!state.packing) state.packing = defaultPacking();
  const set = new Set(items);
  const weights = {};
  for (const name of items) {
    const w = Number(state.packing.weights[name]);
    weights[name] = (Number.isInteger(w) && w > 0) ? w : 1;
  }
  state.packing.weights = weights;
  state.packing.pairs = state.packing.pairs.filter(p => set.has(p.a) && set.has(p.b));
  const cap = Number(state.packing.capacity);
  if (!Number.isInteger(cap) || cap <= 0) state.packing.capacity = 10;
}

function renderPacking() {
  const items = collectPackingItems();
  reconcilePacking(items);
  const over = items.length > MAX_PACK_ITEMS;

  // 道具集合变化后，旧的装箱结果即失效
  const itemsKey = items.join('\u0001');
  if (itemsKey !== lastPackingItemsKey) {
    lastPackingItemsKey = itemsKey;
    clearPackingResult();
  }

  $('#pack-capacity').value = state.packing.capacity;
  $('#packing-count').textContent = items.length
    ? `待运输道具 ${items.length} / ${MAX_PACK_ITEMS} 件（由各场景道具汇总去重生成）`
    : '当前场景还没有任何道具，请先在第 1 节录入场景与道具';
  $('#packing-count').classList.toggle('hint-over', over);
  if (over) {
    $('#packing-count').textContent += `；已超过 ${MAX_PACK_ITEMS} 件上限，无法装箱，请减少道具种类`;
  }

  const tbody = $('#packing-tbody');
  tbody.innerHTML = '';
  items.forEach((name, i) => {
    const tr = document.createElement('tr');

    const tdIdx = document.createElement('td');
    tdIdx.textContent = i + 1;

    const tdName = document.createElement('td');
    tdName.textContent = name;
    if (state.packing.weights[name] > state.packing.capacity) tdName.classList.add('pack-overweight');

    const tdW = document.createElement('td');
    const wInput = document.createElement('input');
    wInput.type = 'number';
    wInput.className = 'pack-weight';
    wInput.min = '1';
    wInput.step = '1';
    wInput.value = state.packing.weights[name];
    wInput.addEventListener('input', () => {
      state.packing.weights[name] = Math.max(0, Math.floor(Number(wInput.value) || 0));
      clearPackingResult();
      // 只就地更新本行高亮，不重建表格（避免输入框失焦）
      tdName.classList.toggle('pack-overweight', state.packing.weights[name] > state.packing.capacity);
    });
    tdW.appendChild(wInput);

    tr.append(tdIdx, tdName, tdW);
    tbody.appendChild(tr);
  });

  fillPackPairSelects();
  renderPackPairs(items);
  $('#btn-pack').disabled = items.length === 0 || over;
  $('#btn-add-packpair').disabled = items.length < 2;
}

/** 只刷新道具名上的"单件超重"高亮（不重建承重输入框，避免打断输入焦点）。 */
function refreshPackOverweight() {
  const items = collectPackingItems();
  $('#packing-tbody').querySelectorAll('tr').forEach((tr, i) => {
    const nameCell = tr.children[1];
    if (nameCell) nameCell.classList.toggle('pack-overweight', state.packing.weights[items[i]] > state.packing.capacity);
  });
}

function fillPackPairSelects() {
  const items = collectPackingItems();
  for (const role of ['a', 'b']) {
    const sel = $(`#packpair-form [data-role="${role}"]`);
    const prev = sel.value;
    sel.innerHTML = '';
    for (const name of items) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }
    if (items.includes(prev)) sel.value = prev;
    else if (role === 'b' && items.length > 1) sel.value = items[1];
  }
}

function renderPackPairs(items) {
  const list = $('#packpair-list');
  list.innerHTML = '';
  if (!state.packing.pairs.length) {
    const li = document.createElement('li');
    const none = document.createElement('span');
    none.className = 'hint';
    none.textContent = '暂无互斥道具对';
    li.appendChild(none);
    list.appendChild(li);
    return;
  }
  const indexOf = (n) => items.indexOf(n);
  const sorted = state.packing.pairs
    .map((p, i) => ({ p, i, k: Math.min(indexOf(p.a), indexOf(p.b)) * 1000 + Math.max(indexOf(p.a), indexOf(p.b)) }))
    .sort((x, y) => x.k - y.k);
  for (const { p, i } of sorted) {
    list.appendChild(constraintItem(
      `「${p.a}」与「${p.b}」不能同箱`,
      () => { state.packing.pairs.splice(i, 1); clearPackingResult(); renderPacking(); }
    ));
  }
}

function clearPackingResult() {
  $('#packing-result').innerHTML = '';
}

function packingPayload() {
  const items = collectPackingItems();
  const weights = {};
  for (const name of items) weights[name] = state.packing.weights[name];
  return {
    scenes: payload().scenes,
    packing: {
      capacity: state.packing.capacity,
      weights,
      pairs: state.packing.pairs.slice(),
    },
  };
}

async function doPack() {
  const data = await api('/api/pack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(packingPayload()),
  });
  renderPackingResult(data);
}

function renderPackingResult(data) {
  const box = $('#packing-result');
  box.innerHTML = '';
  if (data.errors) { box.appendChild(errorBlock(data.errors)); return; }
  if (!data.ok) {
    box.appendChild(errorBlock(data.errors && data.errors.length ? data.errors : ['装箱失败，请检查重量与承重配置']));
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'pack-result';

  const summary = document.createElement('div');
  summary.className = 'timed-summary';
  summary.innerHTML =
    `<span>总箱数：<strong>${data.totalBins}</strong> 箱</span>` +
    `<span>道具总重量：<strong>${data.totalWeight}</strong></span>` +
    `<span>单箱承重：${data.capacity}</span>`;
  wrap.appendChild(summary);

  data.bins.forEach((bin, i) => {
    const card = document.createElement('div');
    card.className = 'pack-bin';
    const head = document.createElement('div');
    head.className = 'pack-bin-head';
    const usage = bin.weight >= data.capacity
      ? '<span class="cap-badge cap-at">满载</span>'
      : `<span class="cap-badge cap-under">余 ${data.capacity - bin.weight}</span>`;
    head.innerHTML =
      `<span class="pack-bin-title">📦 第 ${i + 1} 箱</span>` +
      `<span>${bin.items.length} 件 ｜ 重量 <strong>${bin.weight}</strong> / ${data.capacity}</span>` +
      usage;
    card.appendChild(head);

    const chips = document.createElement('div');
    chips.className = 'pack-bin-items';
    bin.items.forEach((name, j) => {
      if (j > 0) {
        const comma = document.createElement('span');
        comma.className = 'hint';
        comma.textContent = '、';
        chips.appendChild(comma);
      }
      const chip = document.createElement('span');
      chip.className = 'pack-item-chip';
      chip.textContent = `${name}（${weightOf(data, name)}）`;
      chips.appendChild(chip);
    });
    card.appendChild(chips);
    wrap.appendChild(card);
  });

  box.appendChild(wrap);
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function weightOf(data, name) {
  const it = (data.items || []).find(x => x.name === name);
  return it ? it.weight : '';
}

/* ================= 求解 ================= */
function payload() {
  const base = {
    mode: state.mode,
    scenes: state.scenes.map(s => {
      const out = { id: s.id, name: s.name.trim(), props: s.props };
      if (isTimed()) {
        out.duration = s.duration || 0;
        out.required = !!s.required;
        out.value = s.required ? 0 : (s.value || 0);
      }
      return out;
    }),
    constraints: state.constraints,
  };
  if (isTimed()) base.timeLimit = state.timeLimit;
  if (state.opLimit !== null) base.opLimit = state.opLimit;
  if (state.alternatives > 1) base.alternatives = state.alternatives;
  return base;
}

async function api(url, options) {
  const res = await fetch(url, options);
  return res.json();
}

function showStatus(msg, isError) {
  const el = $('#status-line');
  el.textContent = msg;
  el.style.color = isError ? '#ffb3b0' : '';
}

async function doSolve() {
  $('#result-card').hidden = true;
  const data = await api('/api/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload()),
  });
  // 重新求解会取消演出中重排会话
  state.live = data.ok ? data : null;
  state.replan = null;
  renderResult(data);
}

function renderResult(data) {
  const box = $('#result');
  box.innerHTML = '';
  $('#result-card').hidden = false;

  if (data.errors) {
    box.appendChild(errorBlock(data.errors));
    return;
  }
  if (!data.ok) {
    box.appendChild(conflictBlock(data.conflict, data.reason === 'required-overtime'));
    return;
  }
  const isReplan = !!data.replanned;
  if (isReplan) box.appendChild(comparisonBlock(data));
  if (data.alternatives && data.alternatives.length > 1) {
    box.appendChild(alternativesOverviewBlock(data));
  }
  box.appendChild(data.mode === 'timed' ? timedResultBlock(data) : resultBlock(data));
  if (data.alternatives && data.alternatives.length > 1) {
    box.appendChild(alternativesListBlock(data));
  }
  box.appendChild(replanPanelBlock(data));
  $('#result-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ================= 演出中重排 ================= */
function plannedPropsOf(id) {
  const s = sceneById(id);
  return s ? s.props.slice() : [];
}

function startReplanSession(data) {
  const prefix = state.replan && state.replan.prefixIds
    ? state.replan.prefixIds
    : (data.prefixIds || []);
  state.replan = {
    prefixIds: prefix.slice(),
    chainStartOrder: (state.replan && state.replan.chainStartOrder)
      ? state.replan.chainStartOrder.slice()
      : (data.originalOrder && data.originalOrder.length ? data.originalOrder.slice() : data.order.slice()),
    kDraft: prefix.length,
    stageProps: (state.replan && state.replan.stageProps) ? state.replan.stageProps.slice() : [],
  };
}

function replanPanelBlock(data) {
  if (!state.replan) startReplanSession(data);
  const rp = state.replan;
  const prefixLen = rp.prefixIds.length;
  const wrap = document.createElement('div');
  wrap.className = 'replan-panel';

  const h = document.createElement('h3');
  h.textContent = '🎬 演出中重排';
  wrap.appendChild(h);

  const intro = document.createElement('p');
  intro.className = 'hint';
  intro.textContent = prefixLen
    ? `当前已确认完成前 ${prefixLen} 个场景（顺序不可改变），只能在其后续继续确认前缀。`
    : '从当前节目单确认已完成的连续前缀，并录入此刻舞台上的实际道具（含计划外道具），系统只重排剩余场景。';
  wrap.appendChild(intro);

  // 前缀确认：点击序号
  const kRow = document.createElement('div');
  kRow.className = 'replan-krow';
  const kLabel = document.createElement('span');
  kLabel.textContent = '已完成到第';
  kRow.appendChild(kLabel);
  const select = document.createElement('select');
  select.className = 'replan-k';
  for (let k = prefixLen; k <= data.order.length; k++) {
    const opt = document.createElement('option');
    opt.value = String(k);
    opt.textContent = k === 0 ? '0（尚未开始）' : String(k);
    if (k === rp.kDraft) opt.selected = true;
    select.appendChild(opt);
  }
  kRow.appendChild(select);
  const kAfter = document.createElement('span');
  kAfter.textContent = '位';
  kRow.appendChild(kAfter);
  wrap.appendChild(kRow);

  // 前缀预览
  const preview = document.createElement('div');
  preview.className = 'replan-prefix-preview';
  const previewOrder = data.order.slice(0, rp.kDraft);
  preview.appendChild(flowBlock(previewOrder, previewOrder.length));
  wrap.appendChild(preview);

  // 舞台实际道具
  const propsRow = document.createElement('label');
  propsRow.className = 'replan-props-row';
  propsRow.innerHTML = '<span>当前舞台实际道具：</span>';
  const propsInput = document.createElement('input');
  propsInput.type = 'text';
  propsInput.className = 'replan-props-input';
  propsInput.placeholder = '逗号分隔，如：长桌, 椅子, 备用话筒';
  propsInput.value = rp.stageProps.join(', ');
  propsRow.appendChild(propsInput);
  wrap.appendChild(propsRow);

  const fillBtn = document.createElement('button');
  fillBtn.className = 'btn btn-sm btn-ghost';
  fillBtn.textContent = '↺ 取第 K 个场景的计划道具';
  fillBtn.style.marginLeft = '0';
  fillBtn.addEventListener('click', () => {
    if (rp.kDraft === 0) {
      propsInput.value = '';
      rp.stageProps = [];
      return;
    }
    const id = data.order[rp.kDraft - 1];
    const ps = plannedPropsOf(id);
    propsInput.value = ps.join(', ');
    rp.stageProps = ps.slice();
  });
  wrap.appendChild(fillBtn);

  const doBtn = document.createElement('button');
  doBtn.className = 'btn btn-primary';
  doBtn.style.marginTop = '10px';
  doBtn.textContent = '🔀 只重排剩余场景';
  if (rp.kDraft >= data.order.length) {
    doBtn.disabled = true;
    doBtn.title = '全部场景均已完成，无需重排';
  }
  wrap.appendChild(doBtn);

  const msg = document.createElement('div');
  msg.className = 'replan-msg';
  wrap.appendChild(msg);

  select.addEventListener('change', () => {
    rp.kDraft = Number(select.value);
    wrap.replaceWith(replanPanelBlock(data));
  });
  propsInput.addEventListener('input', () => {
    rp.stageProps = propsInput.value.split(/[,，]/).map(x => x.trim()).filter(Boolean);
  });
  doBtn.addEventListener('click', () => doReplan(data, doBtn, msg));

  return wrap;
}

async function doReplan(data, btn, msgEl) {
  const rp = state.replan;
  const prefixIds = data.order.slice(0, rp.kDraft);
  const bodyObj = payload();
  bodyObj.replan = {
    prefixIds,
    stageProps: rp.stageProps,
    originalOrder: data.order,
  };
  btn.disabled = true;
  msgEl.textContent = '重排中…';
  msgEl.classList.remove('replan-error');
  const res = await api('/api/replan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
  btn.disabled = false;

  if (res.errors) {
    msgEl.textContent = res.errors.join('；');
    msgEl.classList.add('replan-error');
    return;
  }
  if (!res.ok) {
    msgEl.innerHTML = '';
    msgEl.classList.add('replan-error');
    const box = document.createElement('div');
    box.className = 'conflict-box';
    box.appendChild(conflictContent(res.conflict, res.conflict && res.conflict.type === 'required-overtime'));
    msgEl.appendChild(box);
    return;
  }

  // 重排成功：更新会话（前缀不可缩短），用链式起点做累计对比
  state.replan = {
    prefixIds,
    chainStartOrder: rp.chainStartOrder.slice(),
    kDraft: prefixIds.length,
    stageProps: rp.stageProps.slice(),
  };
  state.live = res;
  renderResult(res);
}

function comparisonBlock(data) {
  const wrap = document.createElement('div');
  wrap.className = 'replan-compare';

  const h = document.createElement('h3');
  h.textContent = '🔀 重排结果对比';
  wrap.appendChild(h);

  const cols = document.createElement('div');
  cols.className = 'replan-cols';

  // 原计划（参照）
  const colOld = document.createElement('div');
  colOld.className = 'replan-col replan-col-old';
  const oldTitle = document.createElement('div');
  oldTitle.className = 'replan-col-title';
  oldTitle.textContent = '原计划';
  colOld.appendChild(oldTitle);
  colOld.appendChild(flowBlock(data.originalOrder || data.order, 0, true));
  cols.appendChild(colOld);

  // 新计划（前缀 + 新后缀）
  const colNew = document.createElement('div');
  colNew.className = 'replan-col replan-col-new';
  const newTitle = document.createElement('div');
  newTitle.className = 'replan-col-title';
  newTitle.textContent = '前缀（已完成，不可改）＋ 新后缀';
  colNew.appendChild(newTitle);
  colNew.appendChild(flowBlock(data.order, data.prefixIds.length));
  cols.appendChild(colNew);

  wrap.appendChild(cols);

  // 账目
  const stats = document.createElement('div');
  stats.className = 'replan-stats';
  const fmtDelta = (d) => {
    if (d === null || d === undefined) return '—';
    if (d < 0) return `<span class="delta-down">减少 ${-d}</span>`;
    if (d > 0) return `<span class="delta-up">增加 ${d}</span>`;
    return '<span class="delta-flat">不变（0）</span>';
  };
  const lines = [];
  if (data.originalTailCost !== null && data.originalTailCost !== undefined) {
    lines.push(`<span>原计划后缀代价：<strong>${data.originalTailCost}</strong></span>`);
    lines.push(`<span>新后缀代价：<strong>${data.suffixCost}</strong></span>`);
  }
  if (data.costDelta !== null && data.costDelta !== undefined) {
    lines.push(`<span>整场代价变动：${fmtDelta(data.costDelta)}（原 ${data.originalTotalCost} → 新 ${data.totalCost}）</span>`);
  }
  if (data.mode === 'timed' && data.valueDelta !== null && data.valueDelta !== undefined) {
    const vd = data.valueDelta;
    const vtxt = vd < 0
      ? `<span class="delta-down">减少 ${-vd}</span>`
      : vd > 0 ? `<span class="delta-up">增加 ${vd}</span>` : '<span class="delta-flat">不变（0）</span>';
    lines.push(`<span>入选可选价值变动：${vtxt}（${data.originalTotalValue} → ${data.totalValue}；已完成前缀价值 ${data.prefixValue} 已计入）</span>`);
    lines.push(`<span>时长：前缀已用 ${data.prefixDuration} + 后缀 ${data.suffixDuration} = ${data.usedDuration} / ${data.timeLimit} 分钟（剩余 ${data.remainingDuration}）</span>`);
  }
  stats.innerHTML = lines.join('');
  wrap.appendChild(stats);

  // 舍弃 / 新增场景
  const changed = document.createElement('div');
  changed.className = 'replan-changes';
  const chipLine = (title, ids, cls) => {
    const div = document.createElement('div');
    div.className = 'replan-change-line ' + (cls || '');
    const lab = document.createElement('span');
    lab.className = 'replan-change-label';
    lab.textContent = title;
    div.appendChild(lab);
    if (!ids.length) {
      const none = document.createElement('span');
      none.className = 'hint';
      none.textContent = '无';
      div.appendChild(none);
    } else {
      ids.forEach(id => {
        const c = document.createElement('span');
        c.className = 'change-chip ' + (cls || '');
        c.textContent = sceneName(id);
        div.appendChild(c);
      });
    }
    return div;
  };
  changed.appendChild(chipLine('被舍弃：', data.droppedScenes || [], 'change-drop'));
  changed.appendChild(chipLine('新增入选：', data.addedScenes || [], 'change-add'));
  wrap.appendChild(changed);

  return wrap;
}

function errorBlock(errors) {
  const div = document.createElement('div');
  div.className = 'conflict-box';
  const h = document.createElement('h3');
  h.textContent = '输入有误';
  const ul = document.createElement('ul');
  ul.className = 'error-list';
  for (const e of errors) {
    const li = document.createElement('li');
    li.textContent = e;
    ul.appendChild(li);
  }
  div.append(h, ul);
  return div;
}

function conflictBlock(conflict, isOvertime) {
  const div = document.createElement('div');
  div.className = 'conflict-box';
  div.appendChild(conflictContent(conflict, isOvertime));
  return div;
}

function conflictContent(conflict, isOvertime) {
  const frag = document.createDocumentFragment();
  const h = document.createElement('h3');
  if (conflict.type === 'prefix-conflict') {
    h.textContent = '⚠ 已完成前缀与约束冲突';
  } else if (conflict.type === 'prop-limit-infeasible') {
    h.textContent = '⚠ 无解：单段道具操作上限过低';
  } else {
    h.textContent = isOvertime ? '⚠ 无解：必演场景已超时' : '⚠ 无解：约束相互冲突';
  }
  const p = document.createElement('p');
  p.textContent = conflict.message;
  frag.append(h, p);

  // 前缀冲突：逐条具体冲突（跨前缀依赖、固定序位、禁止相邻、超时等）
  if (Array.isArray(conflict.conflicts) && conflict.conflicts.length) {
    const ul = document.createElement('ul');
    for (const cf of conflict.conflicts) {
      const li = document.createElement('li');
      li.textContent = cf.message;
      ul.appendChild(li);
    }
    frag.appendChild(ul);
  }
  if (conflict.constraints && conflict.constraints.length) {
    const ul = document.createElement('ul');
    for (const c of conflict.constraints) {
      const li = document.createElement('li');
      li.textContent = c.text;
      ul.appendChild(li);
    }
    frag.appendChild(ul);
  }
  return frag;
}

function flowBlock(order, prefixLen, isReference) {
  const flow = document.createElement('div');
  flow.className = 'order-flow' + (isReference ? ' order-flow-ref' : '');
  if (!order.length) {
    const empty = document.createElement('span');
    empty.className = 'hint';
    empty.textContent = '（无入选场景，节目单为空）';
    flow.appendChild(empty);
    return flow;
  }
  order.forEach((id, i) => {
    if (i > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'order-arrow';
      arrow.textContent = '→';
      flow.appendChild(arrow);
    }
    const s = sceneById(id);
    const chip = document.createElement('span');
    let cls = 'order-chip';
    if (s && s.required) cls += ' order-chip-req';
    if (prefixLen && i < prefixLen) cls += ' order-chip-done';
    chip.className = cls;
    let label = `${i + 1}. ${sceneName(id)}`;
    if (s && s.required) label += ' ★必演';
    if (prefixLen && i === prefixLen - 1) label += ' ✅';
    chip.textContent = label;
    flow.appendChild(chip);
  });
  return flow;
}

function stepsBlock(data) {
  const frag = document.createDocumentFragment();
  const total = document.createElement('p');
  total.className = 'total-line';
  let totalHtml = `道具增减总次数：<strong>${data.totalCost}</strong> 次（含开场布置，下同）`;
  if (data.opLimit) {
    const maxUsed = data.steps.reduce((m, s) => Math.max(m, s.count), 0);
    totalHtml += `　<span class="cap-cap">单段上限 ${data.opLimit} 件，最大单段用量 ${maxUsed} 件</span>`;
  }
  total.innerHTML = totalHtml;
  frag.appendChild(total);

  const h = document.createElement('h3');
  h.textContent = '换景明细';
  frag.appendChild(h);

  const ul = document.createElement('ul');
  ul.className = 'step-list';
  data.steps.forEach((step, i) => {
    const li = document.createElement('li');
    if (step.phase) li.classList.add('step-' + step.phase);
    const title = document.createElement('div');
    title.className = 'step-title';
    const tag = step.phase === 'done'
      ? '<span class="phase-tag phase-done">已完成</span> '
      : step.phase === 'suffix'
        ? '<span class="phase-tag phase-suffix">待执行</span> '
        : '';
    if (step.type === 'setup') {
      title.innerHTML = `${tag}开场布置 →「${escapeHtml(sceneName(step.scene))}」`;
    } else if (step.fromStage) {
      title.innerHTML = `${tag}从当前舞台实际道具 →「${escapeHtml(sceneName(step.to))}」`;
    } else {
      title.innerHTML = `${tag}换景 ${i}：「${escapeHtml(sceneName(step.from))}」→「${escapeHtml(sceneName(step.to))}」`;
    }
    li.appendChild(title);

    const detail = document.createElement('div');
    const parts = [];
    if (step.removed.length) {
      parts.push(`<span class="prop-del">撤下：${escapeHtml(step.removed.join('、'))}</span>`);
    }
    if (step.added.length) {
      parts.push(`<span class="prop-add">上台：${escapeHtml(step.added.join('、'))}</span>`);
    }
    if (!parts.length) parts.push('<span class="prop-none">道具无变化</span>');
    let capTxt = '';
    // 单段上限只约束开场/待执行段；已完成前缀的段是历史事实，不做用量比对
    if (data.opLimit && step.phase !== 'done') {
      const cls = step.count >= data.opLimit ? 'cap-badge cap-at' : 'cap-badge cap-under';
      capTxt = `　<span class="${cls}">本段 ${step.count}/${data.opLimit} 件</span>`;
    }
    detail.innerHTML = parts.join('　｜　') + `　<span class="step-count">（${step.count} 次）</span>` + capTxt;
    li.appendChild(detail);
    ul.appendChild(li);
  });
  frag.appendChild(ul);
  return frag;
}

function resultBlock(data) {
  const frag = document.createDocumentFragment();
  if (data.alternatives && data.alternatives.length > 1) frag.appendChild(primaryPlanBadge(data.alternatives.length));
  const prefixLen = data.replanned ? (data.prefixIds || []).length : 0;
  frag.appendChild(flowBlock(data.order, prefixLen));
  frag.appendChild(stepsBlock(data));
  return frag;
}

function sceneListBlock(title, ids, cls) {
  const wrap = document.createElement('div');
  wrap.className = 'scene-pick ' + (cls || '');
  const h = document.createElement('h3');
  h.textContent = title;
  wrap.appendChild(h);
  if (!ids.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '无';
    wrap.appendChild(p);
    return wrap;
  }
  const ul = document.createElement('ul');
  ul.className = 'pick-list';
  ids.forEach(id => {
    const s = sceneById(id);
    const li = document.createElement('li');
    const tags = [];
    if (s) {
      tags.push(`${s.duration} 分钟`);
      if (s.required) tags.push('必演');
      else tags.push(`价值 ${s.value || 0}`);
    }
    li.innerHTML = `<strong>${escapeHtml(sceneName(id))}</strong><span class="hint">${escapeHtml(tags.join(' · '))}</span>`;
    ul.appendChild(li);
  });
  wrap.appendChild(ul);
  return wrap;
}

function timedResultBlock(data) {
  const frag = document.createDocumentFragment();

  if (data.alternatives && data.alternatives.length > 1) frag.appendChild(primaryPlanBadge(data.alternatives.length));

  const summary = document.createElement('div');
  summary.className = 'timed-summary';
  let html =
    `<span>入选可选场景价值：<strong>${data.totalValue}</strong></span>` +
    `<span>已用时长：<strong>${data.usedDuration}</strong> / ${data.timeLimit} 分钟</span>` +
    `<span>剩余时长：<strong>${data.remainingDuration}</strong> 分钟</span>` +
    `<span>道具增减：<strong>${data.totalCost}</strong> 次</span>`;
  if (data.replanned) {
    html = `<span>前缀已用：<strong>${data.prefixDuration}</strong> 分钟（价值 ${data.prefixValue}）</span>`
      + `<span>后缀可用：<strong>${data.timeBudget}</strong> 分钟</span>` + html;
  }
  summary.innerHTML = html;
  frag.appendChild(summary);

  const prefixLen = data.replanned ? (data.prefixIds || []).length : 0;
  frag.appendChild(flowBlock(data.order, prefixLen));
  frag.appendChild(sceneListBlock(`入选场景（${data.selectedIds.length} 个）`, data.selectedIds, 'pick-in'));
  frag.appendChild(sceneListBlock(`舍弃场景（${data.excludedIds.length} 个，不参与约束）`, data.excludedIds, 'pick-out'));
  frag.appendChild(stepsBlock(data));
  return frag;
}

/* ================= 备选节目单 ================= */

/** 主结果区（方案 1）的标记。 */
function primaryPlanBadge(total) {
  const div = document.createElement('div');
  div.className = 'alt-primary-badge';
  div.innerHTML = `方案 1 / ${total}　<strong>★ 最优方案（当前节目单）</strong>`;
  return div;
}

/** 取舍徽标：与第 1 条（最优）方案相比，代价 / 价值的增减。 */
function tradeoffSpans(base, alt, isTimedMode) {
  const spans = [];
  const dCost = alt.totalCost - base.totalCost;
  if (dCost === 0) {
    spans.push('<span class="delta-flat">道具操作与最优相同</span>');
  } else {
    spans.push(`<span class="delta-up">道具操作多 ${dCost} 件次</span>`);
  }
  if (isTimedMode) {
    const dVal = alt.totalValue - base.totalValue;
    if (dVal === 0) {
      spans.push('<span class="delta-flat">可选价值与最优相同</span>');
    } else {
      spans.push(`<span class="delta-down">可选价值少 ${-dVal}</span>`);
    }
  }
  return spans;
}

/** 方案概要条：共找到几条、排序规则说明。 */
function alternativesOverviewBlock(data) {
  const wrap = document.createElement('div');
  wrap.className = 'alt-overview';
  const total = data.alternatives.length;
  const rule = data.mode === 'timed'
    ? '排序规则：可选场景价值降序 → 道具操作总数升序；完全同分时按场景录入顺序。'
    : '排序规则：道具操作总数升序；完全同分时按场景录入顺序。';
  wrap.innerHTML =
    `<h3>📋 备选节目单（共 ${total} 条顺序不同的可行编排）</h3>`
    + `<p class="hint">下方方案 1 为最优方案（即当前节目单）；其余为满足全部约束与单段上限的备选。`
    + `${rule} 选中任一方案即可按该顺序进入演出中重排。</p>`;
  return wrap;
}

function compactChipLine(title, ids, cls) {
  const div = document.createElement('div');
  div.className = 'alt-chip-line';
  const lab = document.createElement('span');
  lab.className = 'replan-change-label';
  lab.textContent = title;
  div.appendChild(lab);
  if (!ids.length) {
    const none = document.createElement('span');
    none.className = 'hint';
    none.textContent = '无';
    div.appendChild(none);
  } else {
    ids.forEach(id => {
      const c = document.createElement('span');
      c.className = 'change-chip ' + (cls || '');
      c.textContent = sceneName(id);
      div.appendChild(c);
    });
  }
  return div;
}

/** 备选列表：方案 2..K（方案 1 已在上方主结果区完整展示）。 */
function alternativesListBlock(data) {
  const wrap = document.createElement('div');
  wrap.className = 'alt-list';
  const base = data.alternatives[0];

  for (const alt of data.alternatives) {
    if (alt.rank === 1) continue;
    const card = document.createElement('div');
    card.className = 'alt-card';

    const head = document.createElement('div');
    head.className = 'alt-card-head';
    const title = document.createElement('span');
    title.className = 'alt-card-title';
    title.innerHTML = `方案 ${alt.rank} <span class="hint">（对比方案 1）</span>`;
    head.appendChild(title);

    const adopt = document.createElement('button');
    adopt.className = 'btn btn-sm btn-primary';
    adopt.textContent = '✓ 采用此方案进入演出';
    adopt.addEventListener('click', () => adoptAlternative(data, alt));
    head.appendChild(adopt);
    card.appendChild(head);

    // 指标与取舍
    const metrics = document.createElement('div');
    metrics.className = 'alt-metrics';
    const parts = [];
    parts.push(`<span>道具增减：<strong>${alt.totalCost}</strong> 次</span>`);
    if (data.opLimit) {
      const maxUsed = alt.steps.reduce((m, s) => Math.max(m, s.count), 0);
      parts.push(`<span class="cap-cap">最大单段 ${maxUsed}/${data.opLimit} 件</span>`);
    }
    if (data.mode === 'timed') {
      parts.push(`<span>入选价值：<strong>${alt.totalValue}</strong></span>`);
      parts.push(`<span>时长：<strong>${alt.usedDuration}</strong>/${alt.timeLimit} 分钟（余 ${alt.remainingDuration}）</span>`);
    }
    parts.push(...tradeoffSpans(base, alt, data.mode === 'timed'));
    metrics.innerHTML = parts.join('');
    card.appendChild(metrics);

    // 顺序
    card.appendChild(flowBlock(alt.order, 0));

    // timed：入选 / 舍弃差异
    if (data.mode === 'timed') {
      const baseSet = new Set(base.selectedIds);
      const altSet = new Set(alt.selectedIds);
      const dropped = base.selectedIds.filter(id => !altSet.has(id));
      const added = alt.selectedIds.filter(id => !baseSet.has(id));
      if (dropped.length || added.length) {
        const changes = document.createElement('div');
        changes.className = 'alt-changes';
        changes.appendChild(compactChipLine('相对方案 1 舍弃：', dropped, 'change-drop'));
        changes.appendChild(compactChipLine('相对方案 1 新增：', added, 'change-add'));
        card.appendChild(changes);
      }
    }

    // 换景明细（可折叠）
    const det = document.createElement('details');
    det.className = 'alt-details';
    const sum = document.createElement('summary');
    sum.textContent = `换景明细（${alt.steps.length} 段）`;
    det.appendChild(sum);
    det.appendChild(stepsBlock(alt));
    card.appendChild(det);

    wrap.appendChild(card);
  }
  return wrap;
}

/**
 * 采用一条备选：以它的顺序替换当前节目单（顶层 live），随后可按该顺序
 * 进入现有演出中重排流程。采纳后不再保留其余备选展示。
 * 备选条目只含方案自身字段（rank 等），需与顶层响应的公共字段（ok / mode…）合并。
 */
function adoptAlternative(data, alt) {
  const adopted = { ...data, ...alt };
  delete adopted.rank;
  delete adopted.alternatives;
  state.live = adopted;
  state.replan = null;
  renderResult(adopted);
  showStatus(`已采用方案 ${alt.rank}：后续可在「🎬 演出中重排」中确认已完成前缀并按此顺序继续演出`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/* ================= 方案保存 / 载入 ================= */
async function refreshPlans() {
  const data = await api('/api/plans');
  const sel = $('#plan-select');
  sel.innerHTML = '<option value="">— 选择已保存的方案 —</option>';
  for (const p of data.plans) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name}（${p.sceneCount} 个场景，更新于 ${new Date(p.updatedAt).toLocaleString()}）`;
    sel.appendChild(opt);
  }
  if (state.planId) sel.value = state.planId;
}

async function savePlan() {
  const name = $('#plan-name').value.trim();
  if (!name) { showStatus('请先填写方案名称', true); return; }
  const p = payload();
  // 保存当前演出中重排进度（已确认前缀、实际道具、链式起点），载入后可继续重排
  if (state.replan && state.replan.prefixIds.length) {
    p.replanState = {
      prefixIds: state.replan.prefixIds,
      stageProps: state.replan.stageProps,
      originalOrder: state.live ? state.live.order : state.replan.prefixIds,
      chainStartOrder: state.replan.chainStartOrder,
    };
  }
  // 装箱配置随方案一起持久化
  p.packing = state.packing
    ? {
        capacity: state.packing.capacity,
        weights: state.packing.weights,
        pairs: state.packing.pairs.map(x => ({ ...x })),
      }
    : null;
  const body = JSON.stringify({ name, ...p });
  const headers = { 'Content-Type': 'application/json' };
  const data = state.planId
    ? await api(`/api/plans/${state.planId}`, { method: 'PUT', headers, body })
    : await api('/api/plans', { method: 'POST', headers, body });
  if (data.errors) { showStatus(data.errors.join('；'), true); return; }
  state.planId = data.plan.id;
  showStatus(`方案「${name}」已保存（含当前重排进度，载入后可继续重排）`);
  await refreshPlans();
}

async function loadPlan() {
  const id = $('#plan-select').value;
  if (!id) { showStatus('请先选择要载入的方案', true); return; }
  const data = await api(`/api/plans/${id}`);
  if (!data.ok) { showStatus(data.errors.join('；'), true); return; }
  hydrateFromPlan(data.plan);
  $('#plan-name').value = data.plan.name;
  $('#result-card').hidden = true;
  clearPackingResult();
  lastPackingItemsKey = null;
  state.live = null;
  state.replan = null;
  if (data.plan.replanState && Array.isArray(data.plan.replanState.prefixIds)
      && data.plan.replanState.prefixIds.length) {
    state.savedReplan = {
      prefixIds: data.plan.replanState.prefixIds.slice(),
      stageProps: (data.plan.replanState.stageProps || []).slice(),
      originalOrder: Array.isArray(data.plan.replanState.originalOrder)
        ? data.plan.replanState.originalOrder.slice()
        : data.plan.replanState.prefixIds.slice(),
      chainStartOrder: Array.isArray(data.plan.replanState.chainStartOrder)
        ? data.plan.replanState.chainStartOrder.slice()
        : (Array.isArray(data.plan.replanState.originalOrder) ? data.plan.replanState.originalOrder.slice() : data.plan.replanState.prefixIds.slice()),
    };
    showStatus(`已载入方案「${data.plan.name}」，正在恢复演出中重排进度…`);
    await restoreSavedReplan();
  } else {
    state.savedReplan = null;
    showStatus(`已载入方案「${data.plan.name}」，可继续编辑`);
  }
}

/** 载入带重排状态的方案：先求一次解，再按保存的前缀/实际道具自动重排。 */
async function restoreSavedReplan() {
  const saved = state.savedReplan;
  if (!saved) return;
  const solveData = await api('/api/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload()),
  });
  if (!solveData.ok) {
    state.savedReplan = null;
    renderResult(solveData);
    return;
  }
  state.live = solveData;
  state.replan = null;

  // 校验保存的前缀仍是当前节目单的连续前缀；不一致则放弃自动恢复
  const prefixIds = saved.prefixIds;
  const isPrefix = prefixIds.every((id, i) => solveData.order[i] === id);
  if (!isPrefix) {
    state.savedReplan = null;
    state.replan = null;
    renderResult(solveData);
    showStatus('方案已载入，但保存的重排前缀与当前节目单不一致，请重新确认前缀');
    return;
  }

  const bodyObj = payload();
  bodyObj.replan = {
    prefixIds,
    stageProps: saved.stageProps,
    originalOrder: saved.originalOrder,
  };
  const res = await api('/api/replan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
  state.savedReplan = null;
  if (!res.ok) {
    // 重放冲突：展示原解，让用户手工处理
    state.replan = null;
    renderResult(solveData);
    showStatus('方案已载入，但保存的重排状态当前不可行，请重新确认前缀与舞台道具');
    return;
  }
  state.replan = {
    prefixIds: prefixIds.slice(),
    chainStartOrder: saved.chainStartOrder.slice(),
    kDraft: prefixIds.length,
    stageProps: saved.stageProps.slice(),
  };
  state.live = res;
  renderResult(res);
  showStatus(`已恢复重排进度：前 ${prefixIds.length} 个场景已完成，可继续重排`);
}

function hydrateFromPlan(p) {
  state.planId = p.id;
  state.mode = p.mode === 'timed' ? 'timed' : 'classic';
  state.timeLimit = Number(p.timeLimit) || 120;
  // 旧方案没有 opLimit 字段：按不限处理
  const ol = Number(p.opLimit);
  state.opLimit = (Number.isFinite(ol) && Number.isInteger(ol) && ol > 0) ? ol : null;
  state.scenes = p.scenes.map(s => ({
    id: s.id,
    name: s.name,
    props: (s.props || []).slice(),
    duration: Number(s.duration) || 0,
    required: !!s.required,
    value: Number(s.value) || 0,
  }));
  state.constraints = {
    dependencies: (p.constraints.dependencies || []).map(d => ({ ...d })),
    fixedPositions: (p.constraints.fixedPositions || []).map(f => ({ ...f })),
    forbiddenAdjacencies: (p.constraints.forbiddenAdjacencies || []).map(f => ({ ...f })),
  };
  // 旧方案没有 packing 字段：按默认装箱配置处理
  const pk = p.packing && typeof p.packing === 'object' ? p.packing : null;
  const pkCap = pk && Number(pk.capacity);
  state.packing = {
    capacity: (Number.isInteger(pkCap) && pkCap > 0) ? pkCap : 10,
    weights: pk && pk.weights && typeof pk.weights === 'object' ? { ...pk.weights } : {},
    pairs: pk && Array.isArray(pk.pairs)
      ? pk.pairs.filter(x => x && typeof x === 'object').map(x => ({ a: String(x.a), b: String(x.b) }))
      : [],
  };
  $('#time-limit').value = state.timeLimit;
  applyMode(state.mode);
}

async function deletePlan() {
  const id = $('#plan-select').value;
  if (!id) { showStatus('请先选择要删除的方案', true); return; }
  if (!confirm('确定删除该方案？')) return;
  await api(`/api/plans/${id}`, { method: 'DELETE' });
  if (state.planId === id) state.planId = null;
  showStatus('方案已删除');
  await refreshPlans();
}

function newPlan() {
  state.planId = null;
  state.opLimit = null;
  state.alternatives = 1;
  $('#alt-count').value = '1';
  state.scenes = [];
  state.constraints = { dependencies: [], fixedPositions: [], forbiddenAdjacencies: [] };
  state.live = null;
  state.replan = null;
  state.savedReplan = null;
  state.packing = defaultPacking();
  $('#plan-name').value = '';
  $('#plan-select').value = '';
  applyMode('classic');
  $('#result-card').hidden = true;
  clearPackingResult();
  showStatus('已新建空白方案');
}

/* ================= 示例数据 ================= */
function loadSample() {
  newPlan();
  const ids = ['sc1', 'sc2', 'sc3', 'sc4', 'sc5'];
  state.scenes = [
    { id: ids[0], name: '序幕·市集', props: ['摊位', '灯笼', '布幔'] },
    { id: ids[1], name: '王宫大殿', props: ['王座', '立柱', '灯笼', '地毯'] },
    { id: ids[2], name: '森林夜话', props: ['树木', '石头', '月光布'] },
    { id: ids[3], name: '牢房', props: ['铁栏', '锁链', '石头'] },
    { id: ids[4], name: '终幕·庆典', props: ['灯笼', '地毯', '花篮', '彩带'] },
  ];
  state.constraints = {
    dependencies: [
      { before: ids[0], after: ids[1] },
      { before: ids[2], after: ids[3] },
    ],
    fixedPositions: [{ sceneId: ids[4], position: 5 }],
    forbiddenAdjacencies: [{ a: ids[1], b: ids[2] }],
  };
  $('#plan-name').value = '示例剧目';
  applyMode('classic');
  showStatus('已载入示例数据，可直接点击「计算最优顺序」');
}

function loadTimedSample() {
  newPlan();
  const ids = ['t1', 't2', 't3', 't4', 't5', 't6'];
  state.scenes = [
    { id: ids[0], name: '开场·群舞',   props: ['灯', '幕'],         duration: 10, required: true,  value: 0 },
    { id: ids[1], name: '独唱',         props: ['灯', '椅'],         duration: 8,  required: false, value: 6 },
    { id: ids[2], name: '魔术',         props: ['箱', '灯'],         duration: 12, required: false, value: 10 },
    { id: ids[3], name: '短剧',         props: ['桌', '椅', '树'],   duration: 20, required: false, value: 8 },
    { id: ids[4], name: '互动环节',     props: ['话筒'],             duration: 10, required: false, value: 4 },
    { id: ids[5], name: '终场·合唱',   props: ['灯', '幕', '花'],   duration: 10, required: true,  value: 0 },
  ];
  state.constraints = {
    dependencies: [{ before: ids[0], after: ids[5] }],
    fixedPositions: [],
    forbiddenAdjacencies: [{ a: ids[0], b: ids[5] }],
  };
  state.timeLimit = 55;
  $('#time-limit').value = 55;
  $('#plan-name').value = '时长受限示例';
  applyMode('timed');
  showStatus('已载入时长受限示例：必演 20 分钟，上限 55 分钟，试试取舍可选场景');
}

/* ================= 事件绑定 ================= */
$('#btn-add-scene').addEventListener('click', () => {
  if (state.scenes.length >= MAX_SCENES) return;
  const s = { id: uid(), name: '', props: [] };
  if (isTimed()) { s.duration = 0; s.required = false; s.value = 0; }
  state.scenes.push(s);
  renderAll();
});
$('#btn-sample').addEventListener('click', loadSample);
$('#btn-sample-timed').addEventListener('click', loadTimedSample);
$('#btn-solve').addEventListener('click', doSolve);
$('#btn-save').addEventListener('click', savePlan);
$('#btn-load').addEventListener('click', loadPlan);
$('#btn-delete').addEventListener('click', deletePlan);
$('#btn-new').addEventListener('click', newPlan);

document.querySelectorAll('input[name="mode"]').forEach(r => {
  r.addEventListener('change', () => applyMode(r.value));
});
$('#time-limit').addEventListener('input', () => {
  state.timeLimit = Math.max(1, Math.floor(Number($('#time-limit').value) || 0));
  updateRequiredHint();
});

$('#op-limit-enabled').addEventListener('change', () => {
  state.opLimit = $('#op-limit-enabled').checked
    ? Math.max(1, Math.floor(Number($('#op-limit').value) || 1))
    : null;
  syncOpLimitUI();
});
$('#op-limit').addEventListener('input', () => {
  const v = Math.max(1, Math.floor(Number($('#op-limit').value) || 0));
  state.opLimit = v;
  $('#op-limit-hint').textContent = `每段撤下 + 上台合计不得超过 ${v} 件；求解器将在满足该上限的候选中按原目标选最优顺序。`;
});

$('#alt-count').addEventListener('change', () => {
  const v = Number($('#alt-count').value);
  state.alternatives = (v >= 2 && v <= 3) ? v : 1;
});

$('#btn-add-dep').addEventListener('click', () => {
  const before = $('#dep-form [data-role="before"]').value;
  const after = $('#dep-form [data-role="after"]').value;
  if (!before || !after) return;
  state.constraints.dependencies.push({ before, after });
  renderConstraintLists();
});
$('#btn-add-fixed').addEventListener('click', () => {
  const sceneId = $('#fixed-form [data-role="scene"]').value;
  const position = Number($('#fixed-form [data-role="position"]').value);
  if (!sceneId || !Number.isInteger(position)) return;
  state.constraints.fixedPositions.push({ sceneId, position });
  renderConstraintLists();
});
$('#btn-add-noadj').addEventListener('click', () => {
  const a = $('#noadj-form [data-role="a"]').value;
  const b = $('#noadj-form [data-role="b"]').value;
  if (!a || !b) return;
  state.constraints.forbiddenAdjacencies.push({ a, b });
  renderConstraintLists();
});

/* ================= 巡演装箱事件 ================= */
$('#btn-pack').addEventListener('click', doPack);
$('#btn-sync-packing').addEventListener('click', () => {
  renderPacking();
  const n = collectPackingItems().length;
  showStatus(n ? `装箱清单已同步：共 ${n} 件待运输道具（已保留既有重量设置）` : '装箱清单已同步：当前还没有任何道具');
});
$('#pack-capacity').addEventListener('input', () => {
  state.packing.capacity = Math.max(0, Math.floor(Number($('#pack-capacity').value) || 0));
  clearPackingResult();
  refreshPackOverweight();
});
$('#btn-add-packpair').addEventListener('click', () => {
  const a = $('#packpair-form [data-role="a"]').value;
  const b = $('#packpair-form [data-role="b"]').value;
  if (!a || !b || a === b) return;
  const dup = state.packing.pairs.some(p =>
    (p.a === a && p.b === b) || (p.a === b && p.b === a));
  if (dup) { showStatus('该互斥道具对已存在', true); return; }
  state.packing.pairs.push({ a, b });
  clearPackingResult();
  renderPacking();
});

/* ================= 初始化 ================= */
applyMode('classic');
refreshPlans();

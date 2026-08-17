// ===== Utils =====

const fmt = {
  tokens: n => {
    if (n == null) return '—';
    if (n >= 1e9) return `${(n/1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n/1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n/1e3).toFixed(1)}K`;
    return String(Math.round(n));
  },
  usd:  n => n == null ? '—' : `$${n.toFixed(4)}`,
  pct:  n => n == null ? '—' : `${Number(n).toFixed(1)}%`,
  date: s => s ? new Date(s).toLocaleDateString() : '—',
  ago:  s => {
    if (!s) return '—';
    const ms = Date.now() - new Date(s).getTime();
    const m = Math.floor(ms / 60000);
    if (m < 1)  return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h/24)}d ago`;
  },
};

// Soft, warm data palette — readable on both the cream and slate themes.
const COLOR = {
  input:       '#5f93d1',
  output:      '#e3a838',
  cacheCreate: '#a98cd6',
  cacheRead:   '#5fb98f',
  ok:    '#5fb98f',
  warn:  '#e3a838',
  error: '#df7b6b',
  dim:   '#9b9486',
  blue:  '#5f93d1',
  orange:'#e3a838',
  green: '#5fb98f',
  purple:'#a98cd6',
  yellow:'#e3a838',
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

// ===== API =====

// Every read endpoint is scoped to the active data source. Adding the param
// here means no call site can forget it; paths that already carry one (the
// /api/config/* calls build theirs with pq()) are left alone.
function withProvider(path) {
  if (!currentProviderId || path.includes('provider=')) return path;
  return `${path}${path.includes('?') ? '&' : '?'}provider=${encodeURIComponent(currentProviderId)}`;
}

async function api(path) {
  const res = await fetch(`/api${withProvider(path)}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(`/api${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function apiPost(path, body = {}) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ===== Toast =====

let toastTimer = null;
function toast(msg, dur = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  el.style.opacity = '1';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.hidden = true, 300); }, dur);
}

// ===== Charts =====

const charts = {};

// Read a CSS custom property off the document root.
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function gridLine() { return cssVar('--grid-line') || 'rgba(0,0,0,.08)'; }

// Theme-aware colors for chart chrome, recomputed whenever the theme changes.
function chartTheme() {
  return {
    dim:     cssVar('--text-dim') || '#999',
    text:    cssVar('--text')     || '#333',
    grid:    gridLine(),
    surface: cssVar('--surface')  || '#fff',
    border:  cssVar('--sh-dark')  || '#ccc',
  };
}

// (Re)register the shared ECharts theme so tooltips match the active palette.
function registerEchartsTheme() {
  if (!window.echarts) return;
  const t = chartTheme();
  echarts.registerTheme('app', {
    textStyle: { color: t.dim },
    tooltip: {
      backgroundColor: t.surface,
      borderColor: t.border,
      textStyle: { color: t.text },
      extraCssText: 'border-radius:12px;box-shadow:0 10px 28px rgba(0,0,0,.20);',
    },
  });
}

function initChart(id) {
  const el = document.getElementById(id);
  if (!el || !window.echarts) return null;
  charts[id]?.dispose();
  const c = echarts.init(el, 'app', { renderer: 'svg' });
  const ro = new ResizeObserver(() => c.resize());
  ro.observe(el.parentElement ?? el);
  charts[id] = c;
  return c;
}

function baseOption() {
  const t = chartTheme();
  return {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', confine: true },
    // containLabel lets ECharts measure axis labels and keep them inside the
    // canvas, so million-scale y-axis values are never clipped at the edge.
    grid: { left: 8, right: 14, top: 32, bottom: 8, containLabel: true },
    textStyle: { color: t.dim },
    axisLabel: { color: t.dim },
  };
}

// ===== Providers =====

let allProviders = [];
let currentProviderId = null;

async function loadProviders() {
  let list = null;
  let fetchError = null;
  try {
    list = await api('/providers');
  } catch (e) {
    fetchError = e;
    console.warn('Failed to load /api/providers:', e);
  }
  allProviders = Array.isArray(list) ? list : [];

  const sel  = document.getElementById('provider-select');
  const wrap = document.getElementById('provider-switcher');

  if (fetchError) {
    wrap.hidden = true;
    showEmptyBanner(`Could not reach /api/providers (${fetchError.message}). The server may be running an older build — restart it (Ctrl+C, then \`bun run server.ts\`) and reload this page.`);
    return;
  }

  if (allProviders.length === 0) {
    wrap.hidden = true;
    showEmptyBanner('No data sources are configured. Add an entry to src/providers/index.ts.');
    return;
  }

  sel.innerHTML = allProviders.map(p =>
    `<option value="${esc(p.id)}"${p.hasData ? '' : ' disabled'}>${esc(p.label)}${p.hasData ? '' : ' — no data'}</option>`
  ).join('');
  wrap.hidden = false;

  // Default selection: stored choice (still valid + has data) → first with data → first overall.
  const stored = localStorage.getItem('provider');
  const storedValid = allProviders.some(p => p.id === stored && p.hasData);
  const firstWithData = allProviders.find(p => p.hasData);
  currentProviderId = storedValid ? stored : (firstWithData?.id ?? allProviders[0].id);
  sel.value = currentProviderId;

  updateProviderUI();

  sel.addEventListener('change', () => {
    currentProviderId = sel.value;
    localStorage.setItem('provider', currentProviderId);
    updateProviderUI();
    loadTab(currentTab);
  });
}

function currentProviderInfo() {
  return allProviders.find(p => p.id === currentProviderId) ?? null;
}

function updateProviderUI() {
  const info = currentProviderInfo();
  const pill = document.getElementById('provider-data-pill');
  if (info && !info.hasData) {
    pill.textContent = 'no data';
    pill.hidden = false;
    showEmptyBanner(`No data found for ${info.label}. Expected location: ${info.dataDir}`);
  } else {
    pill.hidden = true;
    showEmptyBanner(null);
  }
}

function showEmptyBanner(msg) {
  const banner = document.getElementById('empty-data-banner');
  const desc = document.getElementById('empty-banner-desc');
  if (msg) {
    desc.textContent = msg;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

// ===== Tabs =====

let currentTab = 'dashboard';
const tabData = {};

const PAGE_META = {
  dashboard:   ['Dashboard', 'Token usage at a glance'],
  runs:        ['Runs', 'Browse and inspect every recorded run'],
  settings:    ['Settings', 'Tune warning thresholds and reference pricing'],
  claudemd:    ['Instructions', 'View and edit the instruction files injected into every session'],
  commands:    ['Commands', 'Slash commands across user, project and plugin sources'],
  skills:      ['Skills', 'Installed skills, their triggers, recorded usage and related components'],
  hooks:       ['Hooks', 'Configured hooks across settings layers, with recorded fires'],
  mcp:         ['MCP Servers', 'Configured MCP servers, their tools and token overhead'],
  permissions: ['Permissions', 'Allow / deny / ask rules across settings layers'],
  memory:      ['Memory', 'Persistent per-project memory stores'],
  configs:     ['Effective Configs', 'Merged settings layers — which value wins and where it comes from'],
};

function switchTab(tab) {
  currentTab = tab;
  location.hash = tab;
  document.querySelectorAll('.nav-item[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(s => s.hidden = s.id !== `tab-${tab}`);
  const meta = PAGE_META[tab];
  if (meta) {
    document.getElementById('page-title').textContent = meta[0];
    document.getElementById('page-subtitle').textContent = meta[1];
  }
  loadTab(tab);
}

function loadTab(tab) {
  if (tab === 'dashboard') loadDashboard();
  else if (tab === 'runs') loadRuns();
  else if (tab === 'settings') loadSettings();
  // Harness tabs live in config.js and register themselves here.
  else if (window.ConfigPages?.[tab]) window.ConfigPages[tab]();
}

// ===== Dashboard =====

// How much history this install keeps. Loaded once at startup, before any tab
// renders, because it decides which time ranges and KPI cards even exist.
// config.js reads it from here too.
window.AppSettings = { retentionDays: 30 };

async function loadRetention() {
  try {
    const r = await api('/settings/retention');
    window.AppSettings.retentionDays = r.retentionDays ?? 30;
  } catch (e) {
    console.warn('Retention settings failed to load, assuming 30 days:', e.message);
  }
  RANGES = buildRanges(window.AppSettings.retentionDays);
}

/**
 * The range ladder for the current retention window.
 *
 * 1h and 24h are always offered (the window can never be shorter than a day).
 * Above them come the conventional 7d/30d rungs, but only while they fit inside
 * the window — showing a "30d" button on a 14-day store would promise history
 * that was already deleted. The window itself is always the widest rung.
 */
function buildRanges(days) {
  const out = [['1h', 'Last 1 hour'], ['24h', 'Last 24 hours']];
  for (const rung of [7, 30]) {
    if (days > rung) out.push([`${rung}d`, `Last ${rung} days`]);
  }
  if (days > 1) out.push([`${days}d`, `Last ${days} days (everything kept)`]);
  return out;
}

let RANGES = buildRanges(30);

/** The widest range offered — the default for every chart. */
function maxRange() {
  return RANGES[RANGES.length - 1][0];
}

const chartRanges = (() => {
  try { return { ...JSON.parse(localStorage.getItem('chartRanges') || '{}') }; }
  catch { return {}; }
})();
// A remembered range that no longer fits the window falls back to the widest
// one that does, so shrinking retention never leaves a chart asking for data
// that is gone.
function chartRange(key) {
  return RANGES.some(([r]) => r === chartRanges[key]) ? chartRanges[key] : maxRange();
}

const CHART_LOADERS = {
  trend:    async r => renderTrendChart(await api(`/timeseries?range=${r}`)),
  models:   async r => renderModelsChart(await api(`/models?range=${r}`)),
  projects: async r => renderProjectsChart(await api(`/projects?range=${r}`)),
  mcp:      async r => renderMcpUsageChart(await api(`/mcp-usage?range=${r}`)),
  skills:   async r => renderSkillUsageChart(await api(`/skill-usage?range=${r}`)),
  cacheHit: async r => renderCacheHitChart(await api(`/timeseries?range=${r}`)),
  modelMix: async r => renderModelMixChart(await api(`/models?range=${r}`)),
  topRuns:  async r => renderTopRunsChart(await api(`/top-runs?limit=10&range=${r}`)),
};

function initRangeGroups() {
  document.querySelectorAll('.range-group').forEach(group => {
    const key = group.dataset.chart;
    if (!CHART_LOADERS[key]) return;
    group.innerHTML = RANGES.map(([r, label]) =>
      `<button class="range-btn${chartRange(key) === r ? ' active' : ''}" data-range="${r}" title="${esc(label)}">${esc(r)}</button>`
    ).join('');
    group.querySelectorAll('.range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        chartRanges[key] = btn.dataset.range;
        localStorage.setItem('chartRanges', JSON.stringify(chartRanges));
        group.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', b === btn));
        CHART_LOADERS[key](btn.dataset.range).catch(e => console.warn(`Chart ${key} failed:`, e.message));
      });
    });
  });
}

async function loadDashboard() {
  const jobs = [
    ['stats', async () => renderKpiCards(await api('/stats'))],
    ...Object.entries(CHART_LOADERS).map(([key, load]) => [key, () => load(chartRange(key))]),
  ];

  // allSettled so a single missing endpoint (e.g. server not restarted after
  // a new endpoint was added) doesn't blank out the whole dashboard.
  const results = await Promise.allSettled(jobs.map(([, run]) => run()));

  const failures = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') failures.push({ key: jobs[i][0], err: r.reason });
  });
  if (failures.length === jobs.length) {
    document.getElementById('kpi-row').innerHTML = `<p class="text-error">All dashboard endpoints failed: ${esc(failures[0].err.message)}</p>`;
    return;
  }
  for (const f of failures) console.warn(`Dashboard section failed: ${f.key} —`, f.err.message);
}

const SVG_A = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const KPI_ICONS = {
  today:  `<svg ${SVG_A}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>`,
  week:   `<svg ${SVG_A}><rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg>`,
  month:  `<svg ${SVG_A}><rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4M7.5 14h3M13.5 14h3"/></svg>`,
  cache:  `<svg ${SVG_A}><path d="M13 2.5L4.5 13.5H11l-1 8 8.5-11H12z"/></svg>`,
  active: `<svg ${SVG_A}><path d="M4 19v-5M10 19v-9M16 19v-13M22 19V8"/></svg>`,
};

function renderKpiCards(stats) {
  const { today, sevenDays, window: windowTotals, retentionDays, cacheHitRatePct, activeRuns } = stats;
  const days = retentionDays ?? window.AppSettings.retentionDays;
  const cacheStatus = cacheHitRatePct >= 50 ? 'ok' : 'warn';
  const totals = t => `${fmt.tokens(t.input)} in · ${fmt.tokens(t.output)} out`;
  // The 7-day card is server-suppressed (sevenDays: null) once the retention
  // window is 7 days or less — there it would restate the window card.
  const cards = [
    { icon: 'today',  label: 'Today',     value: fmt.tokens(today.total),        sub: totals(today),        sub2: `~$${today.totalCost?.toFixed(2) ?? '?'} API-equiv` },
    ...(sevenDays ? [
    { icon: 'week',   label: '7 days',    value: fmt.tokens(sevenDays.total),    sub: totals(sevenDays),    sub2: `~$${sevenDays.totalCost?.toFixed(2) ?? '?'} API-equiv` }] : []),
    ...(days > 1 ? [
    { icon: 'month',  label: `${days} days`, value: fmt.tokens(windowTotals.total), sub: totals(windowTotals), sub2: `${fmt.usd(windowTotals.totalCost)} API-equiv` }] : []),
    { icon: 'cache',  label: 'Cache hit', value: fmt.pct(cacheHitRatePct),       sub: `${days}-day average`, cls: cacheStatus },
    { icon: 'active', label: 'Active',    value: String(activeRuns ?? 0),        sub: 'runs · 5 min window' },
  ];
  document.getElementById('kpi-row').innerHTML = cards.map(c => `
    <div class="kpi-card ${c.cls ?? ''}">
      <div class="kpi-icon">${KPI_ICONS[c.icon] ?? ''}</div>
      <div class="kpi-body">
        <div class="kpi-label">${esc(c.label)}</div>
        <div class="kpi-value">${esc(c.value)}</div>
        <div class="kpi-sub">${esc(c.sub ?? '')}</div>
        ${c.sub2 ? `<div class="kpi-sub2">${esc(c.sub2)}</div>` : ''}
      </div>
    </div>
  `).join('');
}

function renderTrendChart(series) {
  const chart = initChart('chart-trend');
  if (!chart) return;
  const dates = series.map(d => d.date);
  chart.setOption({
    ...baseOption(),
    legend: { data: ['Input','Output','Cache write','Cache read'], top: 0, textStyle:{color:COLOR.dim} },
    xAxis: { type:'category', data:dates, axisLine:{lineStyle:{color:COLOR.dim}} },
    yAxis: { type:'value', axisLabel:{formatter: v => fmt.tokens(v), color:COLOR.dim}, splitLine:{lineStyle:{color:gridLine()}} },
    series: [
      { name:'Input',       type:'bar', stack:'s', data:series.map(d=>d.input),                      itemStyle:{color:COLOR.input} },
      { name:'Output',      type:'bar', stack:'s', data:series.map(d=>d.output),                     itemStyle:{color:COLOR.output} },
      { name:'Cache write', type:'bar', stack:'s', data:series.map(d=>(d.cacheCreate5m??0)+(d.cacheCreate1h??0)), itemStyle:{color:COLOR.cacheCreate} },
      { name:'Cache read',  type:'bar', stack:'s', data:series.map(d=>d.cacheRead),                  itemStyle:{color:COLOR.cacheRead} },
    ],
  });
}

// Range switches can land on an empty window — without an explicit empty
// state the previous range's bars would linger on screen.
function renderChartEmpty(chart, text) {
  chart.clear();
  chart.setOption({ ...baseOption(), title: { text, left: 'center', top: 'middle', textStyle: { color: COLOR.dim, fontSize: 13, fontWeight: 'normal' } } });
}

// Every horizontal bar card here is fed a descending list, but ECharts anchors
// category index 0 at the *bottom* of the y-axis — so a "top N" card would read
// smallest-first. Reverse the rows to put the largest bar on top. Derive labels,
// series and tooltips from the returned array, never from the original.
const largestOnTop = rows => [...rows].reverse();

function renderModelsChart(models) {
  const chart = initChart('chart-models');
  if (!chart) return;
  if (!models?.length) return renderChartEmpty(chart, 'No usage in this range');
  const rows = largestOnTop(models); // server returns them total-descending
  const names = rows.map(m => m.model.replace('claude-', '').replace(/-(\d)/g, ' $1'));
  chart.setOption({
    ...baseOption(),
    grid: { left: 6, right: 16, top: 30, bottom: 6, containLabel: true },
    legend: { data: ['Input', 'Output', 'Cache write', 'Cache read'], top: 0, textStyle: { color: COLOR.dim, fontSize: 11 } },
    xAxis: { type: 'value', axisLabel: { formatter: v => fmt.tokens(v), color: COLOR.dim }, splitLine: { lineStyle: { color: gridLine() } } },
    yAxis: { type: 'category', data: names, axisLabel: { color: COLOR.dim, fontSize: 11 } },
    series: [
      { name: 'Input',       type: 'bar', stack: 's', data: rows.map(m => m.input),                         itemStyle: { color: COLOR.input } },
      { name: 'Output',      type: 'bar', stack: 's', data: rows.map(m => m.output),                        itemStyle: { color: COLOR.output } },
      { name: 'Cache write', type: 'bar', stack: 's', data: rows.map(m => (m.cacheCreate5m ?? 0) + (m.cacheCreate1h ?? 0)), itemStyle: { color: COLOR.cacheCreate } },
      { name: 'Cache read',  type: 'bar', stack: 's', data: rows.map(m => m.cacheRead),                     itemStyle: { color: COLOR.cacheRead } },
    ],
    tooltip: { trigger: 'axis', formatter: ps => ps[0].name + '<br>' + ps.map(p => `${p.seriesName}: ${fmt.tokens(p.value)}`).join('<br>') },
  });
}

function renderProjectsChart(projects) {
  const chart = initChart('chart-projects');
  if (!chart) return;
  const top = largestOnTop((projects ?? []).filter(p => p.totalTokens > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 10));
  if (!top.length) return renderChartEmpty(chart, 'No usage in this range');
  const names = top.map(p => {
    const parts = (p.cwd ?? '').replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || p.cwd || '(unknown)';
  });
  chart.setOption({
    ...baseOption(),
    grid: { left: 6, right: 80, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'value', axisLabel: { formatter: v => fmt.tokens(v), color: COLOR.dim }, splitLine: { lineStyle: { color: gridLine() } } },
    yAxis: { type: 'category', data: names, axisLabel: { color: COLOR.dim, fontSize: 11 } },
    series: [{
      type: 'bar',
      data: top.map(p => p.totalTokens),
      itemStyle: { color: COLOR.input },
      label: { show: true, position: 'right', formatter: p => fmt.tokens(p.value), color: COLOR.dim, fontSize: 10 },
    }],
    tooltip: {
      formatter: (p) => {
        const proj = top[p.dataIndex];
        return `${esc(proj.cwd ?? '?')}<br>${fmt.tokens(proj.totalTokens)} tokens · ${proj.runCount ?? 0} runs · ${proj.agentCount ?? 0} agents`;
      },
    },
  });
}

// Shared renderer for the MCP / Skill usage cards: horizontal bars of
// estimated tokens with call counts, plus an in-chart empty state.
function renderUsageBarChart(chartId, rows, color, emptyText, tooltipFor) {
  const chart = initChart(chartId);
  if (!chart) return;
  if (!rows?.length) return renderChartEmpty(chart, emptyText);
  const top = largestOnTop(rows.slice(0, 10));
  chart.setOption({
    ...baseOption(),
    grid: { left: 6, right: 76, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'value', axisLabel: { formatter: v => fmt.tokens(v), color: COLOR.dim }, splitLine: { lineStyle: { color: gridLine() } } },
    yAxis: { type: 'category', data: top.map(r => r.name), axisLabel: { color: COLOR.dim, fontSize: 11 } },
    series: [{
      type: 'bar', barMaxWidth: 22,
      data: top.map(r => r.tokens),
      itemStyle: { color },
      label: { show: true, position: 'right', formatter: p => fmt.tokens(p.value), color: COLOR.dim, fontSize: 10 },
    }],
    tooltip: { formatter: p => tooltipFor(top[p.dataIndex]) },
  });
}

function renderMcpUsageChart(servers) {
  renderUsageBarChart(
    'chart-mcp-usage',
    (servers ?? []).map(s => ({ ...s, name: s.server })),
    COLOR.purple,
    'No MCP tool calls in this range',
    s => {
      const toolLines = (s.tools ?? []).slice(0, 8)
        .map(t => `${esc(t.tool)}: ${t.calls} call${t.calls !== 1 ? 's' : ''} · ${fmt.tokens(t.tokens)}`);
      return [`<b>${esc(s.server)}</b>`,
              `${s.calls} call${s.calls !== 1 ? 's' : ''} · ~${fmt.tokens(s.tokens)} tokens (est.)`,
              ...toolLines].join('<br>');
    });
}

function renderSkillUsageChart(skills) {
  renderUsageBarChart(
    'chart-skill-usage',
    (skills ?? []).map(s => ({ ...s, name: s.skill })),
    COLOR.green,
    'No skill invocations in this range',
    s => `<b>${esc(s.skill)}</b><br>${s.calls} invocation${s.calls !== 1 ? 's' : ''} · ~${fmt.tokens(s.tokens)} tokens (est.)`);
}

function renderTopRunsChart(runs) {
  const chart = initChart('chart-top-runs');
  if (!chart) return;
  if (!runs?.length) {
    chart.clear();
    chart.setOption({ ...baseOption(), title: { text: 'No runs yet', left: 'center', top: 'middle', textStyle: { color: COLOR.dim, fontSize: 13, fontWeight: 'normal' } } });
    return;
  }

  const rows = largestOnTop(runs);
  const labels = rows.map(s => {
    const t = (s.title ?? '').trim() || '(untitled)';
    const suffix = (s.agent_count ?? 1) > 1 ? `  · ${s.agent_count} agents` : '';
    const trimmed = t.length > 42 ? t.slice(0, 41) + '…' : t;
    return `${trimmed}${suffix}`;
  });

  chart.setOption({
    ...baseOption(),
    grid: { left: 260, right: 100, top: 28, bottom: 8 },
    legend: { data: ['Input', 'Output', 'Cache write', 'Cache read'], top: 0, textStyle: { color: COLOR.dim, fontSize: 11 } },
    xAxis: { type: 'value', axisLabel: { formatter: v => fmt.tokens(v), color: COLOR.dim }, splitLine: { lineStyle: { color: gridLine() } } },
    yAxis: {
      type: 'category',
      data: labels,
      axisLabel: { color: COLOR.dim, fontSize: 11, width: 250, overflow: 'truncate' },
      axisTick: { show: false },
    },
    series: [
      { name: 'Input',       type: 'bar', stack: 's', data: rows.map(r => r.input),                                            itemStyle: { color: COLOR.input } },
      { name: 'Output',      type: 'bar', stack: 's', data: rows.map(r => r.output),                                           itemStyle: { color: COLOR.output } },
      { name: 'Cache write', type: 'bar', stack: 's', data: rows.map(r => (r.cacheCreate5m ?? 0) + (r.cacheCreate1h ?? 0)),    itemStyle: { color: COLOR.cacheCreate } },
      { name: 'Cache read',  type: 'bar', stack: 's', data: rows.map(r => r.cacheRead),                                        itemStyle: { color: COLOR.cacheRead },
        label: { show: true, position: 'right', formatter: p => fmt.tokens(rows[p.dataIndex].total), color: COLOR.dim, fontSize: 10 } },
    ],
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: ps => {
        const s = rows[ps[0].dataIndex];
        const lines = [
          `<b>${esc(s.title ?? '(untitled)')}</b>`,
          esc(s.cwd ?? '—'),
          `${s.agent_count ?? 1} agent${(s.agent_count ?? 1) === 1 ? '' : 's'} · ${s.turn_count ?? 0} turns · ${esc((s.model ?? '').replace('claude-', ''))}`,
          ...ps.map(p => `${p.marker} ${p.seriesName}: ${fmt.tokens(p.value)}`),
          `<b>Total: ${fmt.tokens(s.total)}</b>`,
        ];
        return lines.join('<br>');
      },
    },
  });

  // Click a bar to jump to that run's detail page
  chart.off('click');
  chart.on('click', params => {
    if (params.componentType !== 'series') return;
    const s = rows[params.dataIndex];
    if (s?.run_id) openRunDetail(s.run_id, s.title ?? '', s.cwd ?? '');
  });
}

// Cache-hit-rate line over the selected range, with the 50% guide line.
// Buckets follow the range: 5-minute slices for 1h, hours for 24h, days beyond.
function renderCacheHitChart(series) {
  const chart = initChart('chart-cache-hit');
  if (!chart) return;
  if (!series?.length) return renderChartEmpty(chart, 'No usage in this range');
  const rates = series.map(d => {
    const cr = d.cacheRead ?? 0;
    const total = (d.input ?? 0) + (d.cacheCreate5m ?? 0) + (d.cacheCreate1h ?? 0) + cr;
    return total ? +(cr / total * 100).toFixed(1) : 0;
  });
  chart.setOption({ ...baseOption(),
    // right gutter leaves room for the 50% guide-line label at the end of the line
    grid: { left: 8, right: 38, top: 16, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: series.map(d => d.date), axisLabel: { color: COLOR.dim } },
    yAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: v => `${v}%`, color: COLOR.dim }, splitLine: { lineStyle: { color: gridLine() } } },
    series: [{
      type: 'line', data: rates, smooth: true,
      areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(77,240,154,.3)' }, { offset: 1, color: 'rgba(77,240,154,.02)' }] } },
      lineStyle: { color: COLOR.green }, itemStyle: { color: COLOR.green },
      markLine: { silent: true, data: [{ yAxis: 50, lineStyle: { color: COLOR.yellow, type: 'dashed' } }], label: { formatter: '50%', color: COLOR.yellow } },
    }],
    tooltip: { trigger: 'axis', formatter: p => `${p[0].name}: ${p[0].value}% served from cache` },
  });
}

// Total tokens per model over the selected range — horizontal bars, largest on top.
function renderModelMixChart(models) {
  const chart = initChart('chart-model-mix');
  if (!chart) return;
  if (!models?.length) return renderChartEmpty(chart, 'No usage in this range');
  const palette = [COLOR.blue, COLOR.orange, COLOR.purple, COLOR.green, COLOR.yellow];
  const rows = largestOnTop(models);
  const names = rows.map(m => m.model.replace('claude-', '').replace(/-(\d)/g, ' $1'));
  chart.setOption({ ...baseOption(),
    grid: { left: 6, right: 76, top: 14, bottom: 8, containLabel: true },
    xAxis: { type: 'value', axisLabel: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: gridLine() } } },
    yAxis: { type: 'category', data: names, axisLabel: { color: COLOR.dim, fontSize: 11 }, axisTick: { show: false } },
    series: [{ type: 'bar', barMaxWidth: 24,
      data: rows.map((m, i) => ({ value: m.total, itemStyle: { color: palette[i % palette.length] } })),
      label: { show: true, position: 'right', formatter: p => fmt.tokens(p.value), color: COLOR.dim, fontSize: 11 } }],
    tooltip: { trigger: 'item', formatter: p => `${esc(p.name)}: ${fmt.tokens(p.value)} tokens` },
  });
}

// ===== Runs =====

let runsState = { page: 0, limit: 50, search: '', project: '', sort: 'last_seen_at' };

async function loadRuns(reset = true) {
  if (reset) runsState.page = 0;
  const { page, limit, search, project } = runsState;
  const offset = page * limit;
  const params = new URLSearchParams({ limit, offset, ...(search ? {search} : {}), ...(project ? {project} : {}) });
  try {
    const [data, projects] = await Promise.all([
      api(`/runs?${params}`),
      api('/projects'),
    ]);
    renderRunsTable(data.rows, data.total);
    renderProjectFilter(projects);
  } catch (e) {
    document.getElementById('runs-table-wrap').innerHTML = `<p class="text-error">${esc(e.message)}</p>`;
  }
}

function renderProjectFilter(projects) {
  const sel = document.getElementById('project-filter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All projects</option>' +
    projects.map(p => `<option value="${esc(p.cwd)}" ${p.cwd===cur?'selected':''}>${esc(p.cwd ?? '(unknown)')}</option>`).join('');
}

function renderRunsTable(rows, total) {
  document.getElementById('runs-count').textContent = `${total} run${total!==1?'s':''}`;
  const { page, limit } = runsState;
  const totalPages = Math.ceil(total / limit);
  document.getElementById('runs-page').textContent = `${page+1} / ${Math.max(1,totalPages)}`;
  document.getElementById('runs-prev').disabled = page === 0;
  document.getElementById('runs-next').disabled = page >= totalPages - 1;

  if (!rows.length) {
    document.getElementById('runs-table-wrap').innerHTML = '<p class="text-dim" style="padding:24px 0">No runs found.</p>';
    return;
  }

  const table = document.createElement('table');
  table.innerHTML = `
    <thead><tr>
      <th></th><th>Title</th><th>Project</th><th>ID</th>
      <th class="td-num">Agents</th><th class="td-num">Turns</th>
      <th class="td-num">Total tokens</th>
      <th class="td-num">Input</th><th class="td-num">Cache read</th>
      <th class="td-num">Output</th><th>Last active</th>
    </tr></thead>
    <tbody>${rows.map(r => {
      const title = r.title ?? 'Untitled';
      const cwd   = r.cwd ?? '';
      const agentBadge = (r.agent_count ?? 1) > 1
        ? `<span class="run-agents-badge" title="This run spawned ${r.agent_count} agents (main agent + sub-agents)">× ${r.agent_count}</span>`
        : '';
      return `<tr>
      <td style="padding:0 6px 0 0"><button class="btn-sm btn-view" data-rid="${esc(r.run_id)}" data-title="${esc(title)}" data-cwd="${esc(cwd)}">View</button></td>
      <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(title)}">${agentBadge}${esc(title)}</td>
      <td class="td-dim" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(cwd)}">${esc(cwd.split(/[/\\]/).pop() || '—')}</td>
      <td>${r.run_key
        ? `<button class="run-key" data-key="${esc(r.run_key)}" title="Copy this run's id — pass it to compare_runs to measure a change">${esc(r.run_key)}</button>`
        : '<span class="td-dim">—</span>'}</td>
      <td class="td-num">${r.agent_count ?? 1}</td>
      <td class="td-num">${r.turn_count ?? 0}</td>
      <td class="td-num">${fmt.tokens(r.total)}</td>
      <td class="td-num td-dim">${fmt.tokens(r.input)}</td>
      <td class="td-num td-dim">${fmt.tokens(r.cacheRead)}</td>
      <td class="td-num td-dim">${fmt.tokens(r.output)}</td>
      <td class="td-dim">${fmt.ago(r.last_seen_at)}</td>
    </tr>`;
    }).join('')}</tbody>
  `;
  table.querySelectorAll('.btn-view').forEach(btn => {
    btn.addEventListener('click', () => {
      openRunDetail(btn.dataset.rid, btn.dataset.title, btn.dataset.cwd);
    });
  });
  table.querySelectorAll('.run-key').forEach(btn => {
    btn.addEventListener('click', () => copyRunKey(btn));
  });
  document.getElementById('runs-table-wrap').replaceChildren(table);
}

/**
 * Copy a run id, confirming in the button itself.
 *
 * navigator.clipboard needs a secure context, which localhost is — but the
 * server can be bound to 0.0.0.0 and reached over plain http on a LAN address,
 * where it is undefined. The textarea fallback keeps the button working there,
 * and if even that fails the text is left selected so it can be copied by hand.
 */
async function copyRunKey(btn) {
  const key = btn.dataset.key;
  const done = ok => {
    const original = btn.textContent;
    btn.textContent = ok ? 'copied ✓' : 'press Ctrl+C';
    btn.classList.toggle('copied', ok);
    setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1200);
  };

  try {
    await navigator.clipboard.writeText(key);
    done(true);
    return;
  } catch { /* fall through */ }

  const ta = document.createElement('textarea');
  ta.value = key;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  done(ok);
}

// ===== Settings =====

async function loadSettings() {
  try {
    const [thresholds, pricing, retention] = await Promise.all([
      api('/settings/thresholds'), api('/settings/pricing'), api('/settings/retention'),
    ]);
    renderThresholds(thresholds);
    renderPricing(pricing);
    renderRetention(retention);
  } catch (e) {
    document.getElementById('thresholds-form').textContent = `Error: ${e.message}`;
  }
}

function renderRetention(r) {
  const form = document.getElementById('retention-form');
  if (!form) return;
  form.innerHTML = `
    <div class="retention-row">
      <input type="number" id="retention-days" class="input-sm" min="${r.minDays}" max="${r.maxDays}" value="${r.retentionDays}">
      <span class="threshold-unit">days</span>
      <button id="retention-save" class="btn">Save</button>
    </div>
    <p class="text-dim" style="font-size:11px;margin-top:8px">
      Records older than this are deleted from the local cache (default ${r.defaultDays} days, ${r.minDays}–${r.maxDays} allowed).
      Charts and KPI cards only offer ranges that fit inside the window.
      Widening it re-scans your transcripts to restore what is still on disk; narrowing it deletes the excess immediately.
    </p>`;

  const input = document.getElementById('retention-days');
  const save = async () => {
    const days = parseInt(input.value, 10);
    if (!Number.isFinite(days)) return;
    const btn = document.getElementById('retention-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const res = await apiPut('/settings/retention', { retentionDays: days });
      window.AppSettings.retentionDays = res.retentionDays;
      RANGES = buildRanges(res.retentionDays);
      initRangeGroups();
      toast(res.rescanned
        ? `Keeping ${res.retentionDays} days · transcripts re-scanned`
        : `Keeping ${res.retentionDays} days`);
    } catch {
      toast('Save failed');
    }
    loadSettings();
  };
  document.getElementById('retention-save').addEventListener('click', save);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
}

const THRESHOLD_LABELS = {
  claudeMdWordsWarn:     ['CLAUDE.md words (warn)', 'words'],
  claudeMdWordsError:    ['CLAUDE.md words (error)', 'words'],
  userPromptSubmitHooks: ['UserPromptSubmit hooks', ''],
  sessionStartHooks:     ['SessionStart hooks', ''],
  mcpServers:            ['MCP server count', ''],
  mcpSchemaTokens:       ['MCP schema tokens', 'tok'],
  cacheHitRateMin:       ['Min cache hit rate', '%'],
  singleTurnTokensWarn:  ['Single-turn warn threshold', 'tok'],
  singleSessionTokensWarn: ['Single-session warn threshold', 'tok'],
};

function renderThresholds(t) {
  const form = document.getElementById('thresholds-form');
  form.innerHTML = Object.entries(THRESHOLD_LABELS).map(([key, [label, unit]]) => `
    <div class="threshold-row" data-key="${key}">
      <span class="threshold-label">${label}</span>
      <span class="threshold-val" data-val="${t[key]}">${fmt.tokens(t[key])}</span>
      <span class="threshold-unit">${unit}</span>
    </div>
  `).join('');

  form.querySelectorAll('.threshold-val').forEach(el => {
    el.addEventListener('click', () => startEditThreshold(el));
  });
}

function startEditThreshold(el) {
  const raw = el.dataset.val;
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'threshold-input';
  input.value = raw;
  el.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const key = input.closest('[data-key]')?.dataset.key;
    const val = parseFloat(input.value);
    if (!isNaN(val) && key) {
      try {
        await apiPut('/settings/thresholds', { [key]: val });
        toast('Threshold saved');
      } catch { toast('Save failed'); }
    }
    loadSettings();
  };
  input.addEventListener('keydown', e => { if (e.key==='Enter') commit(); else if (e.key==='Escape') loadSettings(); });
  input.addEventListener('blur', commit);
}

function renderPricing(p) {
  const form = document.getElementById('pricing-form');
  const models = Object.entries(p.models ?? {});
  form.innerHTML = `<table style="width:100%;font-size:12px">
    <thead><tr>
      <th style="text-align:left;padding:6px 0;color:var(--dim)">Model</th>
      <th style="text-align:right;color:var(--dim);padding:0 8px">Input</th>
      <th style="text-align:right;color:var(--dim);padding:0 8px">Output</th>
    </tr></thead>
    <tbody>${models.map(([model, mp]) => `<tr>
      <td style="padding:6px 0;color:var(--dim)">${esc(model)}</td>
      <td class="td-num" style="padding:0 8px">$${mp.inputPer1M}</td>
      <td class="td-num" style="padding:0 8px">$${mp.outputPer1M}</td>
    </tr>`).join('')}</tbody>
  </table>
  <p class="text-dim" style="font-size:11px;margin-top:8px">Edit <code>data/pricing.json</code> to update. Cache write 5m: 1.25× input · 1h: 2× · read: 0.1×</p>`;
}

// ===== Init =====

document.addEventListener('DOMContentLoaded', async () => {
  registerEchartsTheme();
  // Retention decides which ranges exist, so it must land before the first
  // chart, KPI card or Harness tab is rendered.
  await loadRetention();
  initRangeGroups();

  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Light / dark theme toggle — persisted, re-themes charts in place.
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    registerEchartsTheme();
    loadTab(currentTab);
    if (!document.getElementById('sd-page').hidden) refreshSessionDetail();
  });

  let searchTimer = null;
  document.getElementById('search-input').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      runsState.search = e.target.value;
      loadRuns();
    }, 300);
  });

  document.getElementById('project-filter').addEventListener('change', e => {
    runsState.project = e.target.value;
    loadRuns();
  });

  document.getElementById('runs-prev').addEventListener('click', () => {
    if (runsState.page > 0) { runsState.page--; loadRuns(false); }
  });
  document.getElementById('runs-next').addEventListener('click', () => {
    runsState.page++;
    loadRuns(false);
  });

  await loadProviders();

  const validTabs = Object.keys(PAGE_META);
  const runLink = location.hash.match(/^#run=(.+)$/);
  const hashTab = location.hash.replace('#', '');
  const initialTab = validTabs.includes(hashTab) ? hashTab : runLink ? 'runs' : 'dashboard';
  switchTab(initialTab);
  // Deep link: #run=<run_id> opens that run's session-tree page directly.
  if (runLink) openRunDetail(decodeURIComponent(runLink[1]), '', '');
});

// ===== Session Detail — Session Trees =====
//
// One SESSION (run) = one or more AGENTS. Every agent gets its own tree:
// the main agent's tree first, then each sub-agent's tree below it. Inside a
// tree the top level is the chronological spine (prompt → API call → hook →
// …) and children carry what each step did: tool calls with results, MCP
// calls, injected context, thinking, errors. Abandoned uuid branches (edits,
// retries) render as collapsed ⎇ sub-trees.

const NODE_ICON = {
  prompt: '●', assistant: '✦', text: '¶', thinking: '∿',
  context: '✚', hook: '⚡', api_error: '✕', compact: '▣',
  fallback: '⤷', info: '·', branch: '⎇',
};
const CAT_ICON = { tool: '⚙', mcp: '⇄', task: '◈', skill: '❖' };
const KIND_TITLES = {
  prompt: 'User prompt', assistant: 'LLM call', text: 'Assistant text',
  thinking: 'Thinking', tool: 'Tool call', context: 'Injected context',
  hook: 'Hook', api_error: 'API error', compact: 'Context compaction',
  fallback: 'Model fallback', info: 'Info', branch: 'Abandoned branch',
};

let openRunArgs = null;
let currentRunData = null;         // {run, agents}
let treeNodeIndex = new Map();     // nid -> {node, agentId}
let selectedNodeRow = null;

function refreshSessionDetail() {
  if (openRunArgs) openRunDetail(...openRunArgs);
}

function nodeIcon(n) {
  return n.kind === 'tool' ? (CAT_ICON[n.cat] ?? '⚙') : (NODE_ICON[n.kind] ?? '·');
}

function fmtClock(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return ''; }
}

async function openRunDetail(runId, title, cwd) {
  openRunArgs = [runId, title, cwd];
  const sdPage  = document.getElementById('sd-page');
  const sdBody  = document.getElementById('sd-body');
  const agentsEl = document.getElementById('sd-agents');
  const canvasEl = document.getElementById('sd-tree-view');
  const detailEl = document.getElementById('sd-detail');

  // Fresh run → back to the Tree view; the Usage report reloads on demand.
  runUsageCache = null;
  setRunView('tree');

  document.getElementById('modal-title').textContent = title || 'Run';
  document.getElementById('modal-subtitle').textContent = cwd ? `${cwd}  ·  ${runId}` : runId;
  document.getElementById('sd-stats').textContent = '';
  agentsEl.innerHTML = '<div class="sd-placeholder text-dim">Loading…</div>';
  canvasEl.innerHTML = '<div class="sd-placeholder text-dim">Loading…</div>';
  detailEl.innerHTML = '<div class="sd-placeholder text-dim">← Click a node to view details</div>';

  sdBody.classList.remove('show-detail', 'show-agents');
  document.querySelectorAll('.sd-panel-tab').forEach(b => b.classList.toggle('active', b.dataset.panel === 'map'));

  sdPage.hidden = false;
  document.body.style.overflow = 'hidden';

  try {
    const runData = await api(`/run/${runId}`);
    currentRunData = runData;
    const agents = runData.agents || [];
    if (!title && runData.run?.title) {
      document.getElementById('modal-title').textContent = runData.run.title;
      document.getElementById('modal-subtitle').textContent = runData.run.cwd ? `${runData.run.cwd}  ·  ${runId}` : runId;
    }

    // Fetch every agent's tree in parallel — all trees belong to this session.
    const treeResults = await Promise.allSettled(
      agents.map(a => api(`/agent/${a.agent_id}/tree`))
    );
    const trees = new Map();
    treeResults.forEach((r, i) => {
      if (r.status === 'fulfilled') trees.set(agents[i].agent_id, r.value);
    });

    renderAgentSidebar(runData);
    renderSessionTrees(runData, trees);
    renderSessionStats(trees);
  } catch (e) {
    agentsEl.innerHTML = '';
    canvasEl.innerHTML = '';
    detailEl.innerHTML = `<p class="text-error">${esc(e.message)}</p>`;
  }
}

function renderSessionStats(trees) {
  const sum = { prompts: 0, apiCalls: 0, tools: 0, mcp: 0, tasks: 0, hooks: 0, errors: 0, compactions: 0, branches: 0 };
  for (const t of trees.values()) {
    for (const k of Object.keys(sum)) sum[k] += t.stats?.[k] ?? 0;
  }
  const parts = [
    `${sum.prompts} prompt${sum.prompts !== 1 ? 's' : ''}`,
    `${sum.apiCalls} LLM call${sum.apiCalls !== 1 ? 's' : ''}`,
    `${sum.tools} tool${sum.tools !== 1 ? 's' : ''}`,
  ];
  if (sum.mcp) parts.push(`${sum.mcp} MCP`);
  if (sum.tasks) parts.push(`${sum.tasks} sub-agent${sum.tasks !== 1 ? 's' : ''}`);
  if (sum.hooks) parts.push(`${sum.hooks} hook${sum.hooks !== 1 ? 's' : ''}`);
  if (sum.errors) parts.push(`${sum.errors} error${sum.errors !== 1 ? 's' : ''}`);
  if (sum.compactions) parts.push(`${sum.compactions} compaction${sum.compactions !== 1 ? 's' : ''}`);
  if (sum.branches) parts.push(`${sum.branches} branch${sum.branches !== 1 ? 'es' : ''}`);
  document.getElementById('sd-stats').textContent = parts.join(' · ');
}

function renderAgentSidebar(runData) {
  const el = document.getElementById('sd-agents');
  const agents = runData.agents || [];
  if (agents.length === 0) {
    el.innerHTML = '<div class="sd-placeholder text-dim">No agents</div>';
    return;
  }

  const header = `<div class="sd-agents-title">Agents · ${agents.length}</div>`;
  const items = agents.map(a => {
    const isChild = a.is_subagent === 1;
    const title = a.title?.trim() || a.description?.trim() || '(untitled)';
    const pill = a.agent_type ? `<span class="sd-agent-type-pill" title="Sub-agent type (the agent definition used for this spawn)">${esc(a.agent_type)}</span>` : '';
    const tokens = fmt.tokens(a.total ?? 0);
    return `<div class="sd-agent-item ${isChild ? 'child' : ''}" data-aid="${esc(a.agent_id)}">
      <div class="sd-agent-title">${pill}${esc(title)}</div>
      <div class="sd-agent-meta">${a.turn_count ?? 0} turns · ${tokens} tokens</div>
    </div>`;
  }).join('');
  el.innerHTML = header + items;

  el.querySelectorAll('.sd-agent-item').forEach(item => {
    item.addEventListener('click', () => focusAgentTree(item.dataset.aid));
  });
}

function focusAgentTree(agentId) {
  document.querySelectorAll('.sd-agent-item').forEach(it => {
    it.classList.toggle('active', it.dataset.aid === agentId);
  });
  const target = document.getElementById(`tree-agent-${agentId}`);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1200);
  }
  // Mobile: make sure the map panel is visible
  if (window.innerWidth <= 640) {
    const body = document.getElementById('sd-body');
    body.classList.remove('show-detail', 'show-agents');
    document.querySelectorAll('.sd-panel-tab').forEach(b => b.classList.toggle('active', b.dataset.panel === 'map'));
  }
}

// --- tree rendering ---

let _nidCounter = 0;

function renderSessionTrees(runData, trees) {
  const canvasEl = document.getElementById('sd-tree-view');
  const agents = runData.agents || [];
  treeNodeIndex = new Map();
  selectedNodeRow = null;
  _nidCounter = 0;

  if (agents.length === 0) {
    canvasEl.innerHTML = '<div class="sd-placeholder text-dim">No agents in this run.</div>';
    return;
  }

  // Sub-agents claimable by Task nodes (matched by description, then order)
  const subagents = agents.filter(a => a.is_subagent === 1);
  const claimed = new Set();
  function claimSubagent(taskDesc) {
    if (taskDesc) {
      const m = subagents.find(a => !claimed.has(a.agent_id) && (a.description === taskDesc || a.title === taskDesc));
      if (m) { claimed.add(m.agent_id); return m.agent_id; }
    }
    const next = subagents.find(a => !claimed.has(a.agent_id));
    if (next && taskDesc !== undefined) { claimed.add(next.agent_id); return next.agent_id; }
    return null;
  }

  const html = [];
  for (const a of agents) {
    const tree = trees.get(a.agent_id);
    const title = a.title?.trim() || a.description?.trim() || '(untitled)';
    const pill = a.agent_type ? `<span class="sd-agent-type-pill" title="Sub-agent type (the agent definition used for this spawn)">${esc(a.agent_type)}</span>` : '';
    const kindTag = a.is_subagent === 1 ? 'Sub-agent tree' : 'Agent tree';
    html.push(`<section class="tree-agent ${a.is_subagent === 1 ? 'sub' : ''}" id="tree-agent-${esc(a.agent_id)}">`);
    html.push(`<header class="tree-agent-head">
      <span class="tree-agent-kind">${kindTag}</span>
      <span class="tree-agent-title">${pill}${esc(title)}</span>
      <span class="tree-agent-meta">${a.turn_count ?? 0} LLM calls · ${fmt.tokens(a.total ?? 0)} tokens</span>
    </header>`);

    if (!tree || !tree.trees?.length) {
      html.push('<div class="tree-empty text-dim">No transcript data for this agent.</div>');
    } else {
      for (const root of tree.trees) {
        html.push(`<div class="tree-root">`);
        if (tree.trees.length > 1) html.push(`<div class="tree-root-label">${esc(root.label)}</div>`);
        html.push(`<div class="tree-spine">`);
        for (const n of root.spine) html.push(renderNodeHtml(n, a.agent_id, claimSubagent, 0));
        html.push(`</div></div>`);
      }
    }
    html.push('</section>');
  }

  canvasEl.innerHTML = html.join('');

  // Click handling — one delegated listener for rows, toggles, jump links
  canvasEl.onclick = (ev) => {
    const jump = ev.target.closest('.tnode-jump');
    if (jump) {
      ev.stopPropagation();
      focusAgentTree(jump.dataset.target);
      return;
    }
    const toggle = ev.target.closest('.tnode-toggle');
    if (toggle) {
      ev.stopPropagation();
      toggle.closest('.tnode').classList.toggle('collapsed');
      return;
    }
    const row = ev.target.closest('.tnode-row');
    if (row) {
      const rec = treeNodeIndex.get(row.dataset.nid);
      if (rec) {
        if (selectedNodeRow) selectedNodeRow.classList.remove('selected');
        selectedNodeRow = row;
        row.classList.add('selected');
        renderNodeDetail(rec.node, rec.agentId);
      }
    }
  };
}

function renderNodeHtml(n, agentId, claimSubagent, depth) {
  const nid = `n${_nidCounter++}`;
  treeNodeIndex.set(nid, { node: n, agentId });

  let children = n.children || [];
  // An assistant step whose only child is its own text block is redundant —
  // the label already shows the text and the detail panel has the full copy.
  if (n.kind === 'assistant' && children.length === 1 && children[0].kind === 'text') children = [];

  const collapsed = n.kind === 'branch' || depth >= 3;
  const hasKids = children.length > 0;
  const statusCls = n.status ? ` st-${n.status}` : '';
  const catCls = n.cat ? ` cat-${n.cat}` : '';

  // Task tool node → link to the sub-agent's own tree
  let jumpBtn = '';
  if (n.cat === 'task') {
    const target = claimSubagent(n.taskDesc ?? null);
    if (target) jumpBtn = `<button class="tnode-jump" data-target="${esc(target)}" title="Open this sub-agent's tree">tree ↓</button>`;
  }

  const parts = [];
  const iconTitle = n.kind === 'tool'
    ? ({ mcp: 'MCP tool call', task: 'Sub-agent spawn', skill: 'Skill invocation' }[n.cat] ?? 'Tool call')
    : (KIND_TITLES[n.kind] ?? n.kind);
  parts.push(`<div class="tnode k-${esc(n.kind)}${catCls}${collapsed && hasKids ? ' collapsed' : ''}">`);
  parts.push(`<div class="tnode-row${statusCls}" data-nid="${nid}">`);
  parts.push(`<span class="tnode-icon i-${esc(n.cat ?? n.kind)}" title="${esc(iconTitle)}">${nodeIcon(n)}</span>`);
  parts.push(`<span class="tnode-main">`);
  parts.push(`<span class="tnode-label">${esc(n.label ?? '')}</span>`);
  if (n.sub) parts.push(`<span class="tnode-sub">${esc(n.sub)}</span>`);
  parts.push(`</span>`);
  if (jumpBtn) parts.push(jumpBtn);
  if (n.ts) parts.push(`<span class="tnode-ts">${fmtClock(n.ts)}</span>`);
  if (hasKids) parts.push(`<button class="tnode-toggle" title="Collapse / expand">${'▾'}</button>`);
  parts.push(`</div>`);

  if (hasKids) {
    parts.push(`<div class="tnode-kids">`);
    for (const c of children) parts.push(renderNodeHtml(c, agentId, claimSubagent, depth + 1));
    parts.push(`</div>`);
  }
  parts.push(`</div>`);
  return parts.join('');
}

// --- detail panel ---

function renderNodeDetail(n, agentId) {
  const el = document.getElementById('sd-detail');
  el.innerHTML = '';

  const hdr = document.createElement('div');
  hdr.className = 'sd-turn-header';
  const title = n.kind === 'tool'
    ? `${KIND_TITLES.tool}${n.cat && n.cat !== 'tool' ? ` · ${n.cat.toUpperCase()}` : ''}`
    : (KIND_TITLES[n.kind] ?? n.kind);
  hdr.textContent = title;
  el.appendChild(hdr);

  const meta = document.createElement('div');
  meta.className = 'nd-meta';
  const chips = [];
  if (n.ts) chips.push({ text: fmtClock(n.ts) });
  if (n.model) chips.push({ text: n.model.replace(/^claude-/, '') });
  if (n.status === 'err') chips.push({ text: 'error', cls: 'err' });
  if (n.usage) {
    chips.push({ text: `in ${fmt.tokens(n.usage.input)}` });
    chips.push({ text: `out ${fmt.tokens(n.usage.output)}` });
    if (n.usage.cacheRead) chips.push({ text: `cache read ${fmt.tokens(n.usage.cacheRead)}` });
    if (n.usage.cacheCreate) chips.push({ text: `cache write ${fmt.tokens(n.usage.cacheCreate)}` });
  }
  meta.innerHTML = chips.map(c => `<span class="nd-chip${c.cls ? ` ${c.cls}` : ''}">${esc(c.text)}</span>`).join('');
  if (chips.length) el.appendChild(meta);

  const sections = n.sections?.length
    ? n.sections
    : [{ heading: undefined, text: n.label ?? '' }];

  for (const s of sections) {
    const box = document.createElement('div');
    box.className = `nd-section${s.error ? ' err' : ''}`;
    const h = s.heading ? `<div class="nd-section-head">${esc(s.heading)}</div>` : '';
    const cls = s.code ? 'nd-pre code' : 'nd-pre';
    box.innerHTML = `${h}<pre class="${cls}">${esc(s.text)}</pre>`;
    el.appendChild(box);
  }

  el.scrollTop = 0;

  if (window.innerWidth <= 640) {
    document.getElementById('sd-body')?.classList.add('show-detail');
    document.querySelectorAll('.sd-panel-tab').forEach(b => b.classList.toggle('active', b.dataset.panel === 'detail'));
  }
}

function closeRunDetail() {
  document.getElementById('sd-page').hidden = true;
  document.body.style.overflow = '';
}
document.getElementById('sd-back-btn').addEventListener('click', closeRunDetail);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !document.getElementById('sd-page').hidden) closeRunDetail();
});
document.querySelectorAll('.sd-panel-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sd-panel-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const body = document.getElementById('sd-body');
    body.classList.remove('show-detail', 'show-agents');
    if (btn.dataset.panel === 'detail')      body.classList.add('show-detail');
    else if (btn.dataset.panel === 'agents') body.classList.add('show-agents');
  });
});

// ===== Run Detail — Usage view (middle-column Tree | Usage tabs) =====
//
// Numbers come from /api/run/:id/usage, i.e. the deduplicated turns table —
// they match the dashboard exactly. Buckets attribute each API call to
// base / MCP / skills / sub-agents; costs use the configurable pricing table.

let runUsageCache = null; // { runId, report } — one report per open run

const BUCKET_COLOR = { base: '#5f93d1', mcp: '#e3a838', skills: '#5fb98f', subagents: '#a98cd6' };
const BUCKET_LABEL = { base: 'Base', mcp: 'MCP', skills: 'Skills', subagents: 'Sub-agents' };

const ADVICE_TEXT = {
  'switch-cheaper-model': p => [
    `Switching to ${p.model} could save ~$${p.usd}`,
    `Premium-tier models dominate this run. Re-priced at ${p.model}, the same calls would cost about $${p.usd} (${p.pct}%) less — consider a cheaper model for routine steps. Exact numbers for this run, not an estimate over averages.`,
  ],
  'low-cache-hit': p => [
    `Low cache hit rate (${p.pct}%)`,
    'Little of the input side was served from prompt cache. Keep system prompts and instruction files stable across turns and avoid long idle gaps so the cache stays warm.',
  ],
  'subagents-heavy': p => [
    `${p.pct}% of tokens burned inside sub-agents`,
    'Most usage happened inside spawned sub-agents. Check whether some of that work could run inline, or whether the sub-agents could use a cheaper model.',
  ],
};

function setRunView(view) {
  document.querySelectorAll('.sd-view-tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('sd-tree-view').hidden = view !== 'tree';
  document.getElementById('sd-usage-view').hidden = view !== 'usage';
  if (view === 'usage') loadRunUsage();
}
document.querySelectorAll('.sd-view-tab').forEach(btn => {
  btn.addEventListener('click', () => setRunView(btn.dataset.view));
});

async function loadRunUsage() {
  const runId = openRunArgs?.[0];
  if (!runId) return;
  if (runUsageCache?.runId === runId) return; // already rendered for this run
  const el = document.getElementById('sd-usage-view');
  el.innerHTML = '<div class="sd-placeholder text-dim">Loading usage…</div>';
  try {
    const report = await api(`/run/${encodeURIComponent(runId)}/usage`);
    runUsageCache = { runId, report };
    renderRunUsage(report);
  } catch (e) {
    el.innerHTML = `<p class="text-error">${esc(e.message)}</p>`;
  }
}

function renderRunUsage(r) {
  const el = document.getElementById('sd-usage-view');
  const kpis = [
    { label: 'Est. cost (API-equiv)', value: `$${r.total.costUsd.toFixed(2)}` },
    { label: 'Output tokens',         value: fmt.tokens(r.total.output) },
    { label: 'Cache read',            value: fmt.tokens(r.total.cacheRead) },
    { label: 'LLM calls',             value: String(r.turnCount) },
  ];

  const modelRows = r.byModel.map(m => `<tr>
    <td><code>${esc(m.model.replace(/^claude-/, ''))}</code></td>
    <td class="td-num">${fmt.tokens(m.input)}</td>
    <td class="td-num">${fmt.tokens(m.output)}</td>
    <td class="td-num">${fmt.tokens(m.cacheRead)}</td>
    <td class="td-num">$${m.costUsd.toFixed(2)}</td>
  </tr>`).join('');

  const adviceHtml = (r.advice ?? []).map(a => {
    const t = ADVICE_TEXT[a.id]?.(a.params) ?? [a.id, ''];
    return `<div class="usage-advice ${a.severity}">
      <div class="usage-advice-title">${esc(t[0])}</div>
      <div class="usage-advice-detail text-dim">${esc(t[1])}</div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="usage-kpis">${kpis.map(k => `
      <div class="usage-kpi"><div class="usage-kpi-label text-dim">${esc(k.label)}</div>
      <div class="usage-kpi-value">${esc(k.value)}</div></div>`).join('')}
    </div>
    <div class="usage-chart-row">
      <div class="chart-card"><div class="chart-card-title">Cost by bucket</div>
        <div id="chart-run-bucket" style="height:220px"></div></div>
      <div class="chart-card"><div class="chart-card-title">Cumulative spend over the run</div>
        <div id="chart-run-spend" style="height:220px"></div></div>
    </div>
    <div class="chart-card">
      <div class="chart-card-title">By model</div>
      <table class="usage-model-table">
        <thead><tr><th>Model</th><th class="td-num">Input</th><th class="td-num">Output</th>
          <th class="td-num">Cache read</th><th class="td-num">Cost</th></tr></thead>
        <tbody>${modelRows}</tbody>
      </table>
    </div>
    ${adviceHtml ? `<div class="usage-advice-list">${adviceHtml}</div>` : ''}
    <p class="text-dim usage-note">${esc(r.note ?? '')}</p>
  `;

  // Donut: estimated cost per bucket (cost is comparable across buckets;
  // raw token counts are distorted by cheap cache reads).
  // Sorted by cost so the donut starts on the biggest slice — byBucket arrives
  // in fixed key order, which would otherwise put a rounding-error slice first.
  const pieData = Object.entries(r.byBucket)
    .filter(([, v]) => v.costUsd > 0)
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .map(([k, v]) => ({ name: BUCKET_LABEL[k] ?? k, value: +v.costUsd.toFixed(4),
                        itemStyle: { color: BUCKET_COLOR[k] } }));
  const pie = initChart('chart-run-bucket');
  if (pie) {
    if (!pieData.length) renderChartEmpty(pie, 'No cost recorded');
    else pie.setOption({ ...baseOption(),
      tooltip: { trigger: 'item', formatter: p => `${esc(p.name)}: $${p.value} (${p.percent}%)` },
      legend: { bottom: 0, textStyle: { color: COLOR.dim, fontSize: 11 } },
      series: [{ type: 'pie', radius: ['42%', '68%'], center: ['50%', '46%'], data: pieData,
        label: { color: COLOR.dim, fontSize: 11, formatter: p => `${p.name} $${p.value}` } }],
    });
  }

  // Cumulative spend curve across API calls, in order.
  let cum = 0;
  const pts = r.series.map((p, i) => { cum += p.costUsd; return [i + 1, +cum.toFixed(3)]; });
  const spend = initChart('chart-run-spend');
  if (spend) {
    spend.setOption({ ...baseOption(),
      tooltip: { trigger: 'axis', formatter: ps => `Call ${ps[0].value[0]}: $${ps[0].value[1]} cumulative` },
      xAxis: { type: 'value', name: 'call', axisLabel: { color: COLOR.dim }, splitLine: { show: false }, minInterval: 1 },
      yAxis: { type: 'value', axisLabel: { formatter: v => `$${v}`, color: COLOR.dim }, splitLine: { lineStyle: { color: gridLine() } } },
      series: [{ type: 'line', data: pts, showSymbol: false, smooth: true,
        lineStyle: { color: COLOR.purple }, areaStyle: { color: COLOR.purple, opacity: 0.15 } }],
    });
  }
}

import type { Database } from "bun:sqlite";
import { computeCost, computePlanWeight } from "../pricing";
import {
  bucketFor, emptyBuckets, emptyRollup,
  getRunUsage, type BucketRollup, type UsageBucket,
} from "./usageReport";
import { resolveRunKey } from "./runKey";
import { getTopRuns, type TopRunStat } from "./runs";
import { splitMcpToolName, type ProviderFilter } from "./aggregate";
import { clampWarning, type ResolvedWindow } from "./window";
import { pathKey, PATH_COLLATE } from "../paths";
import { diffSnapshots, snapshotAt, type HarnessChange } from "../config/snapshots";

// ============================================================================
// Before/after comparison.
//
// Two questions, one shape of answer:
//   compareRuns    — "these two specific tasks"      (exact, but n = 1)
//   comparePeriods — "everything before vs after"    (noisier, but real coverage)
//
// Both report the same three things: what each side cost, how the sides differ
// once normalized, and which factor moved the money. The last one is the point —
// "cost fell 47%" is not actionable, "you made 40% fewer API calls and each one
// carried 3k fewer tokens" is.
//
// Provider-agnostic throughout: everything reads the shared turns/events tables
// and the neutral snapshot log, so a run recorded by a future adapter compares
// against a Claude Code run without special-casing.
// ============================================================================

const round = (x: number, dp = 4) => Math.round(x * 10 ** dp) / 10 ** dp;
const pct1 = (x: number) => Math.round(x * 10) / 10;

/** Percentage change, or null when the baseline is zero (∞ is not a useful answer). */
function pctChange(before: number, after: number): number | null {
  if (before === 0) return null;
  return pct1(((after - before) / before) * 100);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round(numerator / denominator, 6) : null;
}

// ---- One side of a comparison ----------------------------------------------

export interface TokenTotals {
  input: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cacheRead: number;
  output: number;
  total: number;
}

export interface SideMetrics {
  costUsd: number;
  tokens: TokenTotals;
  turnCount: number;
  runCount: number;
  agentCount: number;
  /** Share of input-side tokens served from cache, 0-100. */
  cacheHitRatePct: number;
  byModel: (BucketRollup & { model: string; sharePct: number })[];
  byBucket: Record<UsageBucket, BucketRollup>;
  /** Normalized rates — the only fair way to read sides of unequal size. */
  costPerRun: number | null;
  costPerTurn: number | null;
  tokensPerTurn: number | null;
}

const emptyTokens = (): TokenTotals =>
  ({ input: 0, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0, output: 0, total: 0 });

interface GroupRow {
  model: string;
  bucket: number;
  is_subagent: number;
  turns: number;
  input: number;
  cw5m: number;
  cw1h: number;
  cr: number;
  out: number;
}

export interface SideFilter {
  fromIso: string;
  untilIso: string;
  provider?: ProviderFilter;
  project?: string;
}

/**
 * Aggregate one window into a comparable side.
 *
 * Groups in SQL by (model, bucket, is_subagent) and prices each group rather
 * than each call. computeCost is linear in every token count for a fixed model,
 * so summing first is exactly equal to pricing first — and it keeps a 30-day
 * window to a handful of rows instead of tens of thousands.
 */
export function periodSide(db: Database, f: SideFilter): SideMetrics {
  const params: (string | number)[] = [f.fromIso, f.untilIso];
  let where = `ts >= ? AND ts < ?`;
  if (f.provider) { where += ` AND provider = ?`; params.push(f.provider); }
  if (f.project) {
    where += ` AND run_id IN (SELECT run_id FROM runs WHERE cwd = ?${PATH_COLLATE})`;
    params.push(f.project);
  }

  const rows = db.query<GroupRow, (string | number)[]>(
    `SELECT COALESCE(model, 'unknown') as model, bucket, is_subagent,
            COUNT(*)                as turns,
            SUM(input_tokens)       as input,
            SUM(cache_create_5m)    as cw5m,
            SUM(cache_create_1h)    as cw1h,
            SUM(cache_read)         as cr,
            SUM(output_tokens)      as out
       FROM turns WHERE ${where}
      GROUP BY model, bucket, is_subagent`
  ).all(...params);

  const counts = db.query<{ runs: number; agents: number }, (string | number)[]>(
    `SELECT COUNT(DISTINCT run_id) as runs, COUNT(DISTINCT agent_id) as agents
       FROM turns WHERE ${where}`
  ).get(...params);

  const tokens = emptyTokens();
  const byBucket = emptyBuckets();
  const byModelMap = new Map<string, BucketRollup>();
  let costUsd = 0;
  let turnCount = 0;

  for (const r of rows) {
    const cost = computeCost(r.model, r.input, r.out, r.cw5m, r.cw1h, r.cr).total;
    const weight = computePlanWeight(r.model, r.input, r.out, r.cw5m, r.cw1h, r.cr);
    const cw = r.cw5m + r.cw1h;
    const groupTotal = r.input + r.out + cw + r.cr;

    tokens.input += r.input;
    tokens.cacheCreate5m += r.cw5m;
    tokens.cacheCreate1h += r.cw1h;
    tokens.cacheRead += r.cr;
    tokens.output += r.out;
    tokens.total += groupTotal;
    costUsd += cost;
    turnCount += r.turns;

    const apply = (roll: BucketRollup) => {
      roll.input += r.input;
      roll.output += r.out;
      roll.cacheCreate += cw;
      roll.cacheRead += r.cr;
      roll.tokens += groupTotal;
      roll.costUsd += cost;
      roll.planWeight += weight;
    };
    apply(byBucket[bucketFor(r.is_subagent, r.bucket)]);
    const m = byModelMap.get(r.model) ?? emptyRollup();
    apply(m);
    byModelMap.set(r.model, m);
  }

  return finishSide({
    costUsd, tokens, turnCount,
    runCount: counts?.runs ?? 0,
    agentCount: counts?.agents ?? 0,
    byBucket, byModelMap,
  });
}

/** Shared tail: derived rates and shares, so both side builders agree. */
function finishSide(raw: {
  costUsd: number; tokens: TokenTotals; turnCount: number;
  runCount: number; agentCount: number;
  byBucket: Record<UsageBucket, BucketRollup>;
  byModelMap: Map<string, BucketRollup>;
}): SideMetrics {
  const inputSide = raw.tokens.input + raw.tokens.cacheCreate5m + raw.tokens.cacheCreate1h + raw.tokens.cacheRead;
  const byModel = [...raw.byModelMap.entries()]
    .map(([model, roll]) => ({
      model, ...roll,
      sharePct: raw.tokens.total ? pct1((roll.tokens / raw.tokens.total) * 100) : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return {
    costUsd: round(raw.costUsd),
    tokens: raw.tokens,
    turnCount: raw.turnCount,
    runCount: raw.runCount,
    agentCount: raw.agentCount,
    cacheHitRatePct: inputSide ? pct1((raw.tokens.cacheRead / inputSide) * 100) : 0,
    byModel,
    byBucket: raw.byBucket,
    costPerRun: ratio(raw.costUsd, raw.runCount),
    costPerTurn: ratio(raw.costUsd, raw.turnCount),
    tokensPerTurn: ratio(raw.tokens.total, raw.turnCount),
  };
}

// ---- Harness usage recorded inside a run -----------------------------------

export interface RunComponents {
  toolCalls: number;
  /** chars/4 estimate of the context those calls injected. */
  toolTokens: number;
  skills: { skill: string; calls: number; estTokens: number }[];
  mcpServers: { server: string; calls: number; estTokens: number }[];
  tools: { tool: string; calls: number; estTokens: number }[];
}

/**
 * Which harness components a run actually used, from the recorded event stream.
 *
 * This is the "harness usage inside the task" half of the question: a CLAUDE.md
 * edit shows up as tokens per turn, but an MCP or skill change shows up here, as
 * calls that stopped happening.
 */
export function getRunComponents(db: Database, runId: string): RunComponents {
  const rows = db.query<{ detail: string | null; extra: string | null; calls: number; tokens: number }, [string]>(
    `SELECT detail, extra, COUNT(*) as calls, COALESCE(SUM(tokens), 0) as tokens
       FROM events WHERE run_id = ? AND kind = 'tool'
      GROUP BY detail, extra`
  ).all(runId);

  const skills = new Map<string, { skill: string; calls: number; estTokens: number }>();
  const servers = new Map<string, { server: string; calls: number; estTokens: number }>();
  const tools = new Map<string, { tool: string; calls: number; estTokens: number }>();
  let toolCalls = 0;
  let toolTokens = 0;

  for (const r of rows) {
    const name = r.detail ?? "(unknown)";
    toolCalls += r.calls;
    toolTokens += r.tokens;

    const t = tools.get(name) ?? { tool: name, calls: 0, estTokens: 0 };
    t.calls += r.calls; t.estTokens += r.tokens;
    tools.set(name, t);

    if (name === "Skill" && r.extra) {
      const s = skills.get(r.extra) ?? { skill: r.extra, calls: 0, estTokens: 0 };
      s.calls += r.calls; s.estTokens += r.tokens;
      skills.set(r.extra, s);
    } else if (name.startsWith("mcp__")) {
      const { server } = splitMcpToolName(name);
      const s = servers.get(server) ?? { server, calls: 0, estTokens: 0 };
      s.calls += r.calls; s.estTokens += r.tokens;
      servers.set(server, s);
    }
  }

  const byTokens = <T extends { estTokens: number }>(xs: T[]) => xs.sort((a, b) => b.estTokens - a.estTokens);
  return {
    toolCalls, toolTokens,
    skills: byTokens([...skills.values()]),
    mcpServers: byTokens([...servers.values()]),
    tools: byTokens([...tools.values()]),
  };
}

// ---- Attribution ------------------------------------------------------------

export interface Driver {
  factor: "volume" | "tokens-per-turn" | "price-per-token";
  usd: number;
  sharePct: number | null;
  note: string;
}

/**
 * Split the cost delta into three exact terms.
 *
 * With N = API calls, t = tokens per call and p = cost per token, cost = N·t·p,
 * and the difference factors cleanly:
 *
 *   ΔC = (Nₐ − N_b)·t_b·p_b        volume: you made more/fewer calls
 *      + Nₐ·(tₐ − t_b)·p_b         context: each call carried more/less
 *      + Nₐ·tₐ·(pₐ − p_b)          price: the model/cache blend got cheaper
 *
 * The three sum to ΔC exactly — no residual, nothing modelled. Which factor
 * moved is what tells you whether the change worked and how.
 */
export function buildDrivers(before: SideMetrics, after: SideMetrics): Driver[] {
  const nB = before.turnCount, nA = after.turnCount;
  if (nB === 0 || nA === 0) return [];

  const tB = before.tokens.total / nB, tA = after.tokens.total / nA;
  const pB = before.tokens.total ? before.costUsd / before.tokens.total : 0;
  const pA = after.tokens.total ? after.costUsd / after.tokens.total : 0;

  // Round for display, then absorb the rounding residual into the largest term.
  // The exactness of the identity is the whole point of this decomposition, and
  // three independently-rounded figures that visibly miss the reported delta by
  // a hundredth of a cent read as a bug rather than as rounding.
  const [volume, context, price] = reconcile(
    [(nA - nB) * tB * pB, nA * (tA - tB) * pB, nA * tA * (pA - pB)],
    round(after.costUsd - before.costUsd),
  ) as [number, number, number];

  const deltaAbs = Math.abs(volume) + Math.abs(context) + Math.abs(price);
  const share = (x: number) => (deltaAbs > 0 ? pct1((Math.abs(x) / deltaAbs) * 100) : null);
  const dir = (x: number) => (x < 0 ? "saved" : "added");
  const usd2 = (x: number) => Math.abs(round(x, 2));

  const drivers: Driver[] = [
    {
      factor: "volume", usd: volume, sharePct: share(volume),
      note: `${nB} → ${nA} API calls ${dir(volume)} $${usd2(volume)}`,
    },
    {
      factor: "tokens-per-turn", usd: context, sharePct: share(context),
      note: `${Math.round(tB).toLocaleString()} → ${Math.round(tA).toLocaleString()} tokens per call ${dir(context)} $${usd2(context)}`,
    },
    {
      factor: "price-per-token", usd: price, sharePct: share(price),
      note: `blended price moved ${pctChange(pB, pA) ?? 0}% (model mix and cache hits) — ${dir(price)} $${usd2(price)}`,
    },
  ];
  // Biggest mover first: that is the sentence the report leads with.
  return drivers.sort((x, y) => Math.abs(y.usd) - Math.abs(x.usd));
}

/** Round terms so they still sum exactly to `target`, adjusting the largest. */
function reconcile(terms: number[], target: number): number[] {
  const rounded = terms.map(x => round(x));
  const residual = round(target - rounded.reduce((s, x) => s + x, 0));
  if (residual === 0) return rounded;

  let largest = 0;
  for (let i = 1; i < rounded.length; i++) {
    if (Math.abs(rounded[i]!) > Math.abs(rounded[largest]!)) largest = i;
  }
  rounded[largest] = round(rounded[largest]! + residual);
  return rounded;
}

export interface PriceEvidence {
  cacheHitRatePctBefore: number;
  cacheHitRatePctAfter: number;
  modelSharesBefore: { model: string; sharePct: number }[];
  modelSharesAfter: { model: string; sharePct: number }[];
  /**
   * What the after side would have cost with its own tokens priced at the
   * before side's dominant model — isolates model choice from everything else.
   * Null when either side has no tokens or the model did not change.
   */
  afterAtBeforeModelUsd: number | null;
  beforeDominantModel: string | null;
  afterDominantModel: string | null;
}

/**
 * Evidence for WHY the price term moved, reported separately from the drivers.
 *
 * Deliberately not folded into the sum: model mix and cache hits are entangled
 * (a model switch changes what is cacheable), so any split between them would be
 * an assumption dressed up as arithmetic.
 */
function buildPriceEvidence(before: SideMetrics, after: SideMetrics): PriceEvidence {
  const shares = (s: SideMetrics) => s.byModel.map(m => ({ model: m.model, sharePct: m.sharePct }));
  const domB = before.byModel[0]?.model ?? null;
  const domA = after.byModel[0]?.model ?? null;

  let afterAtBeforeModelUsd: number | null = null;
  if (domB && domA && domB !== domA && after.tokens.total > 0) {
    // Same technique as the run-detail "switch to a cheaper model" advice:
    // re-price the real token counts, do not model a hypothetical workload.
    afterAtBeforeModelUsd = round(
      computeCost(
        domB, after.tokens.input, after.tokens.output,
        after.tokens.cacheCreate5m, after.tokens.cacheCreate1h, after.tokens.cacheRead,
      ).total,
    );
  }

  return {
    cacheHitRatePctBefore: before.cacheHitRatePct,
    cacheHitRatePctAfter: after.cacheHitRatePct,
    modelSharesBefore: shares(before),
    modelSharesAfter: shares(after),
    afterAtBeforeModelUsd,
    beforeDominantModel: domB,
    afterDominantModel: domA,
  };
}

// ---- Deltas ------------------------------------------------------------------

export interface Delta {
  costUsd: number;
  costPct: number | null;
  tokens: number;
  tokensPct: number | null;
  turnCount: number;
  runCount: number;
  costPerRun: number | null;
  costPerRunPct: number | null;
  costPerTurn: number | null;
  costPerTurnPct: number | null;
  tokensPerTurn: number | null;
  tokensPerTurnPct: number | null;
  /** Percentage POINTS, not percent — a cache rate going 20 → 40 moved 20pp. */
  cacheHitRatePpt: number;
}

function buildDelta(before: SideMetrics, after: SideMetrics): Delta {
  const diff = (b: number | null, a: number | null) =>
    b === null || a === null ? null : round(a - b);
  return {
    costUsd: round(after.costUsd - before.costUsd),
    costPct: pctChange(before.costUsd, after.costUsd),
    tokens: after.tokens.total - before.tokens.total,
    tokensPct: pctChange(before.tokens.total, after.tokens.total),
    turnCount: after.turnCount - before.turnCount,
    runCount: after.runCount - before.runCount,
    costPerRun: diff(before.costPerRun, after.costPerRun),
    costPerRunPct: before.costPerRun && after.costPerRun ? pctChange(before.costPerRun, after.costPerRun) : null,
    costPerTurn: diff(before.costPerTurn, after.costPerTurn),
    costPerTurnPct: before.costPerTurn && after.costPerTurn ? pctChange(before.costPerTurn, after.costPerTurn) : null,
    tokensPerTurn: diff(before.tokensPerTurn, after.tokensPerTurn),
    tokensPerTurnPct: before.tokensPerTurn && after.tokensPerTurn ? pctChange(before.tokensPerTurn, after.tokensPerTurn) : null,
    cacheHitRatePpt: pct1(after.cacheHitRatePct - before.cacheHitRatePct),
  };
}

// ---- Harness diff -----------------------------------------------------------

export interface HarnessDiff {
  changes: HarnessChange[];
  capturedBefore: string | null;
  capturedAfter: string | null;
  /** False when a side fell back to the oldest snapshot on record. */
  exact: boolean;
}

function harnessBetween(
  db: Database, provider: string, beforeAt: string, afterAt: string, project?: string | null,
): HarnessDiff | null {
  const b = snapshotAt(db, provider, beforeAt, project);
  const a = snapshotAt(db, provider, afterAt, project);
  if (!b || !a) return null;
  return {
    changes: diffSnapshots(b.snapshot, a.snapshot),
    capturedBefore: b.snapshot.capturedAt,
    capturedAfter: a.snapshot.capturedAt,
    exact: b.exact && a.exact,
  };
}

// ---- Run vs run -------------------------------------------------------------

export interface RunSide extends SideMetrics {
  runKey: string;
  runId: string;
  provider: string;
  title: string | null;
  project: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMinutes: number | null;
  subagentCount: number;
  components: RunComponents;
}

export interface RunComparison {
  mode: "runs";
  before: RunSide;
  after: RunSide;
  delta: Delta;
  drivers: Driver[];
  priceEvidence: PriceEvidence;
  harnessDiff: HarnessDiff | null;
  caveats: string[];
  note: string;
}

interface RunMetaRow {
  run_id: string; run_key: string | null; provider: string;
  title: string | null; cwd: string | null;
  started_at: string | null; last_seen_at: string | null;
  agent_count: number;
}

function runSide(db: Database, key: string, provider?: ProviderFilter): RunSide {
  const resolved = resolveRunKey(db, key, provider);
  const meta = db.query<RunMetaRow, [string]>(
    `SELECT run_id, run_key, provider, title, cwd, started_at, last_seen_at, agent_count
       FROM runs WHERE run_id = ?`
  ).get(resolved.runId);
  if (!meta) throw new Error(`run ${resolved.runKey} has no record`);

  const usage = getRunUsage(db, resolved.runId);
  if (!usage) {
    throw new Error(
      `run ${resolved.runKey} has no recorded API calls — nothing to compare. ` +
      `This happens when a session was started but never sent a request.`
    );
  }

  const subagents = db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) as n FROM agents WHERE run_id = ? AND is_subagent = 1`
  ).get(resolved.runId)?.n ?? 0;

  const tokens: TokenTotals = {
    input: usage.total.input,
    // getRunUsage merges the two cache-write TTLs; re-split them from turns so
    // both comparison modes report the same five token columns.
    ...splitCacheWrites(db, resolved.runId),
    cacheRead: usage.total.cacheRead,
    output: usage.total.output,
    total: usage.total.tokens,
  };

  const byModelMap = new Map<string, BucketRollup>();
  for (const { model, ...roll } of usage.byModel) byModelMap.set(model, roll);

  const started = meta.started_at;
  const ended = meta.last_seen_at;
  const durationMinutes = started && ended
    ? round(Math.max(0, new Date(ended).getTime() - new Date(started).getTime()) / 60_000, 1)
    : null;

  const base = finishSide({
    costUsd: usage.total.costUsd,
    tokens, turnCount: usage.turnCount,
    runCount: 1, agentCount: meta.agent_count,
    byBucket: usage.byBucket, byModelMap,
  });

  return {
    ...base,
    runKey: meta.run_key ?? resolved.runKey,
    runId: meta.run_id,
    provider: meta.provider,
    title: meta.title,
    project: meta.cwd,
    startedAt: started,
    endedAt: ended,
    durationMinutes,
    subagentCount: subagents,
    components: getRunComponents(db, resolved.runId),
  };
}

function splitCacheWrites(db: Database, runId: string): { cacheCreate5m: number; cacheCreate1h: number } {
  const row = db.query<{ cw5m: number; cw1h: number }, [string]>(
    `SELECT COALESCE(SUM(cache_create_5m), 0) as cw5m, COALESCE(SUM(cache_create_1h), 0) as cw1h
       FROM turns WHERE run_id = ?`
  ).get(runId);
  return { cacheCreate5m: row?.cw5m ?? 0, cacheCreate1h: row?.cw1h ?? 0 };
}

/**
 * Compare two specific runs.
 *
 * Chronology is derived, not assumed: whichever run started earlier is the
 * "before" side, so the sign of every delta is meaningful no matter which order
 * the ids were given in.
 */
export function compareRuns(
  db: Database, keyA: string, keyB: string, provider?: ProviderFilter,
): RunComparison {
  const a = runSide(db, keyA, provider);
  const b = runSide(db, keyB, provider);
  const [before, after] = (a.startedAt ?? "") <= (b.startedAt ?? "") ? [a, b] : [b, a];

  const harnessDiff = before.startedAt && after.startedAt && before.provider === after.provider
    ? harnessBetween(db, before.provider, before.startedAt, after.startedAt, before.project)
    : null;

  return {
    mode: "runs",
    before, after,
    delta: buildDelta(before, after),
    drivers: buildDrivers(before, after),
    priceEvidence: buildPriceEvidence(before, after),
    harnessDiff,
    caveats: runCaveats(before, after, harnessDiff),
    note: "Costs are API-equivalent estimates from your pricing table. The earlier-starting run is the baseline.",
  };
}

function runCaveats(before: RunSide, after: RunSide, harness: HarnessDiff | null): string[] {
  const out: string[] = [
    "One run against one run: this measures these two sessions, not the change in general. " +
    "Task difficulty, how much was already cached, and where you interrupted all move the number too.",
  ];

  // Case-folded on Windows: the same directory is recorded with either drive
  // letter case depending on how the session was launched, and calling those two
  // runs incomparable would be wrong in the most common comparison there is.
  if (pathKey(before.project ?? "") !== pathKey(after.project ?? "")) {
    out.push(`Different projects (${before.project ?? "?"} vs ${after.project ?? "?"}) — the workloads are probably not comparable.`);
  }
  if (before.provider !== after.provider) {
    out.push(`Different tools (${before.provider} vs ${after.provider}) — this is a tool comparison, not a before/after of one change.`);
  }

  const ratioTurns = before.turnCount && after.turnCount
    ? Math.max(before.turnCount, after.turnCount) / Math.min(before.turnCount, after.turnCount)
    : 1;
  if (ratioTurns >= 2) {
    out.push(`Very different sizes (${before.turnCount} vs ${after.turnCount} API calls) — read cost per call rather than the totals.`);
  }
  if (before.subagentCount !== after.subagentCount) {
    out.push(`Sub-agent counts differ (${before.subagentCount} vs ${after.subagentCount}); sub-agent work is bucketed separately and can dominate a total.`);
  }
  if (!harness) {
    out.push("No harness snapshot covers these runs, so what changed in your config cannot be shown — only what it cost.");
  } else if (!harness.exact) {
    out.push("At least one run predates the harness snapshot log, so the config diff is approximate.");
  } else if (harness.changes.length === 0) {
    out.push("The harness fingerprint is identical across both runs — any difference came from the work itself, not your configuration.");
  }
  return out;
}

// ---- Period vs period -------------------------------------------------------

export interface PeriodSide extends SideMetrics {
  from: string;
  until: string;
  topRuns: TopRunStat[];
}

export interface PeriodComparison {
  mode: "periods";
  provider: string | null;
  project: string | null;
  before: PeriodSide;
  after: PeriodSide;
  delta: Delta;
  drivers: Driver[];
  priceEvidence: PriceEvidence;
  harnessDiff: HarnessDiff | null;
  caveats: string[];
  note: string;
}

export interface ComparePeriodsOptions {
  provider?: ProviderFilter;
  project?: string;
  topRunLimit?: number;
  includeHarnessDiff?: boolean;
}

/**
 * Compare everything recorded in one window against everything in another.
 *
 * The answer users actually want after an improvement: they do not re-run the
 * same task, they just keep working, and the question is whether the new normal
 * is cheaper. Totals alone cannot say that — a quiet week looks like a win — so
 * the normalized rates carry the verdict and the caveats say when to trust them.
 */
export function comparePeriods(
  db: Database, beforeWindow: ResolvedWindow, afterWindow: ResolvedWindow,
  opts: ComparePeriodsOptions = {},
): PeriodComparison {
  const { provider, project, topRunLimit = 5, includeHarnessDiff = true } = opts;
  const filterFor = (w: ResolvedWindow): SideFilter =>
    ({ fromIso: w.fromIso, untilIso: w.untilIso, provider, project });

  const build = (w: ResolvedWindow): PeriodSide => ({
    ...periodSide(db, filterFor(w)),
    from: w.fromIso,
    until: w.untilIso,
    topRuns: getTopRuns(db, topRunLimit, w.fromIso, provider, w.untilIso, project),
  });

  const before = build(beforeWindow);
  const after = build(afterWindow);

  // Config is per-tool, so a diff needs a concrete provider. "all" has no single
  // harness to compare and is reported without one.
  const snapshotProvider = provider && provider !== "all" ? provider : null;
  const harnessDiff = includeHarnessDiff && snapshotProvider
    ? harnessBetween(db, snapshotProvider, beforeWindow.untilIso, afterWindow.untilIso, project ?? null)
    : null;

  return {
    mode: "periods",
    provider: provider ?? null,
    project: project ?? null,
    before, after,
    delta: buildDelta(before, after),
    drivers: buildDrivers(before, after),
    priceEvidence: buildPriceEvidence(before, after),
    harnessDiff,
    caveats: periodCaveats(before, after, beforeWindow, afterWindow, harnessDiff, snapshotProvider),
    note: "Costs are API-equivalent estimates from your pricing table. Windows are half-open [from, until).",
  };
}

function periodCaveats(
  before: PeriodSide, after: PeriodSide,
  beforeWindow: ResolvedWindow, afterWindow: ResolvedWindow,
  harness: HarnessDiff | null, snapshotProvider: string | null,
): string[] {
  const out: string[] = [];

  for (const w of [beforeWindow, afterWindow]) {
    const warn = clampWarning(w);
    if (warn) out.push(warn);
  }

  if (before.turnCount === 0) out.push(`No API calls recorded in the before window (${before.from} → ${before.until}) — there is nothing to compare against.`);
  if (after.turnCount === 0) out.push(`No API calls recorded in the after window (${after.from} → ${after.until}).`);

  const spanH = (w: ResolvedWindow) =>
    (new Date(w.untilIso).getTime() - new Date(w.fromIso).getTime()) / 3600_000;
  const sB = spanH(beforeWindow), sA = spanH(afterWindow);
  if (sB > 0 && sA > 0 && Math.max(sB, sA) / Math.min(sB, sA) >= 1.5) {
    out.push(
      `The windows are different lengths (${round(sB, 1)}h vs ${round(sA, 1)}h), so the totals are not comparable. ` +
      `Read cost per run and cost per call instead.`
    );
  }

  if (before.runCount && after.runCount) {
    const r = Math.max(before.runCount, after.runCount) / Math.min(before.runCount, after.runCount);
    if (r >= 3) {
      out.push(`Very different activity levels (${before.runCount} vs ${after.runCount} runs) — the per-run rates are far more reliable here than the totals.`);
    }
    if (Math.min(before.runCount, after.runCount) < 3) {
      out.push(`Only ${Math.min(before.runCount, after.runCount)} run(s) on the thinner side — treat the result as a first indication, not a measurement.`);
    }
  }

  if (!snapshotProvider) {
    out.push('No harness diff: configuration is per-tool, so pass a specific provider rather than "all" to see what changed.');
  } else if (!harness) {
    out.push("No harness snapshots cover these windows yet, so the config change behind the delta cannot be named.");
  } else if (harness.changes.length === 0) {
    out.push("The harness fingerprint did not change between these windows — whatever moved the cost, it was not your recorded configuration.");
  }

  return out;
}

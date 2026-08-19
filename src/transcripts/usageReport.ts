import type { Database } from "bun:sqlite";
import { computeCost, computePlanWeight } from "../pricing";

// ============================================================================
// Per-run usage breakdown for the run-detail "Usage" tab.
//
// Provider-agnostic: computed entirely from the deduplicated `turns` table
// (one row per API call), so the numbers match the dashboard exactly —
// unlike tools that re-sum every raw transcript line and over-count 2-4×.
// Buckets: sub-agent turns → "subagents"; main-agent turns classified at
// parse time from the provider's own attribution of the call, falling back to
// its tool calls for older records (skill > mcp > base).
// ============================================================================

export type UsageBucket = "base" | "mcp" | "skills" | "subagents";

export interface BucketRollup {
  tokens: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  costUsd: number;
  /** Rate-limit units, in Claude Code's own weighting — see pricing.ts. */
  planWeight: number;
}

/**
 * Context-window occupancy for a run, in the same terms `/context` reports:
 * the input side of one API call (input + cache write + cache read), which is
 * exactly what that command totals.
 */
export interface ContextOccupancy {
  /** Occupancy of the run's most recent call — what `/context` would show now. */
  lastTokens: number;
  /** Highest occupancy reached, which compaction resets. */
  peakTokens: number;
  /** Model of the most recent call, since the window size depends on it. */
  model: string | null;
}

export interface RunUsageReport {
  runId: string;
  turnCount: number;
  total: BucketRollup;
  byModel: (BucketRollup & { model: string })[];
  byBucket: Record<UsageBucket, BucketRollup>;
  /** What `/context` reports for this session, recomputed from its own calls. */
  context: ContextOccupancy;
  /** Per API call, chronological — the UI draws the cumulative spend curve. */
  series: { ts: string; bucket: UsageBucket; model: string; costUsd: number; output: number }[];
  advice: UsageAdvice[];
  note: string;
}

export interface UsageAdvice {
  id: "switch-cheaper-model" | "low-cache-hit" | "subagents-heavy";
  severity: "suggest" | "info";
  params: Record<string, number | string>;
}

export const emptyRollup = (): BucketRollup =>
  ({ tokens: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, costUsd: 0, planWeight: 0 });

export const emptyBuckets = (): Record<UsageBucket, BucketRollup> => ({
  base: emptyRollup(), mcp: emptyRollup(), skills: emptyRollup(), subagents: emptyRollup(),
});

/**
 * Cost-attribution bucket for an API call. Exported so the comparison tools
 * classify turns exactly as the run-detail Usage tab does — the split has to
 * agree, or a before/after delta would not reconcile with the per-run numbers.
 */
export function bucketFor(isSubagent: number, bucket: number): UsageBucket {
  if (isSubagent) return "subagents";
  return bucket >= 2 ? "skills" : bucket === 1 ? "mcp" : "base";
}

interface TurnRow {
  ts: string;
  model: string | null;
  is_subagent: number;
  bucket: number;
  input_tokens: number;
  cache_create_5m: number;
  cache_create_1h: number;
  cache_read: number;
  output_tokens: number;
}

function bucketOf(r: TurnRow): UsageBucket {
  return bucketFor(r.is_subagent, r.bucket);
}

export function getRunUsage(db: Database, runId: string): RunUsageReport | null {
  const rows = db.query<TurnRow, [string]>(
    `SELECT ts, model, is_subagent, bucket,
            input_tokens, cache_create_5m, cache_create_1h, cache_read, output_tokens
     FROM turns WHERE run_id = ? ORDER BY ts`
  ).all(runId);
  if (rows.length === 0) return null;

  const total = emptyRollup();
  const byBucket = emptyBuckets();
  const byModelMap = new Map<string, BucketRollup>();
  const series: RunUsageReport["series"] = [];

  const add = (roll: BucketRollup, r: TurnRow, cost: number, weight: number) => {
    const cw = r.cache_create_5m + r.cache_create_1h;
    roll.input += r.input_tokens;
    roll.output += r.output_tokens;
    roll.cacheCreate += cw;
    roll.cacheRead += r.cache_read;
    roll.tokens += r.input_tokens + r.output_tokens + cw + r.cache_read;
    roll.costUsd += cost;
    roll.planWeight += weight;
  };

  const context: ContextOccupancy = { lastTokens: 0, peakTokens: 0, model: null };

  for (const r of rows) {
    const model = r.model ?? "unknown";
    const cost = computeCost(model, r.input_tokens, r.output_tokens,
      r.cache_create_5m, r.cache_create_1h, r.cache_read).total;
    const weight = computePlanWeight(model, r.input_tokens, r.output_tokens,
      r.cache_create_5m, r.cache_create_1h, r.cache_read);
    const bucket = bucketOf(r);
    add(total, r, cost, weight);
    add(byBucket[bucket], r, cost, weight);
    const m = byModelMap.get(model) ?? emptyRollup();
    add(m, r, cost, weight);
    byModelMap.set(model, m);

    // Occupancy is the INPUT side only: what the next request has to carry.
    // Sub-agents run their own window, so they cannot speak for the run's.
    if (!r.is_subagent) {
      const occupancy = r.input_tokens + r.cache_create_5m + r.cache_create_1h + r.cache_read;
      context.lastTokens = occupancy;
      context.model = r.model;
      if (occupancy > context.peakTokens) context.peakTokens = occupancy;
    }
    series.push({ ts: r.ts, bucket, model, costUsd: cost, output: r.output_tokens });
  }

  const byModel = [...byModelMap.entries()]
    .map(([model, roll]) => ({ model, ...roll }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return {
    runId,
    turnCount: rows.length,
    total, byModel, byBucket, context, series,
    advice: buildAdvice(total, byModel, byBucket, rows),
    note: "Costs are API-equivalent estimates from your pricing table; buckets are attributed per API call.",
  };
}

const pct1 = (x: number) => Math.round(x * 1000) / 10;
const usd2 = (x: number) => Math.round(x * 100) / 100;

/** Premium-tier detection for the "switch to a cheaper model" advice. */
const PREMIUM_RE = /opus|fable|mythos/i;
const CHEAPER_MODEL = "claude-sonnet-5";

function buildAdvice(
  total: BucketRollup,
  byModel: (BucketRollup & { model: string })[],
  byBucket: Record<UsageBucket, BucketRollup>,
  rows: TurnRow[],
): UsageAdvice[] {
  const out: UsageAdvice[] = [];
  if (total.tokens === 0) return out;

  // 1) Premium models dominate → recompute their turns at the cheaper model's
  //    price and report the exact saving for THIS run (not a generic claim).
  const premium = byModel.filter(m => PREMIUM_RE.test(m.model));
  const premiumTokens = premium.reduce((s, m) => s + m.tokens, 0);
  if (premiumTokens / total.tokens > 0.5) {
    let saving = 0;
    for (const r of rows) {
      if (!r.model || !PREMIUM_RE.test(r.model)) continue;
      const cur = computeCost(r.model, r.input_tokens, r.output_tokens,
        r.cache_create_5m, r.cache_create_1h, r.cache_read).total;
      const alt = computeCost(CHEAPER_MODEL, r.input_tokens, r.output_tokens,
        r.cache_create_5m, r.cache_create_1h, r.cache_read).total;
      saving += cur - alt;
    }
    if (saving > 0.005) {
      out.push({
        id: "switch-cheaper-model", severity: "suggest",
        params: {
          usd: usd2(saving),
          pct: total.costUsd ? pct1(saving / total.costUsd) : 0,
          model: CHEAPER_MODEL,
        },
      });
    }
  }

  // 2) Low cache hit rate on the input side.
  const inputSide = total.input + total.cacheCreate + total.cacheRead;
  if (inputSide > 0) {
    const ratio = total.cacheRead / inputSide;
    if (ratio < 0.3) out.push({ id: "low-cache-hit", severity: "info", params: { pct: pct1(ratio) } });
  }

  // 3) Most tokens burn inside sub-agents.
  const subTokens = byBucket.subagents.tokens;
  if (subTokens / total.tokens > 0.6) {
    out.push({ id: "subagents-heavy", severity: "info", params: { pct: pct1(subTokens / total.tokens) } });
  }

  return out;
}

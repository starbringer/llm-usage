import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { PRICING_PATH } from "./paths";

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cacheWrite5mMult: number;
  cacheWrite1hMult: number;
  cacheReadMult: number;
}

export interface PricingTable {
  models: Record<string, ModelPricing>;
}

/**
 * Rates from platform.claude.com/docs/en/about-claude/pricing, verified 2026-07-29.
 *
 * Cache multipliers are uniform across every model: 1.25× input for the 5-minute
 * TTL, 2× for the 1-hour TTL, 0.1× for a read.
 */
const DEFAULT: PricingTable = {
  models: {
    // Claude Fable 5 / Mythos 5 — $10/$50 per 1M tokens
    "claude-fable-5":               { inputPer1M: 10,  outputPer1M: 50, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
    "claude-mythos-5":              { inputPer1M: 10,  outputPer1M: 50, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
    // Claude Opus 5 / 4.5–4.8 — $5/$25
    "claude-opus-5":                { inputPer1M: 5,   outputPer1M: 25, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
    "claude-opus-4-8":              { inputPer1M: 5,   outputPer1M: 25, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
    "claude-opus-4-7":              { inputPer1M: 5,   outputPer1M: 25, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
    "claude-opus-4-6":              { inputPer1M: 5,   outputPer1M: 25, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
    "claude-opus-4-5":              { inputPer1M: 5,   outputPer1M: 25, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
    // Claude Opus 4.1 / 4 — $15/$75. Dated ids listed because the family
    // fallback below would otherwise price these at the $5/$25 Opus rate.
    "claude-opus-4-1":              { inputPer1M: 15,  outputPer1M: 75, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
    "claude-opus-4-1-20250805":     { inputPer1M: 15,  outputPer1M: 75, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
    "claude-opus-4-0":              { inputPer1M: 15,  outputPer1M: 75, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
    "claude-opus-4-20250514":       { inputPer1M: 15,  outputPer1M: 75, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
    // Claude Sonnet 5 — $2/$10 introductory pricing through 2026-08-31,
    // $3/$15 from 2026-09-01. Update this row on that date.
    "claude-sonnet-5":              { inputPer1M: 2,   outputPer1M: 10, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
    // Claude Sonnet 4.x — $3/$15
    "claude-sonnet-4-6":            { inputPer1M: 3,   outputPer1M: 15, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
    "claude-sonnet-4-5":            { inputPer1M: 3,   outputPer1M: 15, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
    "claude-sonnet-4-0":            { inputPer1M: 3,   outputPer1M: 15, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
    // Claude Haiku 4.5 — $1/$5
    "claude-haiku-4-5":             { inputPer1M: 1,   outputPer1M: 5,  cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
    "claude-haiku-4-5-20251001":    { inputPer1M: 1,   outputPer1M: 5,  cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
    // Claude 3.5 Haiku — $0.80/$4
    "claude-haiku-3-5":             { inputPer1M: 0.8, outputPer1M: 4,  cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
    "claude-3-5-haiku-20241022":    { inputPer1M: 0.8, outputPer1M: 4,  cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1 },
  },
};

let _cache: PricingTable | null = null;

export function getPricing(): PricingTable {
  if (_cache) return _cache;
  if (existsSync(PRICING_PATH)) {
    try { _cache = JSON.parse(readFileSync(PRICING_PATH, "utf-8")) as PricingTable; return _cache; }
    catch { /* fall through */ }
  }
  _cache = structuredClone(DEFAULT);
  return _cache;
}

export function savePricing(t: PricingTable): void {
  _cache = t;
  writeFileSync(PRICING_PATH, JSON.stringify(t, null, 2));
}

export function getModelPricing(model: string): ModelPricing {
  const p = getPricing();
  const exact = p.models[model];
  if (exact) return exact;
  // Unknown ID (new snapshot, region variant): fall back by model family so
  // Opus-tier usage is not silently priced at Sonnet rates. Each target is a
  // row at that family's standard rate — never one carrying promotional
  // pricing, or every unrecognised model would inherit the discount.
  const m = model.toLowerCase();
  const family =
    m.includes("fable") || m.includes("mythos") ? "claude-fable-5" :
    m.includes("opus")   ? "claude-opus-5" :
    m.includes("haiku")  ? "claude-haiku-4-5" :
    "claude-sonnet-4-6";
  return p.models[family] ?? Object.values(p.models)[0]!;
}

export interface TokenCost {
  inputCost: number;
  outputCost: number;
  cacheWrite5mCost: number;
  cacheWrite1hCost: number;
  cacheReadCost: number;
  total: number;
}

export function computeCost(
  model: string,
  input: number,
  output: number,
  cw5m: number,
  cw1h: number,
  cr: number,
): TokenCost {
  const m = getModelPricing(model);
  const div = 1_000_000;
  const inputCost       = (input / div) * m.inputPer1M;
  const outputCost      = (output / div) * m.outputPer1M;
  const cacheWrite5mCost = (cw5m / div) * m.inputPer1M * m.cacheWrite5mMult;
  const cacheWrite1hCost = (cw1h / div) * m.inputPer1M * m.cacheWrite1hMult;
  const cacheReadCost   = (cr / div) * m.inputPer1M * m.cacheReadMult;
  return { inputCost, outputCost, cacheWrite5mCost, cacheWrite1hCost, cacheReadCost,
    total: inputCost + outputCost + cacheWrite5mCost + cacheWrite1hCost + cacheReadCost };
}

// ============================================================================
// Plan weight
//
// Subscription rate limits are not metered in dollars. Claude Code scores each
// call as
//
//   (cache_read + input*10 + cache_write*12.5 + output*50) * tier
//   tier: fable 10, opus 5, haiku 1, anything else 3
//
// which is the API price ratio with a cache read as the unit, and the tier is
// the family's input price per 1M. So plan weight and API cost are the same
// quantity up to a constant — `PLAN_WEIGHT_PER_USD` below — wherever the two
// tables agree.
//
// They disagree in exactly two places, and both are deliberate:
//   - a 1-hour cache write bills at 2x input but is weighted at 1.25x, so a
//     1h-cache-heavy workload costs more in dollars than it consumes in quota;
//   - the tier is per family, so it misses per-model rates the pricing table
//     does carry (legacy Opus 4.x at $15/1M, Sonnet 5 introductory at $2/1M).
//
// Weight is therefore computed from the rate card rather than derived from
// `computeCost`, so it keeps reporting what the plan meter counts even after
// someone edits pricing.json.
// ============================================================================

/** Weight units per API-equivalent dollar, where the two tables agree. */
export const PLAN_WEIGHT_PER_USD = 10_000_000;

const CACHE_WRITE_WEIGHT_MULT = 12.5;

/** Claude Code's model tier: the family's input price per 1M tokens. */
export function planModelTier(model: string): number {
  const m = (model ?? "").toLowerCase();
  if (m.includes("fable") || m.includes("mythos")) return 10;
  if (m.includes("opus")) return 5;
  if (m.includes("haiku")) return 1;
  return 3;
}

/**
 * Rate-limit weight for one call, in Claude Code's own units. Divide by
 * `PLAN_WEIGHT_PER_USD` to read it as "the dollars this would cost on the API".
 */
export function computePlanWeight(
  model: string,
  input: number,
  output: number,
  cw5m: number,
  cw1h: number,
  cr: number,
): number {
  return (cr + input * 10 + (cw5m + cw1h) * CACHE_WRITE_WEIGHT_MULT + output * 50)
    * planModelTier(model);
}

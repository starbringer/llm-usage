import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../db";
import { insertTurn, type TurnRecord } from "./cache";
import { computePlanWeight, planModelTier, PLAN_WEIGHT_PER_USD } from "../pricing";
import { computeCost } from "../pricing";

function db(): Database {
  const d = new Database(":memory:");
  initSchema(d);
  return d;
}

const turn = (o: Partial<TurnRecord> = {}): TurnRecord => ({
  provider: "claude-code",
  agent_id: "agent-a",
  run_id: "run-1",
  is_subagent: 0,
  parent_agent_id: null,
  message_id: "msg_1",
  request_id: "req_1",
  ts: "2026-08-19T00:00:00.000Z",
  model: "claude-opus-5",
  input_tokens: 10,
  cache_create_5m: 0,
  cache_create_1h: 0,
  cache_read: 100,
  output_tokens: 20,
  service_tier: null,
  raw_offset: 0,
  bucket: 0,
  attribution_skill: null,
  attribution_agent: null,
  attribution_plugin: null,
  attribution_mcp_server: null,
  ...o,
});

const rows = (d: Database) =>
  d.query<Record<string, never>, []>("SELECT * FROM turns").all() as unknown as TurnRecord[];

describe("turn dedupe", () => {
  test("repeated content-block lines of one response collapse to a single row", () => {
    const d = db();
    insertTurn(d, turn());
    insertTurn(d, turn());
    insertTurn(d, turn());
    expect(rows(d)).toHaveLength(1);
  });

  test("a fork replaying the same call under a new agent does not add a second row", () => {
    const d = db();
    insertTurn(d, turn({ agent_id: "original", run_id: "run-1" }));
    insertTurn(d, turn({ agent_id: "forked-copy", run_id: "run-2" }));
    const r = rows(d);
    expect(r).toHaveLength(1);
    // The session that actually spent the tokens keeps them.
    expect(r[0]!.agent_id).toBe("original");
    expect(r[0]!.run_id).toBe("run-1");
  });

  test("request_id is the key, so it wins over message_id", () => {
    const d = db();
    insertTurn(d, turn({ request_id: "req_A", message_id: "msg_x" }));
    insertTurn(d, turn({ request_id: "req_A", message_id: "msg_y" }));
    expect(rows(d)).toHaveLength(1);
  });

  test("message_id is the key when there is no request_id", () => {
    const d = db();
    insertTurn(d, turn({ request_id: null, message_id: "msg_only" }));
    insertTurn(d, turn({ request_id: null, message_id: "msg_only" }));
    insertTurn(d, turn({ request_id: null, message_id: "msg_other" }));
    expect(rows(d)).toHaveLength(2);
  });

  test("a record with neither id is never deduplicated", () => {
    const d = db();
    insertTurn(d, turn({ request_id: null, message_id: null }));
    insertTurn(d, turn({ request_id: null, message_id: null }));
    expect(rows(d)).toHaveLength(2);
  });

  test("distinct calls stay distinct", () => {
    const d = db();
    insertTurn(d, turn({ request_id: "req_1" }));
    insertTurn(d, turn({ request_id: "req_2" }));
    expect(rows(d)).toHaveLength(2);
  });
});

describe("partial usage on streamed responses", () => {
  test("the complete output count wins over a partial first line", () => {
    const d = db();
    insertTurn(d, turn({ output_tokens: 3 }));
    insertTurn(d, turn({ output_tokens: 477 }));
    expect(rows(d)[0]!.output_tokens).toBe(477);
  });

  test("a trailing zero-usage record cannot clobber real counts", () => {
    const d = db();
    insertTurn(d, turn({ output_tokens: 896, cache_read: 24924, input_tokens: 2 }));
    insertTurn(d, turn({ output_tokens: 0, cache_read: 0, input_tokens: 0 }));
    const r = rows(d)[0]!;
    expect(r.output_tokens).toBe(896);
    expect(r.cache_read).toBe(24924);
    expect(r.input_tokens).toBe(2);
  });
});

describe("attribution", () => {
  test("attribution survives a line that carries it arriving after one that does not", () => {
    const d = db();
    insertTurn(d, turn());
    insertTurn(d, turn({ attribution_skill: "gate", attribution_mcp_server: "ai-insights" }));
    const r = rows(d)[0]!;
    expect(r.attribution_skill).toBe("gate");
    expect(r.attribution_mcp_server).toBe("ai-insights");
  });

  test("an existing attribution is not blanked by a later line without one", () => {
    const d = db();
    insertTurn(d, turn({ attribution_skill: "gate" }));
    insertTurn(d, turn({ attribution_skill: null }));
    expect(rows(d)[0]!.attribution_skill).toBe("gate");
  });

  test("the highest-priority bucket seen wins", () => {
    const d = db();
    insertTurn(d, turn({ bucket: 0 }));
    insertTurn(d, turn({ bucket: 2 }));
    insertTurn(d, turn({ bucket: 1 }));
    expect(rows(d)[0]!.bucket).toBe(2);
  });
});

describe("provider scoping", () => {
  test("two providers may carry the same call id without merging", () => {
    const d = db();
    insertTurn(d, turn({ provider: "claude-code", request_id: "1", output_tokens: 10 }));
    insertTurn(d, turn({ provider: "other-tool", request_id: "1", output_tokens: 20 }));
    const r = rows(d);
    expect(r).toHaveLength(2);
    expect(r.map((x) => x.output_tokens).sort((a, b) => a - b)).toEqual([10, 20]);
  });
});

describe("plan weight", () => {
  // Claude Code 2.1.235 `_WS`: the family's input price per 1M tokens.
  test("model tiers match Claude Code's", () => {
    expect(planModelTier("claude-fable-5")).toBe(10);
    expect(planModelTier("claude-opus-5")).toBe(5);
    expect(planModelTier("claude-opus-4-1-20250805")).toBe(5);
    expect(planModelTier("claude-sonnet-5")).toBe(3);
    expect(planModelTier("claude-haiku-4-5")).toBe(1);
    expect(planModelTier("")).toBe(3);
  });

  // Claude Code 2.1.235 `bWS`.
  test("the weight formula reproduces Claude Code's, term by term", () => {
    const cc = (cached: number, uncached: number, cw: number, out: number, tierN: number) =>
      (cached + uncached * 10 + cw * 12.5 + out * 50) * tierN;
    expect(computePlanWeight("claude-opus-5", 100, 20, 30, 0, 4000))
      .toBe(cc(4000, 100, 30, 20, 5));
    expect(computePlanWeight("claude-sonnet-5", 7, 8, 9, 0, 10))
      .toBe(cc(10, 7, 9, 8, 3));
    // A 1-hour cache write is weighted identically to a 5-minute one, which is
    // where plan weight and API cost deliberately diverge.
    expect(computePlanWeight("claude-opus-5", 0, 0, 0, 1000, 0))
      .toBe(computePlanWeight("claude-opus-5", 0, 0, 1000, 0, 0));
  });

  test("weight is exactly PLAN_WEIGHT_PER_USD x cost where the tables agree", () => {
    // 5-minute writes only, and a model the pricing table rates at its family
    // tier — the conditions under which the two are the same quantity.
    const [inp, out, cw5m, cw1h, cr] = [1000, 500, 200, 0, 50_000];
    const usd = computeCost("claude-opus-5", inp, out, cw5m, cw1h, cr).total;
    const weight = computePlanWeight("claude-opus-5", inp, out, cw5m, cw1h, cr);
    expect(weight).toBeCloseTo(usd * PLAN_WEIGHT_PER_USD, 3);
  });

  test("a 1h-cache-heavy call costs more than it consumes in quota", () => {
    const usd = computeCost("claude-opus-5", 0, 0, 0, 1_000_000, 0).total;
    const weight = computePlanWeight("claude-opus-5", 0, 0, 0, 1_000_000, 0);
    expect(weight).toBeLessThan(usd * PLAN_WEIGHT_PER_USD);
  });
});

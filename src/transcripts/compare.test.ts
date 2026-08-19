import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import {
  buildDrivers, compareRuns, comparePeriods, getRunComponents, periodSide,
  type SideMetrics,
} from "./compare";
import { runKey } from "./runKey";
import type { ResolvedWindow } from "./window";

// A minimal schema with the columns the comparison reads, in the spirit of
// retention.test.ts — enough to exercise the arithmetic and the caveat rules
// without standing up the real ingest pipeline.
function seedDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE runs (
    run_id TEXT PRIMARY KEY, provider TEXT, run_key TEXT, project_flat TEXT, cwd TEXT,
    title TEXT, started_at TEXT, last_seen_at TEXT, agent_count INTEGER, turn_count INTEGER
  )`);
  db.run(`CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY, provider TEXT, run_id TEXT, is_subagent INTEGER
  )`);
  db.run(`CREATE TABLE turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT, agent_id TEXT, run_id TEXT,
    is_subagent INTEGER DEFAULT 0, message_id TEXT, ts TEXT, model TEXT,
    input_tokens INTEGER DEFAULT 0, cache_create_5m INTEGER DEFAULT 0,
    cache_create_1h INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0, bucket INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT, agent_id TEXT, run_id TEXT,
    ts TEXT, kind TEXT, detail TEXT, tokens INTEGER DEFAULT 0, extra TEXT
  )`);
  db.run(`CREATE TABLE harness_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT, project TEXT,
    captured_at TEXT, fingerprint TEXT, payload TEXT
  )`);
  return db;
}

interface RunOpts {
  id: string;
  provider?: string;
  cwd?: string;
  startedAt: string;
  turns: { model: string; input: number; output: number; cacheRead?: number; bucket?: number; sub?: boolean }[];
}

function addRun(db: Database, o: RunOpts): string {
  const provider = o.provider ?? "claude-code";
  const key = runKey(provider, o.id);
  const last = o.turns.length
    ? new Date(new Date(o.startedAt).getTime() + o.turns.length * 60_000).toISOString()
    : o.startedAt;
  db.run(
    `INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [o.id, provider, key, "flat", o.cwd ?? "/proj", `run ${o.id}`, o.startedAt, last, 1, o.turns.length],
  );
  db.run(`INSERT INTO agents VALUES (?,?,?,0)`, [o.id, provider, o.id]);

  o.turns.forEach((t, i) => {
    db.run(
      `INSERT INTO turns
        (provider,agent_id,run_id,is_subagent,message_id,ts,model,
         input_tokens,cache_create_5m,cache_create_1h,cache_read,output_tokens,bucket)
       VALUES (?,?,?,?,?,?,?,?,0,0,?,?,?)`,
      [provider, o.id, o.id, t.sub ? 1 : 0, `m${i}`,
       new Date(new Date(o.startedAt).getTime() + i * 60_000).toISOString(),
       t.model, t.input, t.cacheRead ?? 0, t.output, t.bucket ?? 0],
    );
  });
  return key;
}

const window = (fromIso: string, untilIso: string, label = "w"): ResolvedWindow =>
  ({ fromIso, untilIso, clamped: false, label, retentionDays: 30 });

describe("periodSide", () => {
  test("aggregates tokens, cost, counts and normalized rates", () => {
    const db = seedDb();
    addRun(db, {
      id: "a", startedAt: "2026-07-10T00:00:00.000Z",
      turns: [
        { model: "claude-sonnet-5", input: 1000, output: 500 },
        { model: "claude-sonnet-5", input: 1000, output: 500 },
      ],
    });

    const side = periodSide(db, {
      fromIso: "2026-07-01T00:00:00.000Z", untilIso: "2026-07-20T00:00:00.000Z",
    });

    expect(side.turnCount).toBe(2);
    expect(side.runCount).toBe(1);
    expect(side.tokens.input).toBe(2000);
    expect(side.tokens.output).toBe(1000);
    expect(side.tokens.total).toBe(3000);
    expect(side.costUsd).toBeGreaterThan(0);
    // Rates are what make unequal windows comparable.
    expect(side.costPerTurn).toBeCloseTo(side.costUsd / 2, 6);
    expect(side.tokensPerTurn).toBe(1500);
  });

  test("the window is half-open, so adjacent periods never double count", () => {
    const db = seedDb();
    addRun(db, {
      id: "edge", startedAt: "2026-07-10T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 100, output: 10 }],
    });
    const boundary = "2026-07-10T00:00:00.000Z";

    const before = periodSide(db, { fromIso: "2026-07-01T00:00:00.000Z", untilIso: boundary });
    const after = periodSide(db, { fromIso: boundary, untilIso: "2026-07-20T00:00:00.000Z" });

    expect(before.turnCount).toBe(0);
    expect(after.turnCount).toBe(1);
  });

  test("splits cost into base / mcp / skills / subagents buckets", () => {
    const db = seedDb();
    addRun(db, {
      id: "b", startedAt: "2026-07-10T00:00:00.000Z",
      turns: [
        { model: "claude-sonnet-5", input: 1000, output: 100, bucket: 0 },
        { model: "claude-sonnet-5", input: 1000, output: 100, bucket: 1 },
        { model: "claude-sonnet-5", input: 1000, output: 100, bucket: 2 },
        { model: "claude-sonnet-5", input: 1000, output: 100, sub: true },
      ],
    });

    const side = periodSide(db, {
      fromIso: "2026-07-01T00:00:00.000Z", untilIso: "2026-07-20T00:00:00.000Z",
    });

    for (const bucket of ["base", "mcp", "skills", "subagents"] as const) {
      expect(side.byBucket[bucket].tokens).toBe(1100);
    }
    // is_subagent wins over the parse-time bucket, matching the run-detail tab.
    expect(side.byBucket.subagents.costUsd).toBeGreaterThan(0);
  });

  test("cache hit rate counts only the input side", () => {
    const db = seedDb();
    addRun(db, {
      id: "c", startedAt: "2026-07-10T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 250, output: 9999, cacheRead: 750 }],
    });

    const side = periodSide(db, {
      fromIso: "2026-07-01T00:00:00.000Z", untilIso: "2026-07-20T00:00:00.000Z",
    });

    // 750 of 1000 input-side tokens came from cache; output is irrelevant to it.
    expect(side.cacheHitRatePct).toBe(75);
  });

  test("an empty window yields zeros and null rates rather than dividing by zero", () => {
    const db = seedDb();
    const side = periodSide(db, {
      fromIso: "2026-07-01T00:00:00.000Z", untilIso: "2026-07-02T00:00:00.000Z",
    });
    expect(side.turnCount).toBe(0);
    expect(side.costUsd).toBe(0);
    expect(side.costPerTurn).toBeNull();
    expect(side.costPerRun).toBeNull();
    expect(side.tokensPerTurn).toBeNull();
  });

  test("the project filter scopes a side", () => {
    const db = seedDb();
    addRun(db, {
      id: "p1", cwd: "/one", startedAt: "2026-07-10T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 100, output: 10 }],
    });
    addRun(db, {
      id: "p2", cwd: "/two", startedAt: "2026-07-10T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 100, output: 10 }],
    });

    const scoped = periodSide(db, {
      fromIso: "2026-07-01T00:00:00.000Z", untilIso: "2026-07-20T00:00:00.000Z", project: "/one",
    });
    expect(scoped.runCount).toBe(1);
  });
});

describe("buildDrivers", () => {
  const side = (turns: number, tokens: number, cost: number): SideMetrics => ({
    costUsd: cost,
    tokens: { input: tokens, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0, output: 0, total: tokens },
    turnCount: turns, runCount: 1, agentCount: 1, cacheHitRatePct: 0,
    byModel: [], byBucket: {
      base: { tokens, input: tokens, output: 0, cacheCreate: 0, cacheRead: 0, costUsd: cost, planWeight: 0 },
      mcp: { tokens: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, costUsd: 0, planWeight: 0 },
      skills: { tokens: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, costUsd: 0, planWeight: 0 },
      subagents: { tokens: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, costUsd: 0, planWeight: 0 },
    },
    costPerRun: cost, costPerTurn: cost / turns, tokensPerTurn: tokens / turns,
  });

  test("the three factors sum exactly to the cost delta", () => {
    // This is the load-bearing property: the attribution is arithmetic, not a
    // model, so it must reconcile to the penny or the report is lying.
    const before = side(20, 200_000, 10);
    const after = side(12, 60_000, 2.5);

    const drivers = buildDrivers(before, after);
    const sum = drivers.reduce((s, d) => s + d.usd, 0);

    expect(sum).toBeCloseTo(after.costUsd - before.costUsd, 6);
  });

  test("the REPORTED figures reconcile, not just the internal maths", () => {
    // Real costs do not land on round numbers. Each term rounded independently
    // can miss the reported delta by a fraction of a cent, which reads as a bug
    // in a report; the residual is folded into the largest term instead.
    const before = side(1340, 21_547_883, 474.5732);
    const after = side(1637, 12_904_211, 270.8502);

    const drivers = buildDrivers(before, after);
    const sum = drivers.reduce((s, d) => s + d.usd, 0);
    const reportedDelta = Math.round((after.costUsd - before.costUsd) * 1e4) / 1e4;

    // Exactly equal at the reported precision — no tolerance.
    expect(Math.round(sum * 1e4) / 1e4).toBe(reportedDelta);
  });

  test("fewer calls at the same size and price shows up as volume alone", () => {
    const before = side(20, 200_000, 10);
    const after = side(10, 100_000, 5);   // same tokens/call, same price/token

    const byFactor = new Map(buildDrivers(before, after).map(d => [d.factor, d.usd]));

    expect(byFactor.get("volume")).toBeCloseTo(-5, 6);
    expect(byFactor.get("tokens-per-turn")).toBeCloseTo(0, 6);
    expect(byFactor.get("price-per-token")).toBeCloseTo(0, 6);
  });

  test("a leaner context at the same call count shows up as tokens-per-turn", () => {
    // The signature of a trimmed CLAUDE.md: same number of calls, each smaller.
    const before = side(10, 100_000, 5);
    const after = side(10, 50_000, 2.5);

    const byFactor = new Map(buildDrivers(before, after).map(d => [d.factor, d.usd]));

    expect(byFactor.get("volume")).toBeCloseTo(0, 6);
    expect(byFactor.get("tokens-per-turn")).toBeCloseTo(-2.5, 6);
    expect(byFactor.get("price-per-token")).toBeCloseTo(0, 6);
  });

  test("a cheaper model at identical volume shows up as price-per-token", () => {
    const before = side(10, 100_000, 10);
    const after = side(10, 100_000, 2);

    const byFactor = new Map(buildDrivers(before, after).map(d => [d.factor, d.usd]));

    expect(byFactor.get("volume")).toBeCloseTo(0, 6);
    expect(byFactor.get("tokens-per-turn")).toBeCloseTo(0, 6);
    expect(byFactor.get("price-per-token")).toBeCloseTo(-8, 6);
  });

  test("an empty side yields no drivers instead of NaN", () => {
    expect(buildDrivers(side(0, 0, 0), side(10, 1000, 1))).toEqual([]);
    expect(buildDrivers(side(10, 1000, 1), side(0, 0, 0))).toEqual([]);
  });

  test("drivers are ordered by how much money they moved", () => {
    const drivers = buildDrivers(side(20, 400_000, 20), side(10, 50_000, 1));
    const magnitudes = drivers.map(d => Math.abs(d.usd));
    expect(magnitudes).toEqual([...magnitudes].sort((a, b) => b - a));
  });
});

describe("getRunComponents", () => {
  test("separates skills, MCP servers and plain tools", () => {
    const db = seedDb();
    addRun(db, {
      id: "r", startedAt: "2026-07-10T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 10, output: 1 }],
    });
    const ev = (detail: string, tokens: number, extra: string | null = null) =>
      db.run(
        `INSERT INTO events (provider,agent_id,run_id,ts,kind,detail,tokens,extra)
         VALUES ('claude-code','r','r','2026-07-10T00:01:00.000Z','tool',?,?,?)`,
        [detail, tokens, extra],
      );
    ev("Read", 400);
    ev("Read", 600);
    ev("mcp__ai-insights__get_run", 300);
    ev("Skill", 2000, "ai-usage-review");

    const c = getRunComponents(db, "r");

    expect(c.toolCalls).toBe(4);
    expect(c.toolTokens).toBe(3300);
    expect(c.skills).toEqual([{ skill: "ai-usage-review", calls: 1, estTokens: 2000 }]);
    expect(c.mcpServers).toEqual([{ server: "ai-insights", calls: 1, estTokens: 300 }]);
    expect(c.tools.find(t => t.tool === "Read")).toEqual({ tool: "Read", calls: 2, estTokens: 1000 });
  });

  test("a run with no tool calls yields empty lists, not undefined", () => {
    const db = seedDb();
    addRun(db, {
      id: "quiet", startedAt: "2026-07-10T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 10, output: 1 }],
    });
    expect(getRunComponents(db, "quiet")).toEqual({
      toolCalls: 0, toolTokens: 0, skills: [], mcpServers: [], tools: [],
    });
  });
});

describe("compareRuns", () => {
  test("the earlier run is the baseline regardless of argument order", () => {
    const db = seedDb();
    const early = addRun(db, {
      id: "early", startedAt: "2026-07-10T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 10_000, output: 1000 }],
    });
    const late = addRun(db, {
      id: "late", startedAt: "2026-07-20T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 4000, output: 400 }],
    });

    const forwards = compareRuns(db, early, late);
    const backwards = compareRuns(db, late, early);

    expect(forwards.before.runId).toBe("early");
    expect(backwards.before.runId).toBe("early");
    // A real saving must read as negative in both orders.
    expect(forwards.delta.costUsd).toBeLessThan(0);
    expect(backwards.delta.costUsd).toBeCloseTo(forwards.delta.costUsd, 8);
  });

  test("resolves runs by key prefix and reports the delta percentage", () => {
    const db = seedDb();
    const a = addRun(db, {
      id: "a", startedAt: "2026-07-10T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 10_000, output: 1000 }],
    });
    const b = addRun(db, {
      id: "b", startedAt: "2026-07-11T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 5000, output: 500 }],
    });

    const cmp = compareRuns(db, a.slice(0, 6), b.slice(0, 6));

    expect(cmp.delta.costPct).toBeCloseTo(-50, 1);
    expect(cmp.mode).toBe("runs");
  });

  test("always warns that a single pair is n = 1", () => {
    const db = seedDb();
    const a = addRun(db, {
      id: "a", startedAt: "2026-07-10T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 100, output: 10 }],
    });
    const b = addRun(db, {
      id: "b", startedAt: "2026-07-11T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 100, output: 10 }],
    });

    // Generated by code, not left to the skill to remember.
    expect(compareRuns(db, a, b).caveats.join(" ")).toContain("One run against one run");
  });

  test("flags a cross-provider pair as a tool comparison", () => {
    const db = seedDb();
    const a = addRun(db, {
      id: "a", provider: "claude-code", startedAt: "2026-07-10T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 100, output: 10 }],
    });
    const b = addRun(db, {
      id: "b", provider: "opencode", startedAt: "2026-07-11T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 100, output: 10 }],
    });

    const cmp = compareRuns(db, a, b);

    expect(cmp.caveats.join(" ")).toContain("Different tools");
    expect(cmp.harnessDiff).toBeNull();
  });

  test("the same project with different drive-letter case is not 'different projects'", () => {
    // Claude Code records the cwd with whatever case the session was launched
    // with, so this is the NORMAL case on Windows — telling the user their two
    // runs are incomparable here would be wrong every time.
    const db = seedDb();
    const a = addRun(db, {
      id: "a", cwd: "g:\\AI\\proj", startedAt: "2026-07-10T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 100, output: 10 }],
    });
    const b = addRun(db, {
      id: "b", cwd: "G:\\AI\\proj", startedAt: "2026-07-11T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 100, output: 10 }],
    });

    const caveats = compareRuns(db, a, b).caveats.join(" ");

    if (process.platform === "win32") {
      expect(caveats).not.toContain("Different projects");
    } else {
      // Elsewhere the two really are distinct directories.
      expect(caveats).toContain("Different projects");
    }
  });

  test("flags wildly different sizes so the reader uses per-call rates", () => {
    const db = seedDb();
    const a = addRun(db, {
      id: "a", startedAt: "2026-07-10T00:00:00.000Z",
      turns: Array.from({ length: 10 }, () => ({ model: "claude-sonnet-5", input: 100, output: 10 })),
    });
    const b = addRun(db, {
      id: "b", startedAt: "2026-07-11T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 100, output: 10 }],
    });

    expect(compareRuns(db, a, b).caveats.join(" ")).toContain("Very different sizes");
  });

  test("a run with no API calls is an explicit error, not a zeroed side", () => {
    const db = seedDb();
    const empty = addRun(db, { id: "empty", startedAt: "2026-07-10T00:00:00.000Z", turns: [] });
    const real = addRun(db, {
      id: "real", startedAt: "2026-07-11T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 100, output: 10 }],
    });

    expect(() => compareRuns(db, empty, real)).toThrow(/no recorded API calls/);
  });
});

describe("comparePeriods", () => {
  test("reports both sides, the delta and the normalized rates", () => {
    const db = seedDb();
    addRun(db, {
      id: "old", startedAt: "2026-07-02T00:00:00.000Z",
      turns: Array.from({ length: 4 }, () => ({ model: "claude-sonnet-5", input: 10_000, output: 1000 })),
    });
    addRun(db, {
      id: "new", startedAt: "2026-07-12T00:00:00.000Z",
      turns: Array.from({ length: 4 }, () => ({ model: "claude-sonnet-5", input: 2500, output: 250 })),
    });

    const cmp = comparePeriods(
      db,
      window("2026-07-01T00:00:00.000Z", "2026-07-10T00:00:00.000Z", "before window"),
      window("2026-07-10T00:00:00.000Z", "2026-07-20T00:00:00.000Z", "after window"),
      { provider: "claude-code" },
    );

    expect(cmp.before.turnCount).toBe(4);
    expect(cmp.after.turnCount).toBe(4);
    expect(cmp.delta.costPct).toBeCloseTo(-75, 1);
    // Same call count both sides, so the whole saving is smaller calls.
    const context = cmp.drivers.find(d => d.factor === "tokens-per-turn");
    expect(context!.usd).toBeCloseTo(cmp.delta.costUsd, 6);
  });

  test("warns when the windows are different lengths", () => {
    const db = seedDb();
    addRun(db, {
      id: "x", startedAt: "2026-07-02T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 100, output: 10 }],
    });
    addRun(db, {
      id: "y", startedAt: "2026-07-12T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 100, output: 10 }],
    });

    const cmp = comparePeriods(
      db,
      window("2026-07-01T00:00:00.000Z", "2026-07-09T00:00:00.000Z"),
      window("2026-07-11T00:00:00.000Z", "2026-07-13T00:00:00.000Z"),
      { provider: "claude-code" },
    );

    expect(cmp.caveats.join(" ")).toContain("different lengths");
  });

  test("says so when a side is empty rather than reporting a 100% saving", () => {
    const db = seedDb();
    addRun(db, {
      id: "only", startedAt: "2026-07-02T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 100, output: 10 }],
    });

    const cmp = comparePeriods(
      db,
      window("2026-07-01T00:00:00.000Z", "2026-07-10T00:00:00.000Z"),
      window("2026-07-10T00:00:00.000Z", "2026-07-20T00:00:00.000Z"),
      { provider: "claude-code" },
    );

    expect(cmp.caveats.join(" ")).toContain("No API calls recorded in the after window");
    expect(cmp.drivers).toEqual([]);
  });

  test('"all" gets no harness diff, because config is per-tool', () => {
    const db = seedDb();
    addRun(db, {
      id: "x", startedAt: "2026-07-02T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 100, output: 10 }],
    });
    addRun(db, {
      id: "y", startedAt: "2026-07-12T00:00:00.000Z",
      turns: [{ model: "claude-sonnet-5", input: 100, output: 10 }],
    });

    const cmp = comparePeriods(
      db,
      window("2026-07-01T00:00:00.000Z", "2026-07-10T00:00:00.000Z"),
      window("2026-07-10T00:00:00.000Z", "2026-07-20T00:00:00.000Z"),
      { provider: "all" },
    );

    expect(cmp.harnessDiff).toBeNull();
    expect(cmp.caveats.join(" ")).toContain("configuration is per-tool");
  });
});

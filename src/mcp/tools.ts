import { getDb } from "../db";
import { listProviders } from "../providers";
import { configAdapterFor } from "../config";
import { buildDependencyGraph } from "../config/graph";
import { getPricing } from "../pricing";
import { getThresholds } from "../thresholds";
import { resolveProvider } from "../api/providerParam";
import {
  getTotals, getDailySeries, getAgents, getProjects, getModelStats,
  getCacheHitRate, getTopTurns, localMidnightIso, parseRange, rangeSinceIso,
  getRangeSeries, getMcpUsage, getSkillUsage, type RangeKey,
} from "../transcripts/aggregate";
import {
  DEFAULT_RETENTION_DAYS, clampDays, clampRange, getRetentionDays, retentionRange,
} from "../retention";
import { listRuns, loadRun, getTopRuns, getActiveRuns } from "../transcripts/runs";
import { getRunUsage } from "../transcripts/usageReport";
import type { UsageAdvice } from "../transcripts/usageReport";
import { resolveRunKey } from "../transcripts/runKey";
import { compareRuns, comparePeriods, getRunComponents } from "../transcripts/compare";
import { resolveWindow } from "../transcripts/window";
import { harnessChangeLog } from "../config/snapshots";

// ============================================================================
// MCP tool registry.
//
// Every HTTP read route has a tool here, calling the same library function the
// route calls — the MCP surface is a second front door onto one implementation,
// not a re-implementation.
//
// Two rules hold for the whole registry:
//   1. READ-ONLY. The write routes (PUT/POST/DELETE on instructions, commands,
//      skills, hooks, thresholds) are deliberately NOT exposed: an assistant
//      that can silently rewrite CLAUDE.md, a hook script or a skill from an
//      analysis run is a footgun. Recommendations come back as text; the user's
//      own agent applies them through its normal, permission-gated edit tools.
//   2. Every tool takes `provider`. Omitted = the default source (Claude Code),
//      "all" = aggregate across every registered source.
//
// Payload discipline: tools that could return whole files (skills, commands,
// instruction files, MCP JSON schemas) default to metadata only and require an
// explicit flag to include bodies. A usage-analysis tool that floods its own
// caller's context would be self-defeating.
// ============================================================================

export interface McpToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  handler(args: Record<string, unknown>): unknown | Promise<unknown>;
}

// ---- shared schema fragments ------------------------------------------------

const providerProp = {
  provider: {
    type: "string",
    description: 'Data source id (default "claude-code"). Use "all" to aggregate every source. Call list_providers for the valid ids.',
  },
} as const;

const rangeProp = {
  range: {
    type: "string",
    pattern: "^(1h|24h|\\d{1,4}d)$",
    description:
      `Time window: "1h", "24h", or N days ("7d", "30d", …). Defaults to — and is capped at — the configured retention window (default ${DEFAULT_RETENTION_DAYS}d; see get_usage_summary.retentionDays). Nothing older than that is stored.`,
  },
} as const;

const limitProp = (fallback: number) => ({
  limit: { type: "integer", minimum: 1, maximum: 500, description: `Max rows. Default ${fallback}.` },
});

const runIdDesc =
  'A run_key from list_runs ("r-9f3a1c2b7e04"), any unique prefix of one ("r-9f3a"), ' +
  "or the provider's own native run id.";

/** A bounded past window. Both bounds accept the same forms. */
const boundDesc =
  'ISO timestamp, a date ("2026-07-15"), or a relative offset meaning "ago" ("7d", "24h"). ' +
  "Dates cover the whole local day.";

const windowProp = (name: string, what: string) => ({
  [name]: {
    type: "object",
    description: what,
    properties: {
      from: { type: "string", description: `Start of the window. ${boundDesc}` },
      until: { type: "string", description: `End of the window, exclusive. Defaults to now. ${boundDesc}` },
    },
    required: ["from"],
    additionalProperties: false,
  },
});

/** Pull a {from, until} object out of raw tool args. */
function windowArg(args: Record<string, unknown>, key: string): { from?: string; until?: string } {
  const raw = args[key];
  if (raw === undefined || raw === null) throw new Error(`"${key}" is required`);
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`"${key}" must be an object like {"from": "2026-07-15", "until": "2026-07-22"}`);
  }
  const o = raw as Record<string, unknown>;
  const pick = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  return { from: pick("from"), until: pick("until") };
}

// ---- argument helpers -------------------------------------------------------

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`"${key}" must be a string`);
  return v;
}

function requiredStr(args: Record<string, unknown>, key: string): string {
  const v = str(args, key);
  if (!v) throw new Error(`"${key}" is required`);
  return v;
}

function int(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${key}" must be a number`);
  return Math.trunc(n);
}

function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`"${key}" must be a boolean`);
}

/** Provider filter for the usage queries, or a thrown error naming valid ids. */
function providerFilter(args: Record<string, unknown>): string | null {
  const res = resolveProvider(str(args, "provider"));
  if (!res.ok) throw new Error(res.error);
  return res.filter;
}

/** The config adapter for this call, or a thrown error. Config is per-tool. */
function adapter(args: Record<string, unknown>) {
  const requested = str(args, "provider");
  const a = configAdapterFor(requested);
  if (!a) {
    throw new Error(
      requested
        ? `no configuration adapter for provider "${requested}"`
        : "no configuration adapter is registered",
    );
  }
  return a;
}

/** Throw a clear "this provider can't do that" instead of a null-deref. */
function capabilityOr(a: ReturnType<typeof adapter>, method: keyof typeof a, label: string): void {
  if (!a[method]) throw new Error(`${label} is not supported by provider "${a.providerId}"`);
}

/**
 * The range for a tool call: what was asked for, narrowed to the retention
 * window (asking for 90d when only 30 are kept would misreport the answer's
 * span), defaulting to the whole window.
 */
function rangeOf(args: Record<string, unknown>): RangeKey {
  return clampRange(parseRange(str(args, "range")) ?? retentionRange());
}

// ---- advice rendering -------------------------------------------------------
// The HTTP API returns advice as { id, params } so the UI can localize it. An
// assistant reading this needs prose, so the MCP layer renders it.

const ADVICE_TEXT: Record<UsageAdvice["id"], (p: Record<string, number | string>) => string> = {
  "switch-cheaper-model": p =>
    `Premium-tier models dominate this run. Re-priced at ${p["model"]}, the same calls would cost about $${p["usd"]} (${p["pct"]}%) less.`,
  "low-cache-hit": p =>
    `Only ${p["pct"]}% of the input side was served from prompt cache. Keep instruction files and system prompts stable across turns and avoid long idle gaps.`,
  "subagents-heavy": p =>
    `${p["pct"]}% of tokens burned inside spawned sub-agents. Check whether some of that work could run inline or on a cheaper model.`,
};

function renderAdvice(advice: UsageAdvice[]) {
  return advice.map(a => ({ ...a, message: ADVICE_TEXT[a.id]?.(a.params) ?? a.id }));
}

// ---- projections ------------------------------------------------------------
// Drop the fields that only exist to render a UI, and strip file bodies unless
// the caller explicitly asked for them.

function trimText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

const MAX_FILE_CHARS = 20_000;

// ============================================================================
// The registry
// ============================================================================

export const MCP_TOOLS: McpToolDef[] = [
  // ---- discovery -----------------------------------------------------------
  {
    name: "list_providers",
    title: "List data sources",
    description:
      "List the AI coding tools this app can read, with whether each currently has data on disk. Start here to learn the ids accepted by every other tool's `provider` argument.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => ({
      providers: listProviders(),
      defaultProvider: listProviders()[0]?.id ?? null,
      note: 'Pass any id as `provider`, or "all" to aggregate across every source.',
    }),
  },

  // ---- usage ---------------------------------------------------------------
  {
    name: "get_usage_summary",
    title: "Usage summary",
    description:
      "Headline token and cost totals for today, the last 7 days and the whole retention window, plus that window's cache hit rate and the count of currently active runs. Also reports `retentionDays` — how much history this install keeps — which caps every other tool's range. The starting point for any usage review.",
    inputSchema: { type: "object", properties: { ...providerProp }, additionalProperties: false },
    handler: args => {
      const p = providerFilter(args);
      const db = getDb();
      const retentionDays = getRetentionDays();
      const windowSince = rangeSinceIso(retentionRange());
      return {
        retentionDays,
        today: getTotals(db, localMidnightIso(0), p),
        // Null below an 8-day window: it would just be the window total again.
        sevenDays: retentionDays > 7 ? getTotals(db, localMidnightIso(7), p) : null,
        window: { days: retentionDays, totals: getTotals(db, windowSince, p) },
        cacheHitRatePct: getCacheHitRate(db, windowSince, p),
        activeRuns: getActiveRuns(db, undefined, p),
        note: "Costs are API-equivalent estimates from the local pricing table, not billing. Records older than retentionDays are deleted, so no tool can look further back.",
      };
    },
  },
  {
    name: "get_usage_timeseries",
    title: "Token trend",
    description:
      "Token totals over time, split into input / cache-write / cache-read / output. Buckets adapt to the range: 5-minute for 1h, hourly for 24h, daily otherwise. Use it to spot spikes and cache-miss patterns.",
    inputSchema: {
      type: "object",
      properties: { ...providerProp, ...rangeProp },
      additionalProperties: false,
    },
    handler: args => ({
      range: rangeOf(args),
      buckets: getRangeSeries(getDb(), rangeOf(args), providerFilter(args)),
    }),
  },
  {
    name: "get_model_usage",
    title: "Usage by model",
    description:
      "Token totals per model over the range. Use it to check whether expensive models are doing routine work.",
    inputSchema: {
      type: "object",
      properties: { ...providerProp, ...rangeProp },
      additionalProperties: false,
    },
    handler: args => ({
      range: rangeOf(args),
      models: getModelStats(getDb(), rangeSinceIso(rangeOf(args)), providerFilter(args)),
    }),
  },
  {
    name: "get_project_usage",
    title: "Usage by project",
    description:
      "Token totals, run counts and agent counts per project directory over the range, newest activity first.",
    inputSchema: {
      type: "object",
      properties: { ...providerProp, ...rangeProp },
      additionalProperties: false,
    },
    handler: args => ({
      range: rangeOf(args),
      projects: getProjects(getDb(), rangeSinceIso(rangeOf(args)), providerFilter(args)),
    }),
  },
  {
    name: "list_runs",
    title: "List sessions",
    description:
      "Paginated list of recorded sessions (a run = one logical session, containing one or more agents). Each row carries its run_key — the short stable id (\"r-9f3a1c2b7e04\") to pass to compare_runs — plus title, project, agent/turn counts, token totals and last-active time.",
    inputSchema: {
      type: "object",
      properties: {
        ...providerProp,
        ...limitProp(25),
        offset: { type: "integer", minimum: 0, description: "Rows to skip. Default 0." },
        project: { type: "string", description: "Filter to one project directory (exact cwd)." },
        search: { type: "string", description: "Substring match on run title or project path." },
      },
      additionalProperties: false,
    },
    handler: args => listRuns(getDb(), {
      limit: Math.min(int(args, "limit", 25), 500),
      offset: int(args, "offset", 0),
      project: str(args, "project"),
      search: str(args, "search"),
      provider: providerFilter(args),
    }),
  },
  {
    name: "get_run",
    title: "Session detail",
    description:
      "One run with every agent it contains (including spawned sub-agents), each with its model, turn count and token totals.",
    inputSchema: {
      type: "object",
      properties: { ...providerProp, runId: { type: "string", description: runIdDesc } },
      required: ["runId"],
      additionalProperties: false,
    },
    handler: args => {
      const db = getDb();
      const { runId } = resolveRunKey(db, requiredStr(args, "runId"), providerFilter(args));
      const detail = loadRun(db, runId);
      if (!detail) throw new Error("run not found");
      return detail;
    },
  },
  {
    name: "get_run_usage",
    title: "Session cost breakdown",
    description:
      "Cost breakdown for one run: totals, per-model rollup, and per-call attribution into base / MCP / skills / sub-agents buckets, plus concrete tuning advice computed from this run's real numbers. Every rollup also carries `planWeight`, the subscription rate-limit units the work consumed, and `context` reports the session's context-window occupancy the way /context does. The most useful single tool for explaining why a session was expensive.",
    inputSchema: {
      type: "object",
      properties: {
        ...providerProp,
        runId: { type: "string", description: runIdDesc },
        includeSeries: {
          type: "boolean",
          description: "Include the per-API-call cost series (can be hundreds of rows). Default false.",
        },
        includeComponents: {
          type: "boolean",
          description: "Include which skills, MCP servers and tools this run actually invoked, with estimated injected tokens. Default false.",
        },
      },
      required: ["runId"],
      additionalProperties: false,
    },
    handler: args => {
      const db = getDb();
      const resolved = resolveRunKey(db, requiredStr(args, "runId"), providerFilter(args));
      const report = getRunUsage(db, resolved.runId);
      if (!report) throw new Error("run not found");
      const { series, advice, ...rest } = report;
      return {
        runKey: resolved.runKey,
        ...rest,
        advice: renderAdvice(advice),
        ...(bool(args, "includeComponents") ? { components: getRunComponents(db, resolved.runId) } : {}),
        ...(bool(args, "includeSeries") ? { series } : { seriesOmitted: series.length }),
      };
    },
  },
  {
    name: "get_top_runs",
    title: "Most expensive sessions",
    description: "Runs ranked by total tokens over the range. Use it to find which sessions are worth reviewing.",
    inputSchema: {
      type: "object",
      properties: { ...providerProp, ...rangeProp, ...limitProp(10) },
      additionalProperties: false,
    },
    handler: args => ({
      range: rangeOf(args),
      runs: getTopRuns(getDb(), Math.min(int(args, "limit", 10), 500),
        rangeSinceIso(rangeOf(args)), providerFilter(args)),
    }),
  },
  {
    name: "get_top_turns",
    title: "Most expensive API calls",
    description:
      "The single largest API calls by total tokens, with model, timestamp and owning agent. Outliers here usually mean a huge tool result or an over-full context.",
    inputSchema: {
      type: "object",
      properties: { ...providerProp, ...limitProp(10) },
      additionalProperties: false,
    },
    handler: args => ({
      turns: getTopTurns(getDb(), Math.min(int(args, "limit", 10), 500), providerFilter(args)),
    }),
  },

  // ---- Change impact: did an improvement actually save anything? ----
  {
    name: "compare_runs",
    title: "Compare two sessions",
    description:
      "Cost delta between two specific runs, decomposed into the three factors that can move it: how many API calls were made, how many tokens each call carried, and what the model/cache blend priced them at. The three sum exactly to the delta. Also returns which skills, MCP servers and tools each run used, what changed in the harness config between them, and machine-generated caveats about how far the result can be trusted. Use after re-running a task to check whether a change to CLAUDE.md, a skill, an MCP server or a workflow paid off. The two runs may come from different providers, which makes this a tool-vs-tool comparison instead.",
    inputSchema: {
      type: "object",
      properties: {
        ...providerProp,
        runA: { type: "string", description: `First run. ${runIdDesc}` },
        runB: { type: "string", description: `Second run. ${runIdDesc} Order does not matter — the earlier-starting run is used as the baseline.` },
        includeComponents: {
          type: "boolean",
          description: "Include the full per-tool call histogram for each run. Default true; set false for a compact answer.",
        },
      },
      required: ["runA", "runB"],
      additionalProperties: false,
    },
    handler: args => {
      const result = compareRuns(
        getDb(), requiredStr(args, "runA"), requiredStr(args, "runB"), providerFilter(args),
      );
      if (bool(args, "includeComponents", true)) return result;
      const strip = (s: typeof result.before) => {
        const { components, ...rest } = s;
        return { ...rest, componentSummary: { toolCalls: components.toolCalls, toolTokens: components.toolTokens } };
      };
      return { ...result, before: strip(result.before), after: strip(result.after) };
    },
  },
  {
    name: "compare_periods",
    title: "Compare two time periods",
    description:
      "Everything recorded in one window against everything in another: totals, per-model and per-bucket splits, cache hit rate, and the normalized rates (cost per run, cost per API call, tokens per call) that make windows of unequal size comparable. Returns the same exact three-factor attribution as compare_runs, plus what changed in the harness between the windows. Use when the user improved something and then just kept working rather than re-running one task — the question being whether the new normal is cheaper. Windows are half-open [from, until) so adjacent periods tile without double counting. Asking for a window older than the retention setting is an error, not an empty result, because that data has been deleted.",
    inputSchema: {
      type: "object",
      properties: {
        ...providerProp,
        ...windowProp("before", "The baseline period, before the change."),
        ...windowProp("after", "The period after the change."),
        project: { type: "string", description: "Restrict both sides to one project directory (exact cwd, from list_config_projects)." },
        includeHarnessDiff: {
          type: "boolean",
          description: "Diff the harness fingerprint between the two windows to name what changed. Default true. Needs a specific provider, not \"all\".",
        },
        ...limitProp(5),
      },
      required: ["before", "after"],
      additionalProperties: false,
    },
    handler: args => comparePeriods(
      getDb(),
      resolveWindow(windowArg(args, "before"), "before window"),
      resolveWindow(windowArg(args, "after"), "after window"),
      {
        provider: providerFilter(args),
        project: str(args, "project"),
        topRunLimit: Math.min(int(args, "limit", 5), 500),
        includeHarnessDiff: bool(args, "includeHarnessDiff", true),
      },
    ),
  },
  {
    name: "get_harness_changes",
    title: "Harness change timeline",
    description:
      "When the harness configuration actually changed, and what changed — instruction files, skills, commands, hooks, MCP servers, permissions and settings layers, each with its token delta. Call this FIRST when the user says \"did my change help\" but not when they made it: the timeline supplies the split point for compare_periods instead of asking them to remember. Recorded from periodic fingerprints, so an edit is dated to the next capture after it (within 15 minutes). Nothing before the app first ran is known, and entries age out with the retention window.",
    inputSchema: {
      type: "object",
      properties: {
        ...providerProp,
        ...rangeProp,
      },
      additionalProperties: false,
    },
    handler: args => {
      const p = providerFilter(args);
      // Config is inherently per-tool; "all" has no single harness to diff.
      const provider = p && p !== "all" ? p : (listProviders()[0]?.id ?? "claude-code");
      const range = rangeOf(args);
      const entries = harnessChangeLog(
        getDb(), provider, rangeSinceIso(range), new Date().toISOString(),
      );
      return {
        provider,
        range,
        changePoints: entries.length,
        entries,
        ...(entries.length === 0
          ? { note: "No harness change recorded in this window. Either nothing changed, or the change predates the snapshot log — it starts when this app first ran." }
          : {}),
      };
    },
  },
  {
    name: "get_mcp_usage",
    title: "MCP token usage",
    description:
      "Per configured MCP server over the range: `attributedTokens` / `attributedCostUsd` are the API cost recorded while that server was active — the number that says what it is worth keeping — while `tokens` and the per-tool breakdown size only the call and result payloads. Use it to find servers that cost context without earning it.",
    inputSchema: {
      type: "object",
      properties: { ...providerProp, ...rangeProp },
      additionalProperties: false,
    },
    handler: args => ({
      range: rangeOf(args),
      servers: getMcpUsage(getDb(), rangeSinceIso(rangeOf(args)), providerFilter(args)),
      note: "`attributedTokens` and `attributedCostUsd` are recorded per API call from the provider's own attribution. `tokens` is a chars/4 estimate of each call's input plus result payload.",
    }),
  },
  {
    name: "get_skill_usage",
    title: "Skill token usage",
    description:
      "Skills over the range with `attributedTokens` / `attributedCostUsd` — every API call made while the skill was running, not just the call that invoked it. `calls` and `tokens` cover the invocation itself. Zero-call skills are absent here — cross-reference list_skills to find skills that never fire.",
    inputSchema: {
      type: "object",
      properties: { ...providerProp, ...rangeProp },
      additionalProperties: false,
    },
    handler: args => ({
      range: rangeOf(args),
      skills: getSkillUsage(getDb(), rangeSinceIso(rangeOf(args)), providerFilter(args)),
      note: "`attributedTokens` is what ran under the skill; `tokens` is the injected body of the invocation.",
    }),
  },
  {
    name: "list_agents",
    title: "List agents",
    description:
      "Agents (one transcript each) with their run, project, model, turn count and token totals. Sub-agents are flagged with is_subagent and carry their agent_type.",
    inputSchema: {
      type: "object",
      properties: {
        ...providerProp,
        ...limitProp(25),
        offset: { type: "integer", minimum: 0, description: "Rows to skip. Default 0." },
        project: { type: "string", description: "Filter to one project directory (exact cwd)." },
        search: { type: "string", description: "Substring match on agent title or project path." },
      },
      additionalProperties: false,
    },
    handler: args => getAgents(getDb(), {
      limit: Math.min(int(args, "limit", 25), 500),
      offset: int(args, "offset", 0),
      project: str(args, "project"),
      search: str(args, "search"),
      provider: providerFilter(args),
    }),
  },
  {
    name: "get_daily_usage",
    title: "Daily usage history",
    description:
      "Day-by-day token totals, always in daily buckets (get_usage_timeseries re-buckets to 5-minute or hourly slices on short ranges). Defaults to the full retention window and is capped there.",
    inputSchema: {
      type: "object",
      properties: {
        ...providerProp,
        days: {
          type: "integer",
          minimum: 1,
          maximum: 365,
          description: "Days of history. Defaults to, and is capped at, the retention window.",
        },
      },
      additionalProperties: false,
    },
    handler: args => {
      const days = clampDays(int(args, "days", getRetentionDays()));
      return { days, buckets: getDailySeries(getDb(), days, providerFilter(args)) };
    },
  },

  // ---- harness configuration ----------------------------------------------
  {
    name: "get_harness_capabilities",
    title: "Harness capabilities",
    description:
      "Which configuration sections the provider's adapter supports (instructions, commands, skills, hooks, permissions, MCP, memory, effective config). Check this before calling the other config tools.",
    inputSchema: { type: "object", properties: { ...providerProp }, additionalProperties: false },
    handler: args => {
      const a = adapter(args);
      return { providerId: a.providerId, ...a.capabilities() };
    },
  },
  {
    name: "list_instruction_files",
    title: "Instruction files",
    description:
      "Every always-injected instruction file (CLAUDE.md and friends) with its token and word count, plus an estimate of how many tokens they injected per day over the retention window (`injection.windowDays`). The single biggest lever on per-turn cost.",
    inputSchema: { type: "object", properties: { ...providerProp }, additionalProperties: false },
    handler: args => {
      const a = adapter(args);
      capabilityOr(a, "listInstructions", "instructions");
      return a.listInstructions?.(getDb());
    },
  },
  {
    name: "read_instruction_file",
    title: "Read an instruction file",
    description:
      "Full text of one instruction file listed by list_instruction_files. Read it before recommending edits — advice about a CLAUDE.md you have not read is guesswork.",
    inputSchema: {
      type: "object",
      properties: { ...providerProp, path: { type: "string", description: "Path exactly as returned by list_instruction_files." } },
      required: ["path"],
      additionalProperties: false,
    },
    handler: args => {
      const a = adapter(args);
      capabilityOr(a, "readInstructionFile", "reading instruction files");
      const file = a.readInstructionFile?.(getDb(), requiredStr(args, "path"));
      if (!file) throw new Error("instruction file not found");
      return { ...file, content: trimText(file.content, MAX_FILE_CHARS) };
    },
  },
  {
    name: "list_commands",
    title: "Slash commands",
    description:
      "Slash commands from every source (user / project / plugin) with token cost, argument hints and same-name override marking. Bodies are omitted unless includeContent is set.",
    inputSchema: {
      type: "object",
      properties: {
        ...providerProp,
        includeContent: { type: "boolean", description: "Include each command's full body. Default false." },
      },
      additionalProperties: false,
    },
    handler: args => {
      const a = adapter(args);
      capabilityOr(a, "listCommands", "commands");
      const withBody = bool(args, "includeContent");
      return (a.listCommands?.(getDb()) ?? []).map(cmd =>
        withBody ? { ...cmd, content: trimText(cmd.content, MAX_FILE_CHARS) } : omit(cmd, "content"));
    },
  },
  {
    name: "list_skills",
    title: "Skills",
    description:
      "Every installed skill with its description, token cost, trigger keywords, bundled references/scripts, and its RECORDED invocations (`calls`) and injected tokens (`estTokens`) over the retention window. Comparing cost against calls is how you find skills that are not paying for themselves. Bodies are omitted unless includeContent is set.",
    inputSchema: {
      type: "object",
      properties: {
        ...providerProp,
        includeContent: { type: "boolean", description: "Include each SKILL.md body. Default false." },
      },
      additionalProperties: false,
    },
    handler: args => {
      const a = adapter(args);
      capabilityOr(a, "listSkills", "skills");
      const withBody = bool(args, "includeContent");
      return (a.listSkills?.(getDb()) ?? []).map(skill =>
        withBody ? { ...skill, content: trimText(skill.content, MAX_FILE_CHARS) } : omit(skill, "content"));
    },
  },
  {
    name: "list_hooks",
    title: "Hooks",
    description:
      "Every configured hook across all settings layers, with its event, matcher, action type, resolved script path and RECORDED fire count (`fires`) over the retention window (`windowDays`). A hook that never fires is either mis-matched or dead config.",
    inputSchema: { type: "object", properties: { ...providerProp }, additionalProperties: false },
    handler: args => {
      const a = adapter(args);
      capabilityOr(a, "listHooks", "hooks");
      return a.listHooks?.(getDb());
    },
  },
  {
    name: "read_hook_script",
    title: "Read a hook script",
    description: "Source of a hook's script file, using the scriptPath reported by list_hooks.",
    inputSchema: {
      type: "object",
      properties: { ...providerProp, path: { type: "string", description: "scriptPath exactly as returned by list_hooks." } },
      required: ["path"],
      additionalProperties: false,
    },
    handler: args => {
      const a = adapter(args);
      capabilityOr(a, "readHookScript", "reading hook scripts");
      const file = a.readHookScript?.(getDb(), requiredStr(args, "path"));
      if (!file) throw new Error("hook script not found");
      return { ...file, content: trimText(file.content, MAX_FILE_CHARS) };
    },
  },
  {
    name: "get_permissions",
    title: "Permission rules",
    description:
      "Merged allow / deny / ask rules across settings layers, with rules shadowed by a higher-priority layer marked. Thin allowlists are a common cause of repeated approval prompts.",
    inputSchema: {
      type: "object",
      properties: {
        ...providerProp,
        project: { type: "string", description: "Project directory whose layers to merge in. Omit for user scope only." },
      },
      additionalProperties: false,
    },
    handler: args => {
      const a = adapter(args);
      capabilityOr(a, "permissionModel", "permissions");
      return a.permissionModel?.(getDb(), str(args, "project"));
    },
  },
  {
    name: "list_mcp_servers",
    title: "Configured MCP servers",
    description:
      "MCP servers found in the tool's config files, with scope, transport, tool count, schema token cost and probe diagnostics. Cross-reference get_mcp_usage: a server with a large schema cost and no calls is pure overhead. JSON schemas are omitted unless includeSchemas is set.",
    inputSchema: {
      type: "object",
      properties: {
        ...providerProp,
        includeSchemas: { type: "boolean", description: "Include each tool's full JSON input schema. Large. Default false." },
        refresh: { type: "boolean", description: "Bypass the 10-minute probe cache and re-probe servers. Default false." },
      },
      additionalProperties: false,
    },
    handler: async args => {
      const a = adapter(args);
      capabilityOr(a, "mcpReport", "MCP inspection");
      const report = await a.mcpReport?.(getDb(), bool(args, "refresh"));
      if (!report) throw new Error("MCP inspection returned nothing");
      if (bool(args, "includeSchemas")) return report;
      return {
        ...report,
        servers: report.servers.map(s => ({
          ...s,
          tools: s.tools.map(t => omit(t, "inputSchema")),
        })),
      };
    },
  },
  {
    name: "list_memory_stores",
    title: "Memory stores",
    description:
      "Per-project persistent memory: the index file, every topic file with its content, size and last-modified time, and whether each topic is actually linked from the index (unlinked ones are orphans).",
    inputSchema: { type: "object", properties: { ...providerProp }, additionalProperties: false },
    handler: args => {
      const a = adapter(args);
      capabilityOr(a, "listMemoryStores", "memory");
      return a.listMemoryStores?.(getDb());
    },
  },
  {
    name: "get_effective_config",
    title: "Effective settings",
    description:
      "Merged settings layers: every key's winning value, which layers it overrides, and warnings for keys set in a layer the tool never reads. Use it to check the default model, effort level and other cost-relevant settings.",
    inputSchema: {
      type: "object",
      properties: {
        ...providerProp,
        project: { type: "string", description: "Project directory whose layer to merge in. Omit for user scope only." },
      },
      additionalProperties: false,
    },
    handler: args => {
      const a = adapter(args);
      capabilityOr(a, "effectiveConfig", "effective configuration");
      return a.effectiveConfig?.(getDb(), str(args, "project"));
    },
  },
  {
    name: "get_dependency_graph",
    title: "Configuration dependency graph",
    description:
      "How skills, hooks, MCP servers and commands reference each other, with detected dependency chains. Use it to see which pieces of config are wired together and which are isolated.",
    inputSchema: { type: "object", properties: { ...providerProp }, additionalProperties: false },
    handler: async args => {
      const a = adapter(args);
      const db = getDb();
      const skills = a.listSkills?.(db) ?? [];
      const commands = a.listCommands?.(db) ?? [];
      const hooks = a.listHooks?.(db).entries ?? [];
      const mcpServers = a.mcpReport ? (await a.mcpReport(db)).servers : [];
      return buildDependencyGraph({
        skills: skills.filter(s => !s.overriddenBy),
        commands: commands.filter(x => !x.overriddenBy),
        hooks,
        mcpServers: mcpServers.map(s => ({ name: s.name })),
      });
    },
  },
  {
    name: "list_config_projects",
    title: "Known projects",
    description: "Project directories discovered from transcripts — the valid values for the `project` argument elsewhere.",
    inputSchema: { type: "object", properties: { ...providerProp }, additionalProperties: false },
    handler: args => {
      const a = adapter(args);
      capabilityOr(a, "listProjects", "project discovery");
      return { projects: a.listProjects?.(getDb()) ?? [] };
    },
  },

  // ---- app settings --------------------------------------------------------
  {
    name: "get_pricing",
    title: "Reference pricing",
    description:
      "The per-model price table behind every cost figure this app reports. Use it to reason about model-swap savings.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => getPricing(),
  },
  {
    name: "get_thresholds",
    title: "Warning thresholds",
    description: "The configured warn/error thresholds behind the ok/warn/error badges on the dashboard's Harness tabs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => getThresholds(),
  },
  {
    name: "get_data_retention",
    title: "Data retention window",
    description:
      "How many days of records this install keeps. Everything older is deleted from the local cache, so this is the hard limit on every range, every recorded call/fire count and every historical claim you can make. Check it before reporting a trend as \"over the last N days\".",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => ({
      retentionDays: getRetentionDays(),
      defaultDays: DEFAULT_RETENTION_DAYS,
      oldestRetainedTimestamp: rangeSinceIso(retentionRange()),
      note: "User-configurable in the dashboard's Settings tab. This server is read-only and cannot change it.",
    }),
  },
];

function omit<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const { [key]: _dropped, ...rest } = obj;
  return rest;
}

export const MCP_TOOLS_BY_NAME = new Map(MCP_TOOLS.map(t => [t.name, t]));

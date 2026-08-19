import type { Database } from "bun:sqlite";
import { computeCost } from "../pricing";

export interface TurnTotals {
  input: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cacheRead: number;
  output: number;
  total: number;
  totalCost: number;
}

export interface DailyStat {
  date: string;
  input: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cacheRead: number;
  output: number;
  total: number;
}

export interface AgentSummaryRow {
  agent_id: string;
  provider: string;
  run_id: string;
  title: string | null;
  cwd: string | null;
  project_flat: string | null;
  model: string | null;
  is_subagent: number;
  parent_agent_id: string | null;
  agent_type: string | null;
  started_at: string | null;
  last_seen_at: string | null;
  turn_count: number;
  input: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cacheRead: number;
  output: number;
  total: number;
}

export interface ModelStat {
  model: string;
  input: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cacheRead: number;
  output: number;
  total: number;
}

/**
 * Optional data-source filter carried by every read query.
 *
 * `null`/`undefined` means "every registered provider" — what the API exposes
 * as `?provider=all`. Any other value is matched against the `provider` column
 * that every table carries, so a future Codex/OpenCode adapter is filterable
 * without touching a single query here.
 */
export type ProviderFilter = string | null | undefined;

/** Bind values these queries use. Matches bun:sqlite's accepted bindings. */
type BindParams = (string | number)[];

/**
 * Build the `AND <alias>provider = ?` fragment for a filter, appending its
 * bind value to `params`. Returns "" when no filter is active so the surrounding
 * SQL stays unchanged.
 */
function providerAnd(provider: ProviderFilter, params: BindParams, alias = ""): string {
  if (!provider) return "";
  params.push(provider);
  return ` AND ${alias}provider = ?`;
}

/**
 * ISO timestamp of local midnight n days ago. Turn timestamps are stored as
 * UTC ISO strings, so comparing against a bare "YYYY-MM-DD" would cut days at
 * UTC midnight — hours off for any non-UTC user. Anchoring to local midnight
 * (converted to UTC) makes "today" mean the user's calendar day.
 */
export function localMidnightIso(daysAgo = 0): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

export function getTotals(db: Database, sinceDate?: string, provider?: ProviderFilter): TurnTotals {
  // Empty `since` compares <= every ISO timestamp, i.e. no filter.
  const params: BindParams = [sinceDate ?? ""];
  const provAnd = providerAnd(provider, params);
  const row = db.query<{
    input: number; cw5m: number; cw1h: number; cr: number; out: number;
  }, BindParams>(
    `SELECT
       SUM(input_tokens) as input,
       SUM(cache_create_5m) as cw5m,
       SUM(cache_create_1h) as cw1h,
       SUM(cache_read) as cr,
       SUM(output_tokens) as out
     FROM turns WHERE ts >= ?${provAnd}`
  ).get(...params);

  const input  = row?.input  ?? 0;
  const cw5m   = row?.cw5m   ?? 0;
  const cw1h   = row?.cw1h   ?? 0;
  const cr     = row?.cr     ?? 0;
  const output = row?.out    ?? 0;
  const total  = input + cw5m + cw1h + cr + output;

  const byModel = getModelStats(db, sinceDate, provider);
  const totalCost = byModel.reduce((sum, m) => {
    const c = computeCost(m.model, m.input, m.output, m.cacheCreate5m, m.cacheCreate1h, m.cacheRead);
    return sum + c.total;
  }, 0);

  return { input, cacheCreate5m: cw5m, cacheCreate1h: cw1h, cacheRead: cr, output, total, totalCost };
}

// ===== Time ranges for the dashboard's per-chart range buttons =====

/**
 * A chart/query time window: the two hour-scale ranges, or any day count.
 *
 * Day ranges are open-ended (`"14d"`, `"90d"`) rather than a fixed 7/30 pair
 * because the retention setting decides how far back data exists — the widest
 * range the UI offers is always the retention window itself.
 */
export type RangeKey = "1h" | "24h" | `${number}d`;

/** Day count of a range, or null for the hour-scale ones. */
export function rangeDays(range: RangeKey): number | null {
  const m = /^(\d+)d$/.exec(range);
  return m ? parseInt(m[1]!, 10) : null;
}

export function parseRange(raw: string | undefined): RangeKey | null {
  if (raw === "1h" || raw === "24h") return raw;
  const m = /^(\d{1,4})d$/.exec(raw ?? "");
  if (!m) return null;
  const days = parseInt(m[1]!, 10);
  return days >= 1 ? `${days}d` : null;
}

/**
 * Window start for a range. Hour-scale ranges are rolling (literal "last N
 * hours"); day-scale ranges anchor to local midnight so daily buckets line up
 * with calendar days ("last 7 days" = today plus the 6 days before it).
 */
export function rangeSinceIso(range: RangeKey): string {
  if (range === "1h")  return new Date(Date.now() - 3600_000).toISOString();
  if (range === "24h") return new Date(Date.now() - 24 * 3600_000).toISOString();
  return localMidnightIso((rangeDays(range) ?? 1) - 1);
}

// Bucket granularity per range: 5-minute slices for 1h, hours for 24h and for
// day ranges short enough that daily bars would be a handful of points, calendar
// days otherwise. Labels are local time.
const HOURLY_BUCKET_MAX_DAYS = 3;

function bucketExpr(range: RangeKey): string {
  if (range === "1h") {
    return `strftime('%H:', ts, 'localtime') || printf('%02d', (CAST(strftime('%M', ts, 'localtime') AS INTEGER) / 5) * 5)`;
  }
  const days = rangeDays(range);
  if (range === "24h" || (days !== null && days <= HOURLY_BUCKET_MAX_DAYS)) {
    return `strftime('%m-%d %H:00', ts, 'localtime')`;
  }
  return `date(ts, 'localtime')`;
}

/** Token series bucketed to match the range: 5-min / hourly / daily. */
export function getRangeSeries(db: Database, range: RangeKey, provider?: ProviderFilter): DailyStat[] {
  const bucket = bucketExpr(range);
  const params: BindParams = [rangeSinceIso(range)];
  const provAnd = providerAnd(provider, params);
  return db.query<DailyStat, BindParams>(
    `SELECT
       ${bucket} as date,
       SUM(input_tokens)    as input,
       SUM(cache_create_5m) as cacheCreate5m,
       SUM(cache_create_1h) as cacheCreate1h,
       SUM(cache_read)      as cacheRead,
       SUM(output_tokens)   as output,
       SUM(input_tokens + cache_create_5m + cache_create_1h + cache_read + output_tokens) as total
     FROM turns WHERE ts >= ?${provAnd}
     GROUP BY ${bucket}
     ORDER BY MIN(ts)`
  ).all(...params);
}

export function getDailySeries(db: Database, days = 30, provider?: ProviderFilter): DailyStat[] {
  const params: BindParams = [localMidnightIso(days)];
  const provAnd = providerAnd(provider, params);
  return db.query<DailyStat, BindParams>(
    `SELECT
       date(ts, 'localtime') as date,
       SUM(input_tokens)    as input,
       SUM(cache_create_5m) as cacheCreate5m,
       SUM(cache_create_1h) as cacheCreate1h,
       SUM(cache_read)      as cacheRead,
       SUM(output_tokens)   as output,
       SUM(input_tokens + cache_create_5m + cache_create_1h + cache_read + output_tokens) as total
     FROM turns WHERE ts >= ?${provAnd}
     GROUP BY date(ts, 'localtime')
     ORDER BY date`
  ).all(...params);
}

export function getModelStats(db: Database, sinceDate?: string, provider?: ProviderFilter): ModelStat[] {
  // Parameterized because /api/models passes the caller-supplied `since`
  // straight through; empty string compares <= every ISO ts, i.e. no filter.
  const params: BindParams = [sinceDate ?? ""];
  const provAnd = providerAnd(provider, params);
  return db.query<ModelStat, BindParams>(
    `SELECT
       COALESCE(model, 'unknown') as model,
       SUM(input_tokens)    as input,
       SUM(cache_create_5m) as cacheCreate5m,
       SUM(cache_create_1h) as cacheCreate1h,
       SUM(cache_read)      as cacheRead,
       SUM(output_tokens)   as output,
       SUM(input_tokens + cache_create_5m + cache_create_1h + cache_read + output_tokens) as total
     FROM turns WHERE ts >= ?${provAnd}
     GROUP BY model
     ORDER BY total DESC`
  ).all(...params);
}

export function getAgents(db: Database, opts: {
  limit?: number; offset?: number; project?: string; search?: string; provider?: ProviderFilter;
} = {}): { rows: AgentSummaryRow[]; total: number } {
  const { limit = 50, offset = 0, project, search, provider } = opts;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (provider) { conditions.push("a.provider = ?"); params.push(provider); }
  if (project) { conditions.push("a.cwd = ?"); params.push(project); }
  if (search) { conditions.push("(a.title LIKE ? OR a.cwd LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const allParams = [...params, limit, offset];

  const countRow = db.query(
    `SELECT COUNT(*) as n FROM agents a ${where}`
  ).get(...params) as { n: number } | null;

  const rows = db.query(
    `SELECT
       a.agent_id, a.provider, a.run_id, a.title, a.cwd, a.project_flat,
       a.is_subagent, a.parent_agent_id, a.agent_type,
       a.started_at, a.last_seen_at, a.turn_count,
       t.model,
       COALESCE(t.input, 0)  as input,
       COALESCE(t.cw5m, 0)   as cacheCreate5m,
       COALESCE(t.cw1h, 0)   as cacheCreate1h,
       COALESCE(t.cr, 0)     as cacheRead,
       COALESCE(t.out, 0)    as output,
       COALESCE(t.total, 0)  as total
     FROM agents a
     LEFT JOIN (
       SELECT agent_id,
         MAX(model) as model,
         SUM(input_tokens)    as input,
         SUM(cache_create_5m) as cw5m,
         SUM(cache_create_1h) as cw1h,
         SUM(cache_read)      as cr,
         SUM(output_tokens)   as out,
         SUM(input_tokens + cache_create_5m + cache_create_1h + cache_read + output_tokens) as total
       FROM turns GROUP BY agent_id
     ) t ON a.agent_id = t.agent_id
     ${where}
     ORDER BY a.last_seen_at DESC NULLS LAST
     LIMIT ? OFFSET ?`
  ).all(...allParams) as AgentSummaryRow[];

  return { rows, total: countRow?.n ?? 0 };
}

export function getProjects(db: Database, since?: string, provider?: ProviderFilter): {
  cwd: string; runCount: number; agentCount: number; totalTokens: number; lastActive: string | null;
}[] {
  // The token sub-query is filtered by `since`; the agent side carries the
  // provider filter so projects belonging to another tool drop out entirely.
  const params: BindParams = [since ?? ""];
  const provAnd = providerAnd(provider, params, "a.");
  return db.query<{
    cwd: string; runCount: number; agentCount: number; totalTokens: number; lastActive: string | null;
  }, BindParams>(
    `SELECT
       a.cwd,
       COUNT(DISTINCT a.run_id) as runCount,
       COUNT(DISTINCT a.agent_id) as agentCount,
       COALESCE(SUM(t.total), 0) as totalTokens,
       MAX(a.last_seen_at) as lastActive
     FROM agents a
     LEFT JOIN (
       SELECT agent_id,
         SUM(input_tokens + cache_create_5m + cache_create_1h + cache_read + output_tokens) as total
       FROM turns WHERE ts >= ? GROUP BY agent_id
     ) t ON a.agent_id = t.agent_id
     WHERE a.cwd IS NOT NULL${provAnd}
     GROUP BY a.cwd
     ORDER BY lastActive DESC NULLS LAST`
  ).all(...params);
}

// ===== MCP / Skill usage from the recorded tool-event stream =====
// events.tokens holds a chars/4 estimate of each tool call's input + result
// payload — the context those calls actually injected into the conversation.

export interface McpUsageStat {
  server: string;
  calls: number;
  tokens: number;
  tools: { tool: string; calls: number; tokens: number }[];
  /**
   * What the API actually charged while this server was active, from the
   * provider's per-call attribution — as opposed to `tokens`, which only sizes
   * the request and response payloads of the calls themselves.
   */
  attributedCalls: number;
  attributedTokens: number;
  attributedCostUsd: number;
}

/**
 * Split a recorded tool name of the form "mcp__<server>__<tool>" into its parts.
 * Shared with the comparison tools so both attribute calls to the same server.
 */
export function splitMcpToolName(detail: string): { server: string; tool: string } {
  const rest = detail.slice(5);
  const sep = rest.indexOf("__");
  return sep === -1
    ? { server: rest, tool: "(unknown)" }
    : { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/**
 * Recorded API cost per attribution value, from the provider's own per-call
 * `attribution*` fields rather than from tool payload sizes.
 *
 * The two answer different questions and the difference is large: invoking a
 * skill costs the tokens of one tool call, while RUNNING it costs every API
 * call made until it finishes. Only this second number tells you what a skill
 * or server is worth keeping.
 */
function attributedCost(
  db: Database, which: "skill" | "mcpServer",
  since: string, provider?: ProviderFilter,
): Map<string, { calls: number; tokens: number; costUsd: number }> {
  // Resolved through a fixed map rather than interpolated from the argument:
  // the column name cannot be a bound parameter, so this is what keeps a
  // future caller from reaching the SQL text with a value of its own.
  const column = ({ skill: "attribution_skill", mcpServer: "attribution_mcp_server" } as const)[which];
  const params: BindParams = [since];
  const provAnd = providerAnd(provider, params);
  const rows = db.query<{
    name: string; model: string | null; calls: number;
    input: number; cw5m: number; cw1h: number; cr: number; out: number;
  }, BindParams>(
    `SELECT ${column} as name, model,
            COUNT(*)             as calls,
            SUM(input_tokens)    as input,
            SUM(cache_create_5m) as cw5m,
            SUM(cache_create_1h) as cw1h,
            SUM(cache_read)      as cr,
            SUM(output_tokens)   as out
     FROM turns
     WHERE ${column} IS NOT NULL AND ts >= ?${provAnd}
     GROUP BY ${column}, model`
  ).all(...params);

  const out = new Map<string, { calls: number; tokens: number; costUsd: number }>();
  for (const r of rows) {
    const e = out.get(r.name) ?? { calls: 0, tokens: 0, costUsd: 0 };
    e.calls += r.calls;
    e.tokens += r.input + r.cw5m + r.cw1h + r.cr + r.out;
    e.costUsd += computeCost(r.model ?? "unknown", r.input, r.out, r.cw5m, r.cw1h, r.cr).total;
    out.set(r.name, e);
  }
  return out;
}

export function getMcpUsage(db: Database, since: string, provider?: ProviderFilter): McpUsageStat[] {
  const params: BindParams = [since];
  const provAnd = providerAnd(provider, params);
  const rows = db.query<{ detail: string; calls: number; tokens: number }, BindParams>(
    `SELECT detail, COUNT(*) as calls, SUM(tokens) as tokens
     FROM events
     WHERE kind = 'tool' AND detail LIKE 'mcp\\_\\_%' ESCAPE '\\' AND ts >= ?${provAnd}
     GROUP BY detail`
  ).all(...params);

  const byServer = new Map<string, McpUsageStat>();
  const blank = (server: string): McpUsageStat =>
    ({ server, calls: 0, tokens: 0, tools: [],
       attributedCalls: 0, attributedTokens: 0, attributedCostUsd: 0 });
  for (const r of rows) {
    const { server, tool } = splitMcpToolName(r.detail);
    const entry = byServer.get(server) ?? blank(server);
    entry.calls += r.calls;
    entry.tokens += r.tokens ?? 0;
    entry.tools.push({ tool, calls: r.calls, tokens: r.tokens ?? 0 });
    byServer.set(server, entry);
  }
  // A server can hold attributed cost with no recorded tool call of its own —
  // the attribution covers the whole span, not just the invoking call.
  for (const [name, a] of attributedCost(db, "mcpServer", since, provider)) {
    const entry = byServer.get(name) ?? blank(name);
    entry.attributedCalls = a.calls;
    entry.attributedTokens = a.tokens;
    entry.attributedCostUsd = a.costUsd;
    byServer.set(name, entry);
  }
  return [...byServer.values()]
    .map(s => ({ ...s, tools: s.tools.sort((a, b) => b.tokens - a.tokens) }))
    .sort((a, b) => (b.attributedTokens - a.attributedTokens) || (b.tokens - a.tokens));
}

export interface SkillUsageStat {
  skill: string;
  calls: number;
  tokens: number;
  /** See McpUsageStat — recorded API cost, not injected payload size. */
  attributedCalls: number;
  attributedTokens: number;
  attributedCostUsd: number;
}

export function getSkillUsage(db: Database, since: string, provider?: ProviderFilter): SkillUsageStat[] {
  const params: BindParams = [since];
  const provAnd = providerAnd(provider, params);
  const rows = db.query<{ skill: string; calls: number; tokens: number }, BindParams>(
    `SELECT extra as skill, COUNT(*) as calls, SUM(tokens) as tokens
     FROM events
     WHERE kind = 'tool' AND detail = 'Skill' AND extra IS NOT NULL AND ts >= ?${provAnd}
     GROUP BY extra`
  ).all(...params);

  const bySkill = new Map<string, SkillUsageStat>();
  const blank = (skill: string): SkillUsageStat =>
    ({ skill, calls: 0, tokens: 0, attributedCalls: 0, attributedTokens: 0, attributedCostUsd: 0 });
  for (const r of rows) {
    const e = bySkill.get(r.skill) ?? blank(r.skill);
    e.calls += r.calls;
    e.tokens += r.tokens ?? 0;
    bySkill.set(r.skill, e);
  }
  // Skills invoked by a sub-agent, or loaded without a Skill tool call, appear
  // only here — the event stream never saw an invocation to hang them on.
  for (const [name, a] of attributedCost(db, "skill", since, provider)) {
    const e = bySkill.get(name) ?? blank(name);
    e.attributedCalls = a.calls;
    e.attributedTokens = a.tokens;
    e.attributedCostUsd = a.costUsd;
    bySkill.set(name, e);
  }
  return [...bySkill.values()]
    .sort((a, b) => (b.attributedTokens - a.attributedTokens) || (b.tokens - a.tokens));
}

export function getCacheHitRate(db: Database, sinceDate?: string, provider?: ProviderFilter): number {
  const params: BindParams = [sinceDate ?? ""];
  const provAnd = providerAnd(provider, params);
  const row = db.query<{ cr: number; total: number }, BindParams>(
    `SELECT SUM(cache_read) as cr,
            SUM(input_tokens + cache_create_5m + cache_create_1h + cache_read) as total
     FROM turns WHERE ts >= ?${provAnd}`
  ).get(...params);
  if (!row || !row.total) return 0;
  return Math.round((row.cr / row.total) * 100);
}

export function getTopTurns(db: Database, limit = 10, provider?: ProviderFilter): {
  agent_id: string; ts: string; model: string | null; total: number;
}[] {
  const params: BindParams = [""];
  const provAnd = providerAnd(provider, params);
  params.push(limit);
  return db.query<{ agent_id: string; ts: string; model: string | null; total: number }, BindParams>(
    `SELECT agent_id, ts, model,
       (input_tokens + cache_create_5m + cache_create_1h + cache_read + output_tokens) as total
     FROM turns WHERE ts >= ?${provAnd} ORDER BY total DESC LIMIT ?`
  ).all(...params);
}

/**
 * Row counts. `started_at` is nullable, and `NULL >= x` is NULL in SQL, so the
 * date predicate is added only when a window was asked for — otherwise rows
 * that never got a timestamp would silently drop out of the count.
 */
function countRows(db: Database, table: "agents" | "runs", sinceDate?: string, provider?: ProviderFilter): number {
  const params: BindParams = [];
  const conditions: string[] = [];
  if (sinceDate) { conditions.push("started_at >= ?"); params.push(sinceDate); }
  if (provider)  { conditions.push("provider = ?");    params.push(provider); }
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const row = db.query<{ n: number }, BindParams>(
    `SELECT COUNT(*) as n FROM ${table}${where}`
  ).get(...params);
  return row?.n ?? 0;
}

export function getAgentCount(db: Database, sinceDate?: string, provider?: ProviderFilter): number {
  return countRows(db, "agents", sinceDate, provider);
}

export function getRunCount(db: Database, sinceDate?: string, provider?: ProviderFilter): number {
  return countRows(db, "runs", sinceDate, provider);
}

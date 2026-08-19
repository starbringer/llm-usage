import type { Database } from "bun:sqlite";

export interface FileRecord {
  path: string;
  provider: string;
  mtime: number;
  size: number;
  parsed_offset: number;
  agent_id: string | null;
  is_subagent: number;
  parent_agent_id: string | null;
}

export interface TurnRecord {
  provider: string;
  agent_id: string;
  run_id: string;
  is_subagent: number;
  parent_agent_id: string | null;
  message_id: string | null;
  request_id: string | null;
  ts: string;
  model: string | null;
  input_tokens: number;
  cache_create_5m: number;
  cache_create_1h: number;
  cache_read: number;
  output_tokens: number;
  service_tier: string | null;
  raw_offset: number | null;
  /** Cost-attribution bucket: 0 = base, 1 = mcp, 2 = skill (see db.ts). */
  bucket: number;
  /**
   * The provider's own attribution of this API call — which skill, sub-agent,
   * plugin or MCP server was active while it was made. Recorded, not inferred:
   * Claude Code writes these onto the transcript line itself.
   */
  attribution_skill: string | null;
  attribution_agent: string | null;
  attribution_plugin: string | null;
  attribution_mcp_server: string | null;
}

export interface AgentRecord {
  agent_id: string;
  provider: string;
  run_id: string;
  is_subagent: number;
  parent_agent_id: string | null;
  parent_turn_index: number | null;
  agent_type: string | null;
  description: string | null;
  cwd: string | null;
  project_flat: string | null;
  title: string | null;
  started_at: string | null;
  last_seen_at: string | null;
  turn_count: number;
  file_path: string | null;
}

export interface RunRecord {
  run_id: string;
  provider: string;
  project_flat: string | null;
  cwd: string | null;
  title: string | null;
  started_at: string | null;
  last_seen_at: string | null;
  agent_count: number;
  turn_count: number;
}

export function getFileRecord(db: Database, path: string): FileRecord | null {
  return db.query<FileRecord, [string]>(
    "SELECT * FROM files WHERE path = ?"
  ).get(path);
}

export function upsertFile(db: Database, r: FileRecord): void {
  db.run(
    `INSERT INTO files(path,provider,mtime,size,parsed_offset,agent_id,is_subagent,parent_agent_id)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(path) DO UPDATE SET
       provider=excluded.provider,
       mtime=excluded.mtime, size=excluded.size,
       parsed_offset=excluded.parsed_offset,
       agent_id=COALESCE(excluded.agent_id, agent_id),
       is_subagent=excluded.is_subagent,
       parent_agent_id=excluded.parent_agent_id`,
    [r.path, r.provider, r.mtime, r.size, r.parsed_offset, r.agent_id, r.is_subagent, r.parent_agent_id]
  );
}

/**
 * Insert one API-call row, keyed on `dedupe_key` (request_id ?? message_id) so
 * that repeats collapse across the WHOLE dataset, not just within one agent —
 * see the index comment in db.ts for the two kinds of repeat this absorbs.
 *
 * `agent_id` and `run_id` are deliberately not updated on conflict: the first
 * transcript to record a call keeps it. A fork replaying history must not steal
 * attribution for tokens the original session actually spent.
 *
 * Token columns take MAX rather than last-write-wins. The repeated lines of one
 * response are not always identical: a streamed response can record a partial
 * `output_tokens` on its first line and the complete figure on its last, and a
 * trailing record can carry a zero usage block. MAX takes the complete figure
 * in both cases, since a partial is always a prefix of the final count.
 */
export function insertTurn(db: Database, t: TurnRecord): void {
  db.run(
    `INSERT INTO turns
       (provider,agent_id,run_id,is_subagent,parent_agent_id,message_id,request_id,dedupe_key,ts,model,
        input_tokens,cache_create_5m,cache_create_1h,cache_read,
        output_tokens,service_tier,raw_offset,bucket,
        attribution_skill,attribution_agent,attribution_plugin,attribution_mcp_server)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(provider, dedupe_key) DO UPDATE SET
       ts=excluded.ts,
       model=excluded.model,
       input_tokens=MAX(input_tokens, excluded.input_tokens),
       cache_create_5m=MAX(cache_create_5m, excluded.cache_create_5m),
       cache_create_1h=MAX(cache_create_1h, excluded.cache_create_1h),
       cache_read=MAX(cache_read, excluded.cache_read),
       output_tokens=MAX(output_tokens, excluded.output_tokens),
       service_tier=COALESCE(excluded.service_tier, service_tier),
       bucket=MAX(bucket, excluded.bucket),
       attribution_skill=COALESCE(attribution_skill, excluded.attribution_skill),
       attribution_agent=COALESCE(attribution_agent, excluded.attribution_agent),
       attribution_plugin=COALESCE(attribution_plugin, excluded.attribution_plugin),
       attribution_mcp_server=COALESCE(attribution_mcp_server, excluded.attribution_mcp_server)`,
    [t.provider, t.agent_id, t.run_id, t.is_subagent, t.parent_agent_id, t.message_id, t.request_id,
     t.request_id ?? t.message_id,
     t.ts, t.model, t.input_tokens, t.cache_create_5m, t.cache_create_1h, t.cache_read,
     t.output_tokens, t.service_tier, t.raw_offset, t.bucket,
     t.attribution_skill, t.attribution_agent, t.attribution_plugin, t.attribution_mcp_server]
  );
}

export interface EventRecord {
  provider: string;
  agent_id: string;
  run_id: string;
  ts: string;
  kind: "prompt" | "tool" | "hook" | "api_error" | "compact" | "fallback";
  detail: string | null;
  dedupe: string;
  tool_use_id?: string | null;
  tokens?: number;
  extra?: string | null;
}

/** Idempotent on (agent_id, dedupe) so incremental re-parses never double count. */
export function insertEvent(db: Database, e: EventRecord): void {
  db.run(
    `INSERT INTO events(provider,agent_id,run_id,ts,kind,detail,dedupe,tool_use_id,tokens,extra)
     VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(agent_id, dedupe) DO NOTHING`,
    [e.provider, e.agent_id, e.run_id, e.ts, e.kind, e.detail, e.dedupe,
     e.tool_use_id ?? null, e.tokens ?? 0, e.extra ?? null]
  );
}

/**
 * Fold a tool_result's estimated tokens into its originating tool event.
 * Safe across incremental parses: the byte-offset cursor guarantees each
 * result line is processed exactly once, and the tool event row already
 * exists because the call always precedes its result in the transcript.
 */
export function addEventResultTokens(db: Database, agentId: string, toolUseId: string, tokens: number): void {
  db.run(
    `UPDATE events SET tokens = tokens + ? WHERE agent_id = ? AND tool_use_id = ?`,
    [tokens, agentId, toolUseId]
  );
}

export function upsertAgent(db: Database, a: AgentRecord): void {
  db.run(
    `INSERT INTO agents
       (agent_id,provider,run_id,is_subagent,parent_agent_id,parent_turn_index,
        agent_type,description,cwd,project_flat,
        title,started_at,last_seen_at,turn_count,file_path)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(agent_id) DO UPDATE SET
       provider=excluded.provider,
       run_id=excluded.run_id,
       is_subagent=excluded.is_subagent,
       parent_agent_id=COALESCE(excluded.parent_agent_id, parent_agent_id),
       parent_turn_index=COALESCE(excluded.parent_turn_index, parent_turn_index),
       agent_type=COALESCE(excluded.agent_type, agent_type),
       description=COALESCE(excluded.description, description),
       cwd=COALESCE(excluded.cwd, cwd),
       project_flat=COALESCE(excluded.project_flat, project_flat),
       title=COALESCE(excluded.title, title),
       started_at=COALESCE(started_at, excluded.started_at),
       last_seen_at=COALESCE(excluded.last_seen_at, last_seen_at),
       turn_count=excluded.turn_count,
       file_path=COALESCE(file_path, excluded.file_path)`,
    [a.agent_id, a.provider, a.run_id, a.is_subagent, a.parent_agent_id, a.parent_turn_index,
     a.agent_type, a.description, a.cwd, a.project_flat,
     a.title, a.started_at, a.last_seen_at, a.turn_count, a.file_path]
  );
}

export function upsertRun(db: Database, r: RunRecord): void {
  db.run(
    `INSERT INTO runs
       (run_id,provider,project_flat,cwd,title,started_at,last_seen_at,agent_count,turn_count)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(run_id) DO UPDATE SET
       provider=excluded.provider,
       project_flat=COALESCE(excluded.project_flat, project_flat),
       cwd=COALESCE(excluded.cwd, cwd),
       title=COALESCE(excluded.title, title),
       started_at=COALESCE(started_at, excluded.started_at),
       last_seen_at=excluded.last_seen_at,
       agent_count=excluded.agent_count,
       turn_count=excluded.turn_count`,
    [r.run_id, r.provider, r.project_flat, r.cwd, r.title, r.started_at, r.last_seen_at, r.agent_count, r.turn_count]
  );
}

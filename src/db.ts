import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "./paths";

const SCHEMA_VERSION = 11;

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA synchronous = NORMAL");
  _db.run("PRAGMA foreign_keys = ON");
  // Wait instead of throwing SQLITE_BUSY when another process (a second
  // server instance) briefly holds the write lock.
  _db.run("PRAGMA busy_timeout = 5000");

  const existing = (_db.query<{ user_version: number }, []>("PRAGMA user_version").get())?.user_version ?? 0;
  if (existing !== SCHEMA_VERSION) {
    // Drop everything from prior versions; the DB is a regenerable cache.
    _db.run("DROP TABLE IF EXISTS files");
    _db.run("DROP TABLE IF EXISTS turns");
    _db.run("DROP TABLE IF EXISTS sessions");
    _db.run("DROP TABLE IF EXISTS agents");
    _db.run("DROP TABLE IF EXISTS runs");
    _db.run("DROP TABLE IF EXISTS events");
    _db.run("DROP TABLE IF EXISTS harness_snapshots");
  }

  initSchema(_db);
  _db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return _db;
}

/** Exported so tests exercise the production schema, indexes included. */
export function initSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS files (
    path             TEXT PRIMARY KEY,
    provider         TEXT NOT NULL,
    mtime            REAL NOT NULL DEFAULT 0,
    size             INTEGER NOT NULL DEFAULT 0,
    parsed_offset    INTEGER NOT NULL DEFAULT 0,
    agent_id         TEXT,
    is_subagent      INTEGER NOT NULL DEFAULT 0,
    parent_agent_id  TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS runs (
    run_id           TEXT PRIMARY KEY,
    provider         TEXT NOT NULL,
    run_key          TEXT,
    project_flat     TEXT,
    cwd              TEXT,
    title            TEXT,
    started_at       TEXT,
    last_seen_at     TEXT,
    agent_count      INTEGER NOT NULL DEFAULT 1,
    turn_count       INTEGER NOT NULL DEFAULT 0
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_runs_last_seen ON runs(last_seen_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_runs_cwd       ON runs(cwd)`);
  // `run_key` is the short public id users quote back to the comparison tools,
  // derived from (provider, run_id) so it survives this cache being rebuilt —
  // see transcripts/runKey.ts. Deliberately NOT unique: a hash collision must
  // surface as an "ambiguous id" at lookup time, never as a constraint
  // violation that breaks ingest.
  db.run(`CREATE INDEX IF NOT EXISTS idx_runs_key       ON runs(run_key)`);

  db.run(`CREATE TABLE IF NOT EXISTS agents (
    agent_id          TEXT PRIMARY KEY,
    provider          TEXT NOT NULL,
    run_id            TEXT NOT NULL,
    is_subagent       INTEGER NOT NULL DEFAULT 0,
    parent_agent_id   TEXT,
    parent_turn_index INTEGER,
    agent_type        TEXT,
    description       TEXT,
    cwd               TEXT,
    project_flat      TEXT,
    title             TEXT,
    started_at        TEXT,
    last_seen_at      TEXT,
    turn_count        INTEGER NOT NULL DEFAULT 0,
    file_path         TEXT
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_agents_run       ON agents(run_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_agents_parent    ON agents(parent_agent_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents(last_seen_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_agents_cwd       ON agents(cwd)`);

  db.run(`CREATE TABLE IF NOT EXISTS turns (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    provider         TEXT NOT NULL,
    agent_id         TEXT NOT NULL,
    run_id           TEXT NOT NULL,
    is_subagent      INTEGER NOT NULL DEFAULT 0,
    parent_agent_id  TEXT,
    message_id       TEXT,
    request_id       TEXT,
    dedupe_key       TEXT,
    ts               TEXT NOT NULL,
    model            TEXT,
    input_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_create_5m  INTEGER NOT NULL DEFAULT 0,
    cache_create_1h  INTEGER NOT NULL DEFAULT 0,
    cache_read       INTEGER NOT NULL DEFAULT 0,
    output_tokens    INTEGER NOT NULL DEFAULT 0,
    service_tier     TEXT,
    raw_offset       INTEGER,
    bucket           INTEGER NOT NULL DEFAULT 0,
    attribution_skill       TEXT,
    attribution_agent       TEXT,
    attribution_plugin      TEXT,
    attribution_mcp_server  TEXT
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_turns_agent ON turns(agent_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_turns_run   ON turns(run_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_turns_ts    ON turns(ts)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_turns_model ON turns(model)`);
  // One row per API response, deduplicated GLOBALLY rather than per agent.
  //
  // Two distinct sources of repeats have to collapse here:
  //   1. Claude Code writes one JSONL line per content block of a response, all
  //      sharing the same message.id and repeating the same usage. Per-agent
  //      dedupe already handled this (~2.4x over-count without it).
  //   2. A forked session replays the parent's history into a NEW transcript,
  //      keeping the original message.id / requestId but changing sessionId.
  //      Those copies land under a different agent_id, so a per-agent index
  //      lets every pre-fork call be counted twice. Subagent forking is on by
  //      default from Claude Code 2.1.232, which makes that the common case.
  //
  // `dedupe_key` is request_id ?? message_id — the same preference order
  // Claude Code's own usage scan uses. A row with neither stays NULL and is
  // never deduplicated, which also matches its behaviour (its scan skips the
  // dedupe set entirely for records with an empty key).
  // Scoped by provider like every other table here: two sources could hand out
  // the same simple id, and an unscoped index would silently merge their rows.
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_dedupe ON turns(provider, dedupe_key)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_turns_msg ON turns(agent_id, message_id)`);
  // `bucket` classifies each API call for cost attribution (0=base, 1=mcp,
  // 2=skill; sub-agent turns are attributed by is_subagent instead). Assigned
  // at parse time, preferring Claude Code's own `attribution*` fields and
  // falling back to the call's tool_use blocks; conflicts keep the highest
  // priority seen across the response's lines.
  db.run(`CREATE INDEX IF NOT EXISTS idx_turns_attr_skill ON turns(attribution_skill)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_turns_attr_mcp   ON turns(attribution_mcp_server)`);

  // Lightweight event stream extracted from transcripts: real user prompts,
  // tool calls, hook fires, API errors, compactions, model fallbacks.
  // Powers the Harness tabs with recorded counts instead of guesses.
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    provider    TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    run_id      TEXT NOT NULL,
    ts          TEXT NOT NULL,
    kind        TEXT NOT NULL,   -- prompt | tool | hook | api_error | compact | fallback
    detail      TEXT,            -- tool name / hook command / error status / …
    dedupe      TEXT,            -- source uuid: makes incremental re-parses idempotent
    tool_use_id TEXT,            -- provider's tool call id: links tool_result back to its call
    tokens      INTEGER NOT NULL DEFAULT 0,  -- est. tokens of tool input + result (chars/4)
    extra       TEXT             -- skill name for Skill tool calls
  )`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe ON events(agent_id, dedupe)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, ts)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_tool_use ON events(agent_id, tool_use_id)`);

  // Append-only log of what the harness looked like, so a before/after
  // comparison can name what changed. Harness config is read live from disk,
  // which means a past run's CLAUDE.md is otherwise unrecoverable once edited.
  // Rows hold hashes and token counts only — never file contents — and are
  // written only when the fingerprint actually changes, so the table stays tiny.
  db.run(`CREATE TABLE IF NOT EXISTS harness_snapshots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    provider     TEXT NOT NULL,
    project      TEXT,            -- cwd the snapshot applies to; NULL = user scope
    captured_at  TEXT NOT NULL,
    fingerprint  TEXT NOT NULL,   -- hash of payload; gates whether a row is written
    payload      TEXT NOT NULL    -- JSON: {type,id,scope,tokens,hash}[] per component
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_snapshots_lookup ON harness_snapshots(provider, project, captured_at)`);
}

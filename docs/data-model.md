# Data model

**English** | [简体中文](data-model.zh-CN.md)

- [Run / Agent / Turn](#run--agent--turn)
- [Accuracy notes](#accuracy-notes)
- [Database](#database)
- [Cost estimation](#cost-estimation)
- [Plan weight](#plan-weight)
- [Context occupancy](#context-occupancy)

## Run / Agent / Turn

Recorded activity is organized into three nested levels:

- **Run** — one logical execution (one AI session). May contain one or many agents.
  A plain chat with no sub-agents holds exactly one agent; an orchestrator that
  spawns Task sub-agents holds the parent plus all descendants, linked through the
  provider's native parent/child markers.
- **Agent** — one conversation context. Maps to a single transcript file (one
  `.jsonl` for Claude Code). Has a model, a cwd, a title and a list of turns.
- **Turn** — one **API call** (one LLM request/response).

Sub-agents are detected from the provider's own data — for Claude Code that's the
`<parent>/subagents/agent-*.jsonl` directory convention. No heuristics, no content
sniffing. If a framework doesn't record parent/child links between transcript
files, each transcript becomes a one-agent run; that's correct behavior, not a
limitation.

## Accuracy notes

**Token dedupe.** Claude Code writes one JSONL line per *content block* of a
response, and a forked session replays its parent's history into a new
transcript. Turns are therefore deduplicated **globally** on `request_id ??
message_id` — the same key, in the same preference order, that Claude Code's own
usage scan uses. Without content-block dedupe, transcripts over-count output by
roughly 2.4×; without global dedupe, every call made before a fork is counted
twice, and sub-agent forking is on by default from Claude Code 2.1.232.

**Forked records.** A replayed record keeps the original `message.id`,
`requestId` and `usage`, and carries `forkedFrom`. Those records are skipped
outright — turns and events alike — so the session that actually spent the
tokens keeps them. The fork's own new activity carries no `forkedFrom` and is
counted normally.

**Partial usage.** The repeated lines of one response are not always identical: a
streamed response can record a partial `output_tokens` on its first line and the
complete figure on its last, and a trailing record can carry an all-zero usage
block. Token columns take the **maximum** across a response's lines, since a
partial is always a prefix of the final count. Claude Code's own local scan keeps
the first line instead, so its `/usage` activity panel reads slightly low on
output — about 27k tokens across 36 of 1,569 responses in one measured week.

**Failed calls.** Error echoes recorded with model `<synthetic>` are excluded from
counts and from the model list; they appear in the session tree as error nodes.

**Day boundaries.** "Today" and daily buckets use your local calendar day, not UTC.

**Titles.** A run is titled by the transcript's `ai-title` record (Claude Code's own
AI-generated session title) when present; otherwise by the first real user prompt,
with IDE/framework wrapper tags stripped.

**Cache write TTL.** The 5m/1h split comes from `usage.cache_creation`. Legacy
records carrying only a total are attributed to the 5m bucket (the default TTL) so
cost is not overstated.

**Attribution.** Claude Code stamps `attributionSkill`, `attributionAgent`,
`attributionPlugin` and `attributionMcpServer` on every API call made while that
component is active. Those fields set the call's cost bucket and drive the
per-skill and per-server totals, so "what did this skill cost" means the whole
span it ran for, not the single call that invoked it. Records written before the
fields existed fall back to classifying a call by its own `tool_use` blocks.

**Recorded vs estimated.** Fire counts, tool calls and skill invocations come from
the parsed event stream — they are recorded, not inferred. Anything labelled *est.*
in the UI (injected prompt cost, tool payload sizes) is a tokenizer estimate.

## Database

SQLite at `data/cache.db` in WAL mode. Six tables, each carrying a `provider`
column for multi-source support.

| Table | Row = | Notes |
|---|---|---|
| **`files`** | one transcript file | path + byte offset, for incremental parsing |
| **`runs`** | one logical run | derived roll-up: title, cwd, agent count, turn count, first/last seen, plus `run_key` (below). Rebuilt after every full scan **and** every incremental ingest (debounced), so the Runs page stays live without a restart |
| **`agents`** | one transcript file | `run_id`, `parent_agent_id`, `parent_turn_index` (sibling ordering), `agent_type`, `description` (from sub-agent `meta.json`), title, cwd, last seen, turn count |
| **`turns`** | one API call | **unique on `dedupe_key`** (`request_id ?? message_id`), globally — this index is what collapses both the one-line-per-content-block format and a fork's replayed history. Carries model, token counts, timestamp, the four `attribution_*` columns, and a `bucket` column (0 = base, 1 = MCP, 2 = skill, taken from attribution and falling back to the call's `tool_use` blocks; sub-agent attribution uses `is_subagent`) |
| **`events`** | one parsed event | idempotent on (agent_id, source uuid): user prompts, tool calls (with tool name and `tool_use_id`), hook fires, API errors, compactions, model fallbacks. Tool events also carry an estimated token size and, for Skill calls, the skill name |
| **`harness_snapshots`** | one harness fingerprint | append-only, written only when the fingerprint changes. Component hashes and token counts — never file contents — for instruction files, skills, commands, hooks, MCP servers, permissions and settings layers |

`turns` is the source of truth for token totals, turn counts and last-seen times —
all recomputed from it, never trusted from a maintained counter. (Incremental
parsing of timestamp-less trailing records like `ai-title`, `mode` or `summary`
would otherwise zero out turn counts or null out `last_seen_at`.)

**Schema versioning.** The schema version is stored in `PRAGMA user_version`. When
the app starts and finds a different version it drops and recreates everything,
then re-parses every transcript. Deleting `data/cache.db` forces the same rebuild.
A rebuild is safe at any time: the JSONL transcripts are the only source of truth.

## Run keys

`runs.run_key` is the short public id (`r-9f3a1c2b7e04`) users quote to the
comparison tools. It is the first 48 bits of `sha256(JSON.stringify([provider,
run_id]))` — **derived, never assigned**, because the rebuild above would give an
autoincrement id or a generated UUID a different value and silently point it at
another session. Including the provider keeps ids unique across sources, since a
session id is only unique within one tool.

Computed in `refreshRuns`, which every provider already calls, so a new adapter
gets keys with no extra code. The index is deliberately **not** unique: a hash
collision must surface as an "ambiguous id" at lookup time rather than as a
constraint violation that breaks ingest.

## Harness snapshots

Harness configuration is read live from disk everywhere else, which means a run's
CLAUDE.md is unrecoverable once edited — so a before/after comparison could show
that cost fell but never say *because what*. `harness_snapshots` is the fix: a
fingerprint captured at startup, after every config write through the app, and
every 15 minutes. That interval is the resolution of the change timeline; an edit
is dated to the next capture after it.

Only hashes and token counts are stored, so the log reveals nothing the app does
not already display. MCP servers are recorded from their **definitions only** — a
probe spawns every configured server and its cache is per-process, so a
probe-based fingerprint would be both expensive and unstable across processes.
The token cost of MCP is already measured from the event stream instead.

Snapshots age out with everything else, with one exception: the newest row
predating the cutoff is kept, because it is the baseline the oldest retained
period is diffed against.

## Retention

The cache holds a rolling window — `retentionDays` in `data/retention.json`, 30 by
default, editable on the **Settings** page. A sweep runs at startup and hourly:

1. `turns` and `events` older than the cutoff are deleted,
2. then `agents` left with no turns at all *and* last seen before the cutoff,
3. then `runs` left with no agents.

So a session that started before the cutoff but is still active gets trimmed, not
dropped, and an agent that has not recorded a turn yet is never mistaken for an
aged-out one.

`files` is deliberately exempt: it holds each transcript's parsed byte offset, and
clearing a row would make the next scan re-read the whole file and re-insert the
rows the sweep just deleted. That is also why **widening** the window clears
`files` on purpose and re-scans — the only way to bring back history that is still
sitting in the transcripts.

The cutoff is local midnight `retentionDays - 1` days ago, so the window covers
whole calendar days and lines up exactly with the widest chart range. It is never
newer than 24 hours ago, so the `24h` range stays whole even at a 1-day setting.

## Cost estimation

Costs are **API-equivalent reference numbers**, not billing. Each turn's tokens are
priced with a per-model table (input / output / cache-write / cache-read per
million tokens) that you can edit on the **Settings** page or directly in
`data/pricing.json`. Cache writes are priced 1.25× input for the 5-minute TTL and
2× for the 1-hour TTL; cache reads 0.1× input.

A model id the table does not list falls back to its family's standard rate, so a
new release is still estimated rather than counted as free.

If you are on a Pro/Max subscription these numbers tell you what the same work
would have cost through the API — they are not what you are charged. Anthropic
provides no programmatic API for subscription seat usage; see
<https://claude.ai/settings/usage> for that.

## Plan weight

Subscription rate limits are not metered in dollars. Each call scores

```
(cache_read + input×10 + cache_write×12.5 + output×50) × tier
tier: fable 10, opus 5, haiku 1, anything else 3
```

which is the API price ratio with a cache read as the unit, and the tier is the
family's input price per 1M. Plan weight and API cost are therefore the same
quantity up to a constant: **1 USD = 10,000,000 weight units**, wherever the two
tables agree.

They disagree in two places, both deliberate:

- a 1-hour cache write bills at 2× input but is weighted at 1.25×, so 1h-cache-heavy
  work costs more in dollars than it consumes in quota;
- the tier is per family, so it misses per-model rates the pricing table does carry
  (legacy Opus 4.x at $15/1M, Sonnet 5 introductory at $2/1M).

Weight is computed from the rate card, not derived from cost, so editing
`pricing.json` does not change what the plan meter is reported to count.

## Context occupancy

`/context` totals the input side of the most recent API call — `input +
cache_creation + cache_read` — against the model's window. Every run reports the
same figure from its own turns: `context.lastTokens` for the latest call and
`context.peakTokens` for the high-water mark that compaction resets. Sub-agent
turns are excluded, since each runs its own window.

The window size itself is not recorded in transcripts, so occupancy is reported
in tokens rather than as a percentage.

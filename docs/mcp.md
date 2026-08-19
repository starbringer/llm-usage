# MCP server

**English** | [简体中文](mcp.zh-CN.md)

The dashboard answers questions you know to ask. The MCP server lets an AI
assistant ask them for you: it exposes the same data — tokens, costs, sessions,
and the whole harness configuration — as callable tools. The two bundled skills
are what consume it — see **[skills.md](skills.md)**.

All of it comes up with the app. There is no second process to start and no Docker.

---

## Setup

```bash
bun run start
```

That is the whole setup. On startup the app:

1. serves the MCP endpoint at **`http://127.0.0.1:5757/mcp`** on the same port as
   the dashboard (streamable HTTP transport);
2. installs the `ai-usage-review` and `ai-change-impact` skills into every
   detected AI tool's user-scope skills directory (`~/.claude/skills/` for
   Claude Code);
3. registers the endpoint with each detected tool by running its own CLI —
   `claude mcp add --scope user --transport http ai-insights http://127.0.0.1:5757/mcp`.

Every step is idempotent: it prints one line the first time and stays silent on
later runs. Restart your AI tool once so it picks up the new server, then ask it
to review your usage, or run `/ai-usage-review`.

### Verifying

```bash
curl http://127.0.0.1:5757/api/mcp-server     # human-readable: tool list, protocol versions
```

In Claude Code, `/mcp` lists `ai-insights` among the connected servers.

### If automatic registration was skipped

The app prints the exact command to run. It falls back to printing rather than
registering when the tool's CLI is not on `PATH`. For Claude Code:

```bash
claude mcp add --scope user --transport http ai-insights http://127.0.0.1:5757/mcp
```

### Opting out

| Flag | Effect |
|---|---|
| `--no-provision` | Don't install skills or register the MCP server. The `/mcp` endpoint is still served. |

The MCP endpoint itself is part of the HTTP server and is not separately
disableable; it is read-only and follows the same loopback binding as the rest
of the API.

### Changing the port

Provisioning is keyed on the URL. Start on a different port and the next run
re-registers the server at the new address automatically:

```bash
bun run start --port=8080     # re-registers at http://127.0.0.1:8080/mcp
```

The registered URL always uses `127.0.0.1`, even when `--host=0.0.0.0` is passed
— the client is always on the same machine, and a LAN address must never end up
in a config file.

---

## Connecting other clients

### Claude Code (and anything speaking streamable HTTP)

```bash
claude mcp add --scope user --transport http ai-insights http://127.0.0.1:5757/mcp
```

Done for you by provisioning; the command is here for manual setup.

### stdio-only clients

Some clients only launch MCP servers as subprocesses. A stdio entry point ships
for them:

```bash
bun run mcp        # = bun run mcp-stdio.ts
```

Configure it as a stdio server with command `bun` and args
`["run", "/absolute/path/to/ai-insights/mcp-stdio.ts"]`.

It is fully standalone — it opens the same SQLite cache and refreshes it from
your transcripts on startup, so it works whether or not the dashboard is
running. Pass `--no-scan` to skip that refresh and read the existing cache
(faster start, possibly stale). The two processes coexist through SQLite's WAL
mode.

`bun run build:mcp` compiles it to a standalone binary at
`dist/ai-insights-mcp` for clients that would rather launch an executable.

---

## Tools

Every tool takes an optional **`provider`** argument naming the data source. It
defaults to `claude-code`; pass `all` to aggregate across every registered
source. Unknown ids fail with a message listing the valid ones. The app-wide
tools, whose answer cannot vary by source (`list_providers`, `get_pricing`,
`get_thresholds`, `get_data_retention`), omit the argument.

Every ranged tool takes **`range`** as `1h`, `24h` or N days (`7d`, `30d`, …). It
defaults to, and is capped at, the [retention window](storage.md#data-retention)
— the app deletes records older than that (30 days by default), so no tool can
look further back. `get_usage_summary` reports the window as `retentionDays`, and
`get_data_retention` returns it on its own.

### Usage

| Tool | Returns |
|---|---|
| `list_providers` | Registered data sources with a live `hasData` flag |
| `get_usage_summary` | `retentionDays`, today / 7d (`null` on a window of 7 days or less) / whole-window totals and cost, cache hit rate, active runs |
| `get_usage_timeseries` | Token trend over a range, bucketed to match it |
| `get_daily_usage` | Day-by-day totals, defaulting to and capped at the retention window |
| `get_model_usage` | Totals per model |
| `get_project_usage` | Totals, run and agent counts per project directory |
| `list_runs` | Paginated session list (`limit`, `offset`, `project`, `search`), each row carrying its `run_key` |
| `get_run` | One run with all its agents |
| `get_run_usage` | Per-run cost breakdown by bucket and model, with plan weight and context occupancy, **plus rendered tuning advice** |
| `get_top_runs` | Sessions ranked by tokens |
| `get_top_turns` | The largest individual API calls |
| `get_mcp_usage` | Tokens and cost recorded while each MCP server was active, with a per-tool payload breakdown |
| `get_skill_usage` | Tokens and cost recorded while each skill was running, plus its invocation count |
| `list_agents` | Agents with model, turn count and token totals |

### Change impact

| Tool | Returns |
|---|---|
| `compare_runs` | Two sessions side by side: cost delta, the three-factor attribution, each run's invoked skills / MCP servers / tools, the harness diff between them, and caveats |
| `compare_periods` | Two windows side by side: totals, per-model and per-bucket splits, normalized rates (cost per run, per API call, tokens per call), the same attribution, harness diff, caveats |
| `get_harness_changes` | When the harness configuration changed and what changed, with token deltas |

Runs are addressed by `run_key` — a short id (`r-9f3a1c2b7e04`) derived from
`(provider, native run id)` rather than assigned, so it survives the cache being
rebuilt and is the same shape for every provider. Any unique prefix of four or
more characters resolves, as does a native run id. `get_run` and `get_run_usage`
accept one too.

Both comparison tools split the cost delta into three terms that **sum exactly**
to it — `volume` (API calls made), `tokens-per-turn` (context per call) and
`price-per-token` (the model and cache blend). Nothing is modelled, so any single
term is quotable as a real figure. `priceEvidence` carries the model shares and
cache rates behind the third term; it is not split further because model choice
and cache behaviour are entangled.

Windows are half-open `[from, until)`, so adjacent periods tile without double
counting. Each bound accepts an ISO timestamp, a date (`2026-07-15`, covering the
whole local day) or a relative offset meaning "ago" (`7d`, `24h`). A window that
ends before the retention cutoff is an **error, not an empty result** — that data
was deleted, and reporting zero would read as "you spent nothing then".

### Harness configuration

| Tool | Returns |
|---|---|
| `get_harness_capabilities` | Which config sections this provider's adapter supports |
| `list_instruction_files` | Instruction files with token counts and the injection series over the retention window |
| `read_instruction_file` | Full text of one enumerated instruction file |
| `list_commands` | Slash commands from all sources, with override marking |
| `list_skills` | Skills with triggers, token cost and **recorded** usage over the retention window |
| `list_hooks` | Hook entries across settings layers with **recorded** fire counts over the retention window |
| `read_hook_script` | Source of a hook's script file |
| `get_permissions` | Merged allow / deny / ask rules with shadowing marked |
| `list_mcp_servers` | Configured MCP servers, probe status, tools, schema token cost |
| `list_memory_stores` | Per-project memory stores with orphan detection |
| `get_effective_config` | Merged settings layers, overrides, ignored-layer warnings |
| `get_dependency_graph` | How skills, hooks, MCP servers and commands reference each other |
| `list_config_projects` | Project directories discovered from transcripts |

### App settings

| Tool | Returns |
|---|---|
| `get_pricing` | The per-model reference price table behind every cost figure |
| `get_thresholds` | Configured warn/error thresholds |
| `get_data_retention` | How many days of records this install keeps — the hard limit on every range and recorded count |

### Payload discipline

Tools that could return whole files return metadata only by default:

| Tool | Flag | Default |
|---|---|---|
| `list_skills`, `list_commands` | `includeContent` | `false` — bodies omitted |
| `list_mcp_servers` | `includeSchemas` | `false` — JSON schemas omitted |
| `get_run_usage` | `includeSeries` | `false` — per-call series replaced by its length |
| `get_run_usage` | `includeComponents` | `false` — invoked skills / MCP servers / tools omitted |
| `compare_runs` | `includeComponents` | `true` — set `false` for a compact answer |

File contents are truncated at 20,000 characters with an explicit marker. A
tool built to diagnose context bloat should not cause it.

---

## What is deliberately *not* exposed

The MCP surface is **read-only**. These HTTP routes have no tool:

| Not exposed | Why |
|---|---|
| `PUT /api/config/instructions/file` | Silently rewriting CLAUDE.md from an analysis run is a footgun |
| `PUT/POST/DELETE /api/config/commands` | Same — commands are user-authored config |
| `PUT /api/config/skills/file` | Same, and a skill that edits skills can edit itself |
| `PUT/DELETE /api/config/hooks*` | Hooks execute shell commands; writing them needs a human in the loop |
| `PUT /api/settings/thresholds` | Changing thresholds would let a review move its own goalposts |
| `GET /api/agent/:id`, `GET /api/agent/:id/tree` | Full transcripts and render-ready session trees, tens of thousands of tokens each, shaped for the UI. Use `get_run_usage` for the same session's costs |

Recommendations come back as text, and the user's own assistant applies them
with its normal, permission-gated edit tools — where they show up as a diff and
can be refused. That is the point: the review proposes, the human disposes.

---

## Security

- Bound to loopback, like the rest of the API.
- **Origin validation** on every MCP request: a request carrying a non-loopback
  `Origin` header is rejected with 403, which blocks DNS-rebinding attacks from
  a web page. Native clients send no `Origin` and pass through.
- `GET /mcp` and `DELETE /mcp` answer `405` — the server offers no
  server-initiated SSE stream and holds no sessions.
- Unsupported `MCP-Protocol-Version` headers are rejected with 400.

The server is stateless: no `Mcp-Session-Id` is issued, every POST stands alone,
and each JSON-RPC request is answered with a single `application/json` body.
Protocol revisions `2025-06-18` (default), `2025-03-26` and `2024-11-05` are
negotiated at `initialize`.

---

## The bundled skills

Two skills consume this server: **`ai-usage-review`** finds what is costing you,
**`ai-change-impact`** proves whether the fix worked. Both are installed on
startup and neither writes. How to invoke them, worked examples and the
review→apply→measure loop: **[skills.md](skills.md)**.

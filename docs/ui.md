# The app, screen by screen

**English** | [简体中文](ui.zh-CN.md)

Every screen of the dashboard, with the controls each one carries. For what the
numbers mean, see [data-model.md](data-model.md); for the MCP server and the
bundled skills, [mcp.md](mcp.md) and [skills.md](skills.md).

*Screenshots are captured from real usage with every project name, path,
conversation and configuration name replaced by consistent stand-ins — see
[screenshots/](screenshots/).*

## Dashboard

- **KPI cards** — today / 7-day / retention-window totals with API-equivalent cost, cache hit rate, active runs
- **Token trend chart** — split into input, output, cache write and cache read
- **Below that** — usage by model, top projects, **MCP token usage** (per-server, with a per-tool tooltip), **skill token usage**, **cache hit rate** with a 50% guide line, **model mix**, and **top 10 runs** (click a bar to jump into that run)

The MCP and skill bars measure the tokens spent *while* each server or skill was
active, not the size of the call that invoked it — the tooltip shows both.

![Dashboard charts](screenshots/02-dashboard-charts.png)

Every ranked bar chart reads largest-first, top down; the run-detail donut starts on
its biggest slice.

Every chart has its own range switcher — `1h` / `24h` / `7d` / `30d` — and remembers
your choice. The ladder follows the [retention window](storage.md#data-retention) —
a 14-day window offers `1h` / `24h` / `7d` / `14d`. Costs are API-equivalent
reference numbers from an editable pricing table, not billing;
[details](data-model.md#cost-estimation).

## Runs

Every recorded session with title, project, agent count (`× N` when a run spawned
sub-agents), turns, token totals and last-active time. Searchable and filterable by
project.

Each row also carries the run's **id** — click it to copy. That is what you hand
to the `ai-change-impact` skill to compare two sessions — [skills.md](skills.md).

![Runs](screenshots/03-runs.png)

## Run detail — session tree

Click **View** on any run for a three-panel replay: agents on the left, the tree in
the middle, full node detail on the right.

![Run detail — session tree](screenshots/04-run-detail-tree.png)

Each agent gets its own tree, stacked in one scrollable view. The spine is the
chronological flow — prompts, LLM calls, hook fires, compactions, errors — and each
LLM call expands into its thinking, text output and every tool call in order:

| | Node | | Node |
|---|---|---|---|
| ⚙ | Plain tool | ⚡ | Hook, with command and duration |
| ⇄ | MCP call | ✕ | API error / rate-limit retry |
| ◈ | Sub-agent spawn, with a `tree ↓` jump link | ▣ | Compaction, pre → post tokens |
| ❖ | Skill invocation, injected body nested underneath | ⤷ | Model refusal fallback |
| ⎇ | Abandoned branch (prompt edits, retries), collapsed | ✚ | Injected context |

The top bar totals the session: prompts, LLM calls, tools, MCP, sub-agents, hooks,
errors, compactions, branches. On narrow screens the side panels collapse into
top-bar toggles.

## Run detail — usage

The middle column's second tab is a cost breakdown for that one run, from the same
deduplicated data as the dashboard.

![Run detail — usage](screenshots/05-run-detail-usage.png)

- KPI cards — cost, **plan usage** in rate-limit weight units, output, cache read, LLM calls, and **context occupancy** (last call / peak) — plus a cumulative spend curve and a per-model table
- **Cost-by-bucket donut** — base / MCP / skills / sub-agents, every API call classified at parse time from the provider's own attribution
- **Tuning advice** from this run's real numbers — *"re-priced at a cheaper model these calls would cost $X (Y%) less"*, low cache-hit warnings, sub-agent-heavy runs

## Harness

The **Harness** group inspects — and where safe, edits — the active tool's
configuration. Each tab appears only if the active provider supports that
capability, so a future adapter for another tool simply shows fewer tabs. Most tabs
share one layout: a list column and a detail column, each scrolling on its own.

### CLAUDE.md

Every instruction file the tool injects: the global `~/.claude/CLAUDE.md` plus
`CLAUDE.md` / `.claude/CLAUDE.md` for every project your transcripts have touched
(missing ones listed as creatable). Per-file token and word counts, an inline editor
with **Save**, and a timeline of injected tokens per day.

![CLAUDE.md](screenshots/06-claudemd.png)

### Commands

Slash commands from all three sources — user, project, enabled plugins — with
`:`-namespacing, argument hints, `$ARGUMENTS` detection, token cost, search, and
**same-name override detection** so you can see which definition wins. User and
project commands are editable; plugin commands are read-only.

![Commands](screenshots/07-commands.png)

### Skills

Override detection, SKILL.md token cost, `references/` and `scripts/` listings,
**recorded** invocations and injected tokens over the retention window, and a
**trigger analyzer** showing which prompt keywords would activate the skill.

**Related components** rounds it out: the hooks, MCP servers and commands this
skill is wired to, as a graph plus a list — a column per component type, arrows
running from the referencing component to the referenced one, solid for a content
reference and dashed for the weaker name-similarity signal. A skill nothing
references says so instead.

![Skills](screenshots/08-skills.png)

### Hooks

Every hook across every settings layer, with its matcher, action type and
**recorded fire count** over the retention window — from the event stream, not
estimated.

![Hooks](screenshots/09-hooks.png)

Actions that run a script file (`.ps1`, `.sh`, `.py`, …) are resolved on disk: click
one to read, edit and save it. Removing a hook deletes its entry from the settings
file and leaves the script on disk.

![Hook script editor](screenshots/10-hooks-script.png)

### MCP

Servers with scope, transport and tool count on the left; command, source file,
probe status, injection estimate over the window, and expandable tools with
descriptions and JSON schemas on the right. Diagnostics live in the default panel;
a re-probe button bypasses the 10-minute cache.

![MCP](screenshots/11-mcp.png)

Servers are enumerated from config files rather than the CLI, and project-scope
servers you haven't approved are listed but never executed —
[why](architecture.md#mcp-why-config-files-not-the-cli). Each server also gets
the same **Related components** section as a skill, which is where clusters with no
skill in them (a hook or command wired straight to a server) show up.

### Permissions

`allow` / `deny` / `ask` rules parsed into tool + specifier across the user layer
and, via the project selector, a project's settings and local settings. Shows the
merged effective set; a rule shadowed by a higher-priority layer is struck through.

![Permissions](screenshots/12-permissions.png)

### Memory

Per-project persistent memory stores: the MEMORY.md index, every topic file with its
content, size and last-modified time, and an **orphan** badge for files that exist
but aren't linked from the index.

![Memory](screenshots/13-memory.png)

### Configs

A read-only merged view of the settings layers: headline cards for the **default
model** and its source layer, effort level, and the most-used model of the last 7
days from your actual transcripts. Below, every key's winning value, which layers it
overrides, and warnings for keys set in a layer the tool never reads.

![Effective Configs](screenshots/15-configs.png)

## Settings

Warning thresholds behind the ok/warn/error badges on the Harness tabs,
[data retention](storage.md#data-retention), and the per-model reference pricing
that drives every cost number in the app.

![Settings](screenshots/16-settings.png)

## Themes and data sources

Light (warm cream) and dark (slate) themes, toggled with the sun/moon button in the
top-right corner; the choice persists and charts re-theme in place.

![Dark theme](screenshots/17-dashboard-dark.png)

The **Source ▾** switcher in the top bar lists every registered provider and marks
which ones have data. On first launch the app picks the first provider that has data.

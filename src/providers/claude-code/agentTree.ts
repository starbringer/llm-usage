import { readFileSync } from "node:fs";
import { findAgentFile } from "./agentDetail";

/**
 * Session-tree builder.
 *
 * A Claude Code transcript is a DAG: every line carries `uuid` + `parentUuid`.
 * One API response is written as several `assistant` lines (one per content
 * block) chained through parentUuid and sharing `message.id`. Tool results
 * come back as `user` lines whose content is tool_result blocks. Hooks,
 * API errors, compaction and model fallbacks are `system` lines. Branches
 * (edits / retries / rewinds) appear as a uuid with more than one child.
 *
 * This module folds that DAG into a render-ready tree:
 *   - the SPINE: chronological flow of prompt → API call → API call → …
 *   - each API-call node's CHILDREN: thinking, text output, tool calls
 *     (with their results attached), context injections;
 *   - hook fires / errors / compaction / fallbacks as spine events;
 *   - abandoned uuid branches as collapsed "branch" sub-trees.
 *
 * Sidechains (in-file sub-agent transcripts, isSidechain=true) and
 * post-compaction segments become additional root trees for the same agent.
 */

export interface TreeUsage {
  input: number;
  cacheRead: number;
  cacheCreate: number;
  output: number;
}

export interface TreeSection {
  heading?: string;
  text: string;
  code?: boolean;
  error?: boolean;
}

export type TreeNodeKind =
  | "prompt"       // human input (or injected prompt)
  | "assistant"    // one API call (grouped by message.id)
  | "text"         // assistant text output block
  | "thinking"     // assistant thinking block (non-empty only)
  | "tool"         // tool_use (+ result folded in)
  | "context"      // framework-injected context (attachments, skill content)
  | "hook"         // stop_hook_summary
  | "api_error"    // failed API call (synthetic assistant line or system api_error)
  | "compact"      // compact_boundary
  | "fallback"     // model_refusal_fallback
  | "info"         // turn_duration and other low-signal system lines
  | "branch";      // abandoned uuid branch (edits / retries)

export interface TreeNode {
  id: string;
  kind: TreeNodeKind;
  label: string;
  sub?: string;
  ts?: string;
  status?: "ok" | "err" | "warn" | "info";
  cat?: "tool" | "mcp" | "task" | "skill";
  model?: string;
  usage?: TreeUsage | null;
  taskDesc?: string;           // Task/Agent tool description → subagent linking
  sections?: TreeSection[];    // full content for the detail panel
  children?: TreeNode[];
}

export interface AgentTreeStats {
  prompts: number;
  apiCalls: number;
  tools: number;
  mcp: number;
  tasks: number;
  hooks: number;
  errors: number;
  compactions: number;
  branches: number;
}

export interface AgentTree {
  agentId: string;
  trees: { label: string; spine: TreeNode[] }[];
  stats: AgentTreeStats;
}

// ===== raw line shapes =====

interface RawEntry {
  type: string;
  subtype?: string;
  uuid: string;
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  /** Set on records a fork replayed out of an earlier session — see parser.ts. */
  forkedFrom?: { sessionId?: string; messageUuid?: string };
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  sourceToolUseID?: string;
  attributionSkill?: string;
  requestId?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
    usage?: Record<string, unknown>;
  };
  attachment?: { type?: string; [k: string]: unknown };
  // system-line extras
  hookCount?: number;
  hookInfos?: { command?: string; durationMs?: number }[];
  hookErrors?: unknown[];
  hookAdditionalContext?: unknown[];
  preventedContinuation?: boolean;
  stopReason?: string;
  error?: { message?: string; status?: number; formatted?: string };
  retryAttempt?: number;
  maxRetries?: number;
  retryInMs?: number;
  durationMs?: number;
  messageCount?: number;
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number };
  originalModel?: string;
  fallbackModel?: string;
  apiRefusalCategory?: string | null;
  content?: string;
}

const TRUNC = 220;

function clip(s: string, n = TRUNC): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function shortModel(model?: string | null): string {
  return (model ?? "").replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: unknown) => (b as Record<string, unknown>)["type"] === "text")
      .map((b: unknown) => String((b as Record<string, unknown>)["text"] ?? ""))
      .join("\n");
  }
  return "";
}

/** Slash-command invocations are wrapped in XML-ish markers; unwrap for display. */
function parseCommand(text: string): { name: string; args: string } | null {
  const m = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (!m) return null;
  const a = text.match(/<command-args>([^<]*)<\/command-args>/);
  return { name: (m[1] ?? "").trim(), args: (a?.[1] ?? "").trim() };
}

function toolCategory(name: string): "tool" | "mcp" | "task" | "skill" {
  if (name.startsWith("mcp__")) return "mcp";
  if (name === "Task" || name === "Agent") return "task";
  if (name === "Skill") return "skill";
  return "tool";
}

const ATTACHMENT_LABELS: Record<string, string> = {
  todo_reminder: "todo reminder",
  deferred_tools_delta: "deferred tools loaded",
  skill_listing: "skill listing",
  agent_listing_delta: "agent listing",
  date_change: "date change",
  file: "file",
  command_permissions: "command permissions",
  queued_command: "queued command",
  edited_text_file: "edited file notice",
  task_reminder: "task reminder",
  compact_file_reference: "compact file reference",
};

// ===== main =====

export function loadAgentTree(agentId: string): AgentTree | null {
  const path = findAgentFile(agentId);
  if (!path) return null;

  let raw: string;
  try { raw = readFileSync(path, "utf-8"); } catch { return null; }

  const entries: RawEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as RawEntry;
      // Replayed pre-fork history belongs to the session that produced it, and
      // is already shown in full under that run. Keeping it here would make the
      // tree's call and prompt counts disagree with the Usage tab, which skips
      // the same records.
      if (e.forkedFrom) continue;
      entries.push(e);
    } catch { /* skip malformed */ }
  }

  const stats: AgentTreeStats = {
    prompts: 0, apiCalls: 0, tools: 0, mcp: 0, tasks: 0,
    hooks: 0, errors: 0, compactions: 0, branches: 0,
  };

  // --- index the DAG ---
  const byUuid = new Map<string, RawEntry>();
  const children = new Map<string, RawEntry[]>();
  const roots: RawEntry[] = [];
  const fileIndex = new Map<string, number>();

  const isGraphType = (e: RawEntry) =>
    e.type === "user" || e.type === "assistant" || e.type === "system" || e.type === "attachment";

  entries.forEach((e, i) => {
    if (!isGraphType(e) || !e.uuid) return;
    byUuid.set(e.uuid, e);
    if (!fileIndex.has(e.uuid)) fileIndex.set(e.uuid, i);
  });
  for (const e of entries) {
    if (!isGraphType(e) || !e.uuid || byUuid.get(e.uuid) !== e) continue;
    // compact_boundary restarts parentUuid at null but records the logical
    // parent — link through it so the conversation reads as one flow.
    const parent = e.parentUuid ?? e.logicalParentUuid ?? null;
    if (parent && byUuid.has(parent) && parent !== e.uuid) {
      const list = children.get(parent) ?? [];
      list.push(e);
      children.set(parent, list);
    } else {
      roots.push(e);
    }
  }

  // The mainline at a fork is the child whose subtree reaches furthest in the
  // file (i.e. the path the session actually continued on). Earlier siblings
  // are abandoned branches: prompt edits, refusal retries, rewinds — or
  // leaf system events, which get inlined rather than shown as branches.
  // Computed bottom-up in reverse file order (children are appended after
  // their parents), so this stays iterative — no recursion on chains that can
  // run to tens of thousands of lines.
  const maxDesc = new Map<string, number>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (!e.uuid || byUuid.get(e.uuid) !== e) continue;
    let best = fileIndex.get(e.uuid) ?? -1;
    for (const k of children.get(e.uuid) ?? []) {
      best = Math.max(best, maxDesc.get(k.uuid) ?? (fileIndex.get(k.uuid) ?? -1));
    }
    maxDesc.set(e.uuid, best);
  }
  function maxDescIndex(uuid: string): number {
    return maxDesc.get(uuid) ?? (fileIndex.get(uuid) ?? -1);
  }

  /** Split an entry's children into the continuation + abandoned branches. */
  function nextMainline(e: RawEntry): { next: RawEntry | null; abandoned: RawEntry[] } {
    const kids = children.get(e.uuid) ?? [];
    if (kids.length === 0) return { next: null, abandoned: [] };
    let best = kids[0]!;
    for (const k of kids) {
      if (maxDescIndex(k.uuid) >= maxDescIndex(best.uuid)) best = k;
    }
    return { next: best, abandoned: kids.filter(k => k !== best) };
  }

  const visited = new Set<string>();

  // --- tool results: tool_use_id -> result ---
  interface ToolResult { text: string; isError: boolean }
  const resultsByToolId = new Map<string, ToolResult>();
  for (const e of entries) {
    if (e.type !== "user" || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content as Record<string, unknown>[]) {
      if (b["type"] !== "tool_result") continue;
      const id = String(b["tool_use_id"] ?? "");
      if (!id) continue;
      const c = b["content"];
      const text = Array.isArray(c)
        ? (c as Record<string, unknown>[])
            .filter(x => x["type"] === "text")
            .map(x => String(x["text"] ?? ""))
            .join("\n")
        : String(c ?? "");
      resultsByToolId.set(id, { text, isError: b["is_error"] === true });
    }
  }

  // --- injected content sourced from a tool call (Skill bodies etc.) ---
  const injectedByToolId = new Map<string, RawEntry[]>();
  for (const e of entries) {
    if (e.type === "user" && e.sourceToolUseID) {
      const list = injectedByToolId.get(e.sourceToolUseID) ?? [];
      list.push(e);
      injectedByToolId.set(e.sourceToolUseID, list);
    }
  }

  const isToolResultOnly = (e: RawEntry): boolean => {
    const c = e.message?.content;
    return Array.isArray(c) && c.length > 0 &&
      (c as Record<string, unknown>[]).every(b => b["type"] === "tool_result");
  };

  // ===== walk one chain into a spine =====

  function buildSpine(start: RawEntry): TreeNode[] {
    const spine: TreeNode[] = [];
    let cursor: RawEntry | null = start;
    let pendingAttachments: RawEntry[] = [];

    const flushAttachments = (target: TreeNode[] | TreeNode) => {
      if (!pendingAttachments.length) return;
      const kinds = pendingAttachments.map(a => ATTACHMENT_LABELS[a.attachment?.type ?? ""] ?? a.attachment?.type ?? "attachment");
      const uniq = [...new Set(kinds)];
      const node: TreeNode = {
        id: pendingAttachments[0]!.uuid,
        kind: "context",
        label: `Context injected · ${uniq.join(", ")}`,
        ts: pendingAttachments[0]!.timestamp,
        status: "info",
        sections: pendingAttachments.map(a => ({
          heading: ATTACHMENT_LABELS[a.attachment?.type ?? ""] ?? a.attachment?.type ?? "attachment",
          text: clip(JSON.stringify(a.attachment ?? {}, null, 2), 4000),
          code: true,
        })),
      };
      if (Array.isArray(target)) target.push(node);
      else (target.children ??= []).push(node);
      pendingAttachments = [];
    };

    while (cursor) {
      const e: RawEntry = cursor;
      if (visited.has(e.uuid)) break; // cycle / cross-link guard
      visited.add(e.uuid);
      const { next, abandoned } = nextMainline(e);

      if (e.type === "attachment") {
        pendingAttachments.push(e);
      } else if (e.type === "user") {
        if (isToolResultOnly(e) || e.sourceToolUseID) {
          // consumed elsewhere (folded into tool nodes)
        } else if (e.isMeta) {
          // framework caveat lines — skip
        } else {
          const node = buildPromptNode(e);
          if (node) {
            flushAttachments(spine);
            spine.push(node);
            if (node.kind === "prompt") stats.prompts++;
          }
        }
      } else if (e.type === "assistant") {
        // group the chain of assistant lines sharing message.id into one API call
        const group: RawEntry[] = [e];
        let gNext: RawEntry | null = next;
        let gAbandoned: RawEntry[] = abandoned;
        while (
          gNext && gNext.type === "assistant" && !visited.has(gNext.uuid) &&
          gNext.message?.id && gNext.message.id === e.message?.id
        ) {
          visited.add(gNext.uuid);
          group.push(gNext);
          const step = nextMainline(gNext);
          gAbandoned = gAbandoned.concat(step.abandoned);
          gNext = step.next;
        }
        const node = buildAssistantNode(group);
        flushAttachments(spine);
        spine.push(node);
        pushBranches(spine, gAbandoned);
        cursor = gNext;
        continue;
      } else if (e.type === "system") {
        const node = buildSystemNode(e);
        if (node) { flushAttachments(spine); spine.push(node); }
      }

      pushBranches(spine, abandoned);
      cursor = next;
    }

    flushAttachments(spine);
    return spine;
  }

  function pushBranches(spine: TreeNode[], abandoned: RawEntry[]): void {
    for (const b of abandoned) {
      if (visited.has(b.uuid)) continue;
      const sub = buildSpine(b);
      if (!sub.length) continue;
      // A side path that is pure system/context events (a leaf hook fire, a
      // refusal-fallback notice, retry errors) is part of the story, not an
      // abandoned conversation — inline it into the spine.
      const conversational = sub.some(n => n.kind === "prompt" || n.kind === "assistant");
      if (!conversational) {
        spine.push(...sub);
        continue;
      }
      stats.branches++;
      spine.push({
        id: `branch-${b.uuid}`,
        kind: "branch",
        label: `Abandoned branch · ${sub.length} step${sub.length !== 1 ? "s" : ""}`,
        ts: b.timestamp,
        status: "info",
        children: sub,
      });
    }
  }

  function buildPromptNode(e: RawEntry): TreeNode | null {
    const text = blockText(e.message?.content);
    if (!text.trim()) return null;

    // Framework-injected wrappers travel inside user messages; strip them for
    // the label (full text stays in the detail panel).
    const stripped = text
      .replace(/<(ide_selection|ide_opened_file|ide_diagnostics|system-reminder|local-command-stdout|command-message|command-contents|command-name|command-args)>[\s\S]*?<\/\1>/g, "")
      .trim();

    const cmd = parseCommand(text);
    if (cmd) {
      return {
        id: e.uuid, kind: "prompt",
        label: `${cmd.name}${cmd.args ? ` ${clip(cmd.args, 80)}` : ""}`,
        sub: "slash command", ts: e.timestamp,
        sections: [{ heading: "User prompt", text }],
      };
    }
    if (e.isCompactSummary) {
      return {
        id: e.uuid, kind: "prompt",
        label: "Compact summary (carried-over context)",
        ts: e.timestamp,
        sections: [{ heading: "Compact summary", text }],
      };
    }
    // Message is pure injected context (IDE state, command stdout, reminders)
    if (!stripped) {
      const tag = text.match(/<([a-z-_]+)>/)?.[1] ?? "injected";
      return {
        id: e.uuid, kind: "context",
        label: `Context · ${tag.replace(/[-_]/g, " ")}`,
        ts: e.timestamp, status: "info",
        sections: [{ heading: "Injected context", text }],
      };
    }
    return {
      id: e.uuid, kind: "prompt",
      label: clip(stripped),
      sub: stripped.length !== text.length ? "includes injected context" : undefined,
      ts: e.timestamp,
      sections: [{ heading: "User prompt", text }],
    };
  }

  function buildAssistantNode(group: RawEntry[]): TreeNode {
    const first = group[0]!;
    const usage = first.message?.usage;
    const u: TreeUsage | null = usage ? {
      input: Number(usage["input_tokens"] ?? 0),
      cacheRead: Number(usage["cache_read_input_tokens"] ?? 0),
      cacheCreate: Number(usage["cache_creation_input_tokens"] ?? 0),
      output: Number(usage["output_tokens"] ?? 0),
    } : null;

    // API-error echo (rate limit, auth, …) — surfaced as an error node
    if (first.isApiErrorMessage || first.message?.model === "<synthetic>") {
      stats.errors++;
      const text = blockText(first.message?.content);
      return {
        id: first.uuid,
        kind: "api_error",
        label: clip(text || "API error", 140),
        ts: first.timestamp,
        status: "err",
        sections: [{ heading: "API error", text: text || "(no message)", error: true }],
      };
    }

    stats.apiCalls++;
    const kidNodes: TreeNode[] = [];
    const textParts: string[] = [];

    for (const line of group) {
      const content = line.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content as Record<string, unknown>[]) {
        const btype = b["type"];
        if (btype === "text") {
          const t = String(b["text"] ?? "");
          if (t.trim()) {
            textParts.push(t);
            kidNodes.push({
              id: `${line.uuid}-text`,
              kind: "text",
              label: clip(t),
              ts: line.timestamp,
              sections: [{ heading: "Assistant", text: t }],
            });
          }
        } else if (btype === "thinking") {
          const t = String(b["thinking"] ?? "");
          if (t.trim()) {
            kidNodes.push({
              id: `${line.uuid}-think`,
              kind: "thinking",
              label: clip(t, 140),
              ts: line.timestamp,
              status: "info",
              sections: [{ heading: "Thinking", text: t }],
            });
          }
        } else if (btype === "tool_use") {
          kidNodes.push(buildToolNode(line, b));
        }
      }
    }

    const model = shortModel(first.message?.model);
    const toolCt = kidNodes.filter(k => k.kind === "tool").length;
    const label = textParts.length
      ? clip(textParts.join(" "))
      : toolCt
        ? `${toolCt} tool call${toolCt !== 1 ? "s" : ""}`
        : "(empty response)";

    const subParts: string[] = [model];
    if (u) {
      subParts.push(`out ${fmtTok(u.output)}`);
      if (u.cacheRead) subParts.push(`cache ${fmtTok(u.cacheRead)}`);
    }
    if (first.attributionSkill) subParts.push(`skill: ${first.attributionSkill}`);

    return {
      id: first.uuid,
      kind: "assistant",
      label,
      sub: subParts.filter(Boolean).join(" · "),
      ts: first.timestamp,
      model: first.message?.model ?? undefined,
      usage: u,
      children: kidNodes,
      sections: textParts.length ? [{ heading: "Assistant", text: textParts.join("\n\n") }] : undefined,
    };
  }

  function buildToolNode(line: RawEntry, b: Record<string, unknown>): TreeNode {
    const name = String(b["name"] ?? "tool");
    const id = String(b["id"] ?? `${line.uuid}-tool`);
    const cat = toolCategory(name);
    const input = b["input"] as Record<string, unknown> | undefined;
    const inputStr = JSON.stringify(input ?? {}, null, 2);
    const result = resultsByToolId.get(id);

    if (cat === "mcp") stats.mcp++;
    else if (cat === "task") stats.tasks++;
    else stats.tools++;

    // short human label per tool
    let arg = "";
    if (input) {
      const cand = input["command"] ?? input["file_path"] ?? input["path"] ?? input["pattern"]
        ?? input["query"] ?? input["url"] ?? input["description"] ?? input["skill"] ?? input["prompt"];
      if (cand != null) arg = clip(String(cand), 110);
    }
    const displayName = cat === "mcp" ? name.replace(/^mcp__/, "").replace(/__/g, " · ") : name;

    const sections: TreeSection[] = [
      { heading: "Input", text: inputStr, code: true },
    ];
    if (result) {
      sections.push({
        heading: result.isError ? "Result — error" : "Result",
        text: result.text || "(empty)",
        code: true,
        error: result.isError,
      });
    }

    const node: TreeNode = {
      id,
      kind: "tool",
      cat,
      label: arg ? `${displayName} · ${arg}` : displayName,
      sub: result ? (result.isError ? "error" : `→ ${clip(result.text, 90) || "ok"}`) : "no result recorded",
      ts: line.timestamp,
      status: result ? (result.isError ? "err" : "ok") : "warn",
      taskDesc: cat === "task" && input?.["description"] != null ? String(input["description"]) : undefined,
      sections,
    };

    // Skill bodies / tool-sourced prompt injections hang off their tool call
    const injected = injectedByToolId.get(id);
    if (injected?.length) {
      node.children = injected.map(inj => ({
        id: inj.uuid,
        kind: "context" as const,
        label: `Injected content · ${clip(blockText(inj.message?.content), 90)}`,
        ts: inj.timestamp,
        status: "info" as const,
        sections: [{ heading: "Injected content", text: blockText(inj.message?.content) }],
      }));
    }
    return node;
  }

  function buildSystemNode(e: RawEntry): TreeNode | null {
    switch (e.subtype) {
      case "stop_hook_summary": {
        stats.hooks++;
        const cmds = (e.hookInfos ?? []).map(h => `${h.command ?? "?"} (${h.durationMs ?? "?"}ms)`);
        const blocked = e.preventedContinuation === true;
        const failed = (e.hookErrors ?? []).length > 0;
        return {
          id: e.uuid,
          kind: "hook",
          label: `Stop hook · ${e.hookCount ?? cmds.length} hook${(e.hookCount ?? 1) !== 1 ? "s" : ""}${blocked ? " · blocked continuation" : ""}`,
          sub: clip(cmds.join("; "), 120),
          ts: e.timestamp,
          status: failed || blocked ? "warn" : "info",
          sections: [
            { heading: "Hooks", text: cmds.join("\n") || "(none)" },
            ...(e.stopReason ? [{ heading: "Stop reason", text: e.stopReason }] : []),
            ...(failed ? [{ heading: "Hook errors", text: JSON.stringify(e.hookErrors, null, 2), code: true, error: true }] : []),
          ],
        };
      }
      case "api_error": {
        stats.errors++;
        const msg = e.error?.formatted ?? e.error?.message ?? "API error";
        return {
          id: e.uuid,
          kind: "api_error",
          label: clip(msg, 140),
          sub: e.retryAttempt != null ? `retry ${e.retryAttempt}/${e.maxRetries ?? "?"} in ${Math.round(e.retryInMs ?? 0)}ms` : undefined,
          ts: e.timestamp,
          status: "err",
          sections: [{ heading: "API error", text: JSON.stringify(e.error ?? {}, null, 2), code: true, error: true }],
        };
      }
      case "compact_boundary": {
        stats.compactions++;
        const m = e.compactMetadata;
        return {
          id: e.uuid,
          kind: "compact",
          label: `Context compacted (${m?.trigger ?? "auto"})`,
          sub: m ? `${fmtTok(m.preTokens ?? 0)} → ${fmtTok(m.postTokens ?? 0)} tokens` : undefined,
          ts: e.timestamp,
          status: "info",
          sections: [{ heading: "Compaction", text: JSON.stringify(m ?? {}, null, 2), code: true }],
        };
      }
      case "model_refusal_fallback": {
        return {
          id: e.uuid,
          kind: "fallback",
          label: `Model fallback · ${shortModel(e.originalModel)} → ${shortModel(e.fallbackModel)}`,
          sub: e.apiRefusalCategory ? `refusal category: ${e.apiRefusalCategory}` : undefined,
          ts: e.timestamp,
          status: "warn",
          sections: [{ heading: "Refusal fallback", text: e.content ?? "" }],
        };
      }
      case "turn_duration": {
        return {
          id: e.uuid,
          kind: "info",
          label: `Turn finished · ${((e.durationMs ?? 0) / 1000).toFixed(1)}s · ${e.messageCount ?? "?"} messages`,
          ts: e.timestamp,
          status: "info",
        };
      }
      default:
        if (!e.subtype && !e.content) return null;
        return {
          id: e.uuid,
          kind: "info",
          label: clip(`${e.subtype ?? "system"}${e.content ? ` · ${e.content}` : ""}`, 140),
          ts: e.timestamp,
          status: "info",
        };
    }
  }

  // ===== assemble root trees =====

  const trees: AgentTree["trees"] = [];
  let mainCount = 0, sideCount = 0;
  for (const root of roots) {
    const spine = buildSpine(root);
    if (!spine.length) continue;
    if (root.isSidechain) {
      sideCount++;
      trees.push({ label: `Sidechain ${sideCount}`, spine });
    } else {
      mainCount++;
      trees.push({ label: mainCount === 1 ? "Main thread" : `Continuation ${mainCount - 1}`, spine });
    }
  }

  return { agentId, trees, stats };
}

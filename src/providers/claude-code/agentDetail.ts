import { readFileSync, readdirSync } from "node:fs";
import { join } from "path";
import { PROJECTS_DIR } from "../../paths";

export interface ToolCall {
  id: string;
  name: string;
  inputSummary: string;
}

export interface ToolResult {
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface UsageInfo {
  input: number;
  cacheRead: number;
  cacheCreate: number;
  output: number;
}

export interface HumanTurn {
  kind: "human";
  uuid: string;
  timestamp: string;
  text: string;
  attachments?: string[];
}

export interface AssistantTurn {
  kind: "assistant";
  uuid: string;
  timestamp: string;
  model: string;
  text: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  usage: UsageInfo | null;
}

export type DetailTurn = HumanTurn | AssistantTurn;

export function findAgentFile(agentId: string): string | null {
  function search(dir: string, depth = 0): string | null {
    if (depth > 4) return null;
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          const f = search(join(dir, e.name), depth + 1);
          if (f) return f;
        } else if (e.name === `${agentId}.jsonl` || e.name === `agent-${agentId}.jsonl`) {
          return join(dir, e.name);
        }
      }
    } catch { /* ignore unreadable */ }
    return null;
  }
  return search(PROJECTS_DIR);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: unknown) => (b as Record<string, unknown>)["type"] === "text")
      .map((b: unknown) => String((b as Record<string, unknown>)["text"] ?? ""))
      .join("\n");
  }
  return "";
}

/**
 * Load normalized turns for a single Claude Code agent.
 *
 * Claude Code transcripts contain several line types beyond plain user/assistant:
 *   - queue-operation: pre-prompt enqueue (carries the raw composed prompt)
 *   - last-prompt:     final composed prompt (system + user + attachments)
 *   - attachment:      file attachment sent with the next user turn
 *   - ai-title:        AI-generated session title
 * Most of these are framework bookkeeping. We surface attachments by name on
 * their owning user turn; the rest are dropped from the UI flow but remain
 * in the raw JSONL.
 *
 * Text is returned in full — no truncation. The UI is responsible for any
 * length-based clipping or "show more" affordances.
 */
export function loadAgentDetail(agentId: string): DetailTurn[] {
  const path = findAgentFile(agentId);
  if (!path) return [];

  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter(Boolean);

  interface RawEntry {
    type: string;
    uuid: string;
    timestamp: string;
    isMeta?: boolean;
    forkedFrom?: { sessionId?: string; messageUuid?: string };
    parentUuid?: string;
    message?: Record<string, unknown>;
    attachment?: { fileName?: string; filename?: string; path?: string };
  }

  const entries: RawEntry[] = [];
  const attachmentsByParent = new Map<string, string[]>();

  for (const line of lines) {
    try {
      const e = JSON.parse(line) as RawEntry;
      // See agentTree: a fork's replayed history is not this session's work.
      if (e.forkedFrom) continue;
      if (e.type === "user" || e.type === "assistant") {
        entries.push(e);
      } else if (e.type === "attachment" && e.parentUuid) {
        const a = e.attachment ?? {};
        const name = a.fileName ?? a.filename ?? a.path ?? "(attachment)";
        const list = attachmentsByParent.get(e.parentUuid) ?? [];
        list.push(name);
        attachmentsByParent.set(e.parentUuid, list);
      }
      // queue-operation, last-prompt, ai-title: framework bookkeeping; skip.
    } catch { /* malformed line — skip */ }
  }

  // Tool-result map: assistant turn's uuid -> list of results returned to it.
  const toolResultsByParent = new Map<string, ToolResult[]>();
  for (const e of entries) {
    if (e.type !== "user" || !e.message) continue;
    const content = e.message["content"];
    if (!Array.isArray(content)) continue;
    const results = content.filter((b: unknown) => (b as Record<string, unknown>)["type"] === "tool_result");
    if (!results.length) continue;
    const parentUuid = (e as unknown as Record<string, unknown>)["parentUuid"] as string;
    if (!parentUuid) continue;
    const list: ToolResult[] = results.map((tr: unknown) => {
      const t = tr as Record<string, unknown>;
      const c = t["content"];
      const txt = Array.isArray(c)
        ? c.filter((x: unknown) => (x as Record<string, unknown>)["type"] === "text")
            .map((x: unknown) => String((x as Record<string, unknown>)["text"] ?? ""))
            .join("\n")
        : String(c ?? "");
      return { toolUseId: String(t["tool_use_id"] ?? ""), content: txt, isError: t["is_error"] === true };
    });
    toolResultsByParent.set(parentUuid, list);
  }

  const turns: DetailTurn[] = [];
  for (const e of entries) {
    if (!e.message) continue;

    if (e.type === "user") {
      if (e.isMeta) continue;
      const content = e.message["content"];
      if (Array.isArray(content)) {
        const hasOnlyToolResults = content.every((b: unknown) => (b as Record<string, unknown>)["type"] === "tool_result");
        if (hasOnlyToolResults) continue;
      }
      const text = contentText(content);
      if (!text.trim()) continue;
      const attachments = attachmentsByParent.get(e.uuid);
      turns.push({
        kind: "human",
        uuid: e.uuid,
        timestamp: e.timestamp,
        text,
        ...(attachments && attachments.length ? { attachments } : {}),
      });

    } else if (e.type === "assistant") {
      const content = (e.message["content"] as unknown[]) ?? [];
      const textParts: string[] = [];
      const toolCalls: ToolCall[] = [];

      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b["type"] === "text") {
          textParts.push(String(b["text"] ?? ""));
        } else if (b["type"] === "tool_use") {
          const inputStr = JSON.stringify(b["input"] ?? {});
          toolCalls.push({
            id: String(b["id"] ?? ""),
            name: String(b["name"] ?? "unknown"),
            inputSummary: inputStr,
          });
        }
        // skip thinking blocks
      }

      const usage = e.message["usage"] as Record<string, unknown> | undefined;
      const toolResults = toolResultsByParent.get(e.uuid) ?? [];

      turns.push({
        kind: "assistant",
        uuid: e.uuid,
        timestamp: e.timestamp,
        model: String(e.message["model"] ?? ""),
        text: textParts.join("\n"),
        toolCalls,
        toolResults,
        usage: usage ? {
          input: Number(usage["input_tokens"] ?? 0),
          cacheRead: Number(usage["cache_read_input_tokens"] ?? 0),
          cacheCreate: Number(usage["cache_creation_input_tokens"] ?? 0),
          output: Number(usage["output_tokens"] ?? 0),
        } : null,
      });
    }
  }

  return turns;
}

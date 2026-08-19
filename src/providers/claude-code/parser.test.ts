import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSchema } from "../../db";
import { parseFileIncremental } from "./parser";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ai-insights-parser-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function db(): Database {
  const d = new Database(":memory:");
  initSchema(d);
  return d;
}

/** One assistant line carrying a usage block, in Claude Code's shape. */
function assistantLine(o: {
  uuid: string; requestId: string; messageId: string; ts: string;
  output?: number; forkedFrom?: unknown; attributionSkill?: string;
  attributionMcpServer?: string; toolUse?: string;
}) {
  const content: unknown[] = [{ type: "text", text: "hi" }];
  if (o.toolUse) content.push({ type: "tool_use", id: "tu_1", name: o.toolUse, input: {} });
  return JSON.stringify({
    type: "assistant", uuid: o.uuid, requestId: o.requestId, timestamp: o.ts,
    sessionId: "sess", cwd: "/tmp/proj", isSidechain: false,
    ...(o.forkedFrom !== undefined && { forkedFrom: o.forkedFrom }),
    ...(o.attributionSkill !== undefined && { attributionSkill: o.attributionSkill }),
    ...(o.attributionMcpServer !== undefined && { attributionMcpServer: o.attributionMcpServer }),
    message: {
      id: o.messageId, role: "assistant", model: "claude-opus-5", content,
      usage: {
        input_tokens: 5, output_tokens: o.output ?? 50,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 1000,
      },
    },
  });
}

function write(name: string, lines: string[]): string {
  const p = join(dir, name);
  writeFileSync(p, lines.join("\n") + "\n", "utf-8");
  return p;
}

const turns = (d: Database) =>
  d.query<{ dedupe_key: string; agent_id: string; bucket: number; output_tokens: number;
            attribution_skill: string | null; attribution_mcp_server: string | null }, []>(
    "SELECT dedupe_key, agent_id, bucket, output_tokens, attribution_skill, attribution_mcp_server FROM turns"
  ).all();

describe("forked records", () => {
  test("a replayed pre-fork call is not counted again", () => {
    const d = db();
    const original = write("orig.jsonl", [
      assistantLine({ uuid: "u1", requestId: "req_1", messageId: "msg_1", ts: "2026-08-19T00:00:00.000Z" }),
    ]);
    // The fork copies that record verbatim, keeping requestId and message.id,
    // and stamps forkedFrom. Then it records its own new call.
    const forked = write("fork.jsonl", [
      assistantLine({
        uuid: "u1", requestId: "req_1", messageId: "msg_1", ts: "2026-08-19T00:00:00.000Z",
        forkedFrom: { sessionId: "sess", messageUuid: "u1" },
      }),
      assistantLine({ uuid: "u2", requestId: "req_2", messageId: "msg_2", ts: "2026-08-19T00:05:00.000Z" }),
    ]);

    parseFileIncremental(d, original, false, null);
    parseFileIncremental(d, forked, false, null);

    const t = turns(d);
    expect(t).toHaveLength(2);
    expect(t.map((r) => r.dedupe_key).sort()).toEqual(["req_1", "req_2"]);
    // req_1 stays with the session that actually paid for it.
    expect(t.find((r) => r.dedupe_key === "req_1")!.agent_id).toBe("orig");
    expect(t.find((r) => r.dedupe_key === "req_2")!.agent_id).toBe("fork");
  });

  test("forked events are skipped too, so prompts and tool calls do not double", () => {
    const d = db();
    const line = (uuid: string, forked: boolean) => JSON.stringify({
      type: "user", uuid, timestamp: "2026-08-19T00:00:00.000Z", sessionId: "s", cwd: "/tmp/p",
      ...(forked && { forkedFrom: { sessionId: "s0", messageUuid: uuid } }),
      message: { role: "user", content: [{ type: "text", text: "do the thing" }] },
    });
    parseFileIncremental(d, write("a.jsonl", [line("p1", false)]), false, null);
    parseFileIncremental(d, write("b.jsonl", [line("p1", true), line("p2", false)]), false, null);
    const prompts = d.query<{ n: number }, []>(
      "SELECT COUNT(*) n FROM events WHERE kind = 'prompt'").get()!;
    expect(prompts.n).toBe(2);
  });
});

describe("bucket attribution", () => {
  test("a call made while a skill is active is a skill call, not a base call", () => {
    const d = db();
    // No Skill tool_use on this line at all — the old classifier would miss it.
    parseFileIncremental(d, write("s.jsonl", [
      assistantLine({ uuid: "u1", requestId: "req_1", messageId: "msg_1",
        ts: "2026-08-19T00:00:00.000Z", attributionSkill: "gate" }),
    ]), false, null);
    const t = turns(d)[0]!;
    expect(t.bucket).toBe(2);
    expect(t.attribution_skill).toBe("gate");
  });

  test("MCP attribution buckets the call as mcp", () => {
    const d = db();
    parseFileIncremental(d, write("m.jsonl", [
      assistantLine({ uuid: "u1", requestId: "req_1", messageId: "msg_1",
        ts: "2026-08-19T00:00:00.000Z", attributionMcpServer: "ai-insights" }),
    ]), false, null);
    const t = turns(d)[0]!;
    expect(t.bucket).toBe(1);
    expect(t.attribution_mcp_server).toBe("ai-insights");
  });

  test("skill attribution outranks an MCP tool_use on the same call", () => {
    const d = db();
    parseFileIncremental(d, write("b.jsonl", [
      assistantLine({ uuid: "u1", requestId: "req_1", messageId: "msg_1",
        ts: "2026-08-19T00:00:00.000Z", attributionSkill: "gate", toolUse: "mcp__x__y" }),
    ]), false, null);
    expect(turns(d)[0]!.bucket).toBe(2);
  });

  test("without attribution it still falls back to the tool_use scan", () => {
    const d = db();
    parseFileIncremental(d, write("f.jsonl", [
      assistantLine({ uuid: "u1", requestId: "req_1", messageId: "msg_1",
        ts: "2026-08-19T00:00:00.000Z", toolUse: "mcp__srv__tool" }),
    ]), false, null);
    const t = turns(d)[0]!;
    expect(t.bucket).toBe(1);
    expect(t.attribution_mcp_server).toBeNull();
  });
});

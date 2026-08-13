#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeFS from "node:fs";

let buffer = "";
let promptCount = 0;
const requestLogPath = process.env.T3_PI_RPC_REQUEST_LOG_PATH;
const exitLogPath = process.env.T3_PI_RPC_EXIT_LOG_PATH;

function recordExit(signal: string) {
  if (exitLogPath) NodeFS.appendFileSync(exitLogPath, `${signal}\n`, "utf8");
  process.exit(0);
}

process.once("SIGINT", () => recordExit("SIGINT"));
process.once("SIGTERM", () => recordExit("SIGTERM"));

function send(message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(request: Record<string, unknown>, data?: unknown) {
  send({
    id: request.id,
    type: "response",
    command: request.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
}

function handle(request: Record<string, unknown>) {
  if (requestLogPath) {
    NodeFS.appendFileSync(requestLogPath, `${JSON.stringify(request)}\n`, "utf8");
  }
  switch (request.type) {
    case "get_state":
      respond(request, {
        sessionId: "mock-pi-session",
        sessionFile: "/tmp/mock-pi-session.jsonl",
        thinkingLevel: "high",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        autoCompactionEnabled: true,
        messageCount: promptCount * 2,
        pendingMessageCount: 0,
      });
      return;
    case "get_entries":
      respond(request, {
        entries: [
          {
            type: "message",
            id: `user-entry-${promptCount}`,
            parentId: null,
            message: { role: "user", content: String(request.message ?? "prompt") },
          },
        ],
        leafId: `leaf-${promptCount}`,
      });
      return;
    case "get_available_models":
      respond(request, { models: [] });
      return;
    case "set_model":
    case "set_thinking_level":
    case "abort":
    case "new_session":
    case "fork":
      respond(
        request,
        request.type === "new_session" || request.type === "fork"
          ? { cancelled: false }
          : undefined,
      );
      return;
    case "prompt": {
      promptCount += 1;
      respond(request);
      send({ type: "agent_start" });
      send({ type: "message_start", message: { role: "assistant", timestamp: promptCount } });
      send({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "considering" },
      });
      send({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "hello from pi" },
      });
      if (process.env.T3_PI_RPC_EMIT_SUBAGENT === "1") {
        send({
          type: "tool_execution_start",
          toolCallId: "spawn-tool",
          toolName: "subagent_spawn",
          args: { name: "reviewer", harness: "codex" },
        });
        send({
          type: "tool_execution_end",
          toolCallId: "spawn-tool",
          toolName: "subagent_spawn",
          result: {
            content: [{ type: "text", text: "Spawned sa-1" }],
            details: { id: "sa-1", title: "reviewer", harness: "codex", model: "gpt-test" },
          },
          isError: false,
        });
      }
      if (process.env.T3_PI_RPC_EMIT_INPUT === "1") {
        send({
          type: "extension_ui_request",
          id: "ui-1",
          method: "input",
          title: "Need a value",
          placeholder: "Type it",
        });
      }
      send({ type: "message_end", message: { role: "assistant", timestamp: promptCount } });
      send({ type: "agent_end", messages: [], willRetry: false });
      send({ type: "agent_settled" });
      if (process.env.T3_PI_RPC_EMIT_SUBAGENT_RESULT === "1") {
        setTimeout(() => {
          const resultMessage = {
            role: "custom",
            customType: "subagent-result",
            content: "review complete",
            details: { id: "sa-1", title: "reviewer", status: "done" },
          };
          send({ type: "message_start", message: resultMessage });
          send({ type: "message_end", message: resultMessage });
          send({ type: "agent_start" });
          send({
            type: "message_start",
            message: { role: "assistant", timestamp: 1000 + promptCount },
          });
          send({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "background result received",
            },
          });
          send({
            type: "message_end",
            message: { role: "assistant", timestamp: 1000 + promptCount },
          });
          send({ type: "agent_end", messages: [], willRetry: false });
          send({ type: "agent_settled" });
        }, 10);
      }
      return;
    }
    case "extension_ui_response":
      return;
    default:
      send({
        id: request.id,
        type: "response",
        command: request.type,
        success: false,
        error: `Unsupported mock command: ${String(request.type)}`,
      });
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) break;
    let line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    handle(JSON.parse(line) as Record<string, unknown>);
  }
});

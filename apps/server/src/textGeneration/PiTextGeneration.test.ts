// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { PiSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import { makePiTextGeneration } from "./PiTextGeneration.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/pi-rpc-mock-agent.ts");
const modelSelection = createModelSelection(ProviderInstanceId.make("pi"), "mock-model");

function shellSingleQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function makeMockPiWrapper(dir: string, env: Readonly<Record<string, string>>) {
  const wrapperPath = NodePath.join(dir, "pi");
  NodeFS.writeFileSync(
    wrapperPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      `exec node ${JSON.stringify(mockAgentPath)} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFile(path: string) {
  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 5_000;
    for (;;) {
      const content = yield* Effect.exit(Effect.sync(() => NodeFS.readFileSync(path, "utf8")));
      if (Exit.isSuccess(content) && content.value.trim()) return content.value;
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* Effect.die(`Timed out waiting for ${path}`);
      }
      yield* Effect.sleep(25);
    }
  });
}

it.layer(NodeServices.layer)("PiTextGeneration", (it) => {
  it.effect("stops the Pi process when structured output decoding fails", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-text-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");
      const wrapper = makeMockPiWrapper(tempDir, {
        T3_PI_RPC_EXIT_LOG_PATH: exitLogPath,
      });
      const textGeneration = yield* makePiTextGeneration(
        decodePiSettings({ piBinaryPath: wrapper }),
      );

      const error = yield* Effect.flip(
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Name this thread",
          modelSelection,
        }),
      );

      expect(error.detail).toMatch(/invalid structured output/i);
      expect(yield* waitForFile(exitLogPath)).toMatch(/SIGTERM|SIGINT/);
    }).pipe(Effect.scoped),
  );
});

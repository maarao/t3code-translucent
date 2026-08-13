import * as NodeServices from "@effect/platform-node/NodeServices";
import { PiSettings } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  parsePiModelList,
} from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

const MODEL_LIST = `provider      model                context  max-out  thinking  images
openai-codex  gpt-5.6-sol          272K     128K     yes       yes
anthropic     claude-sonnet-4-6    200K     64K      no        yes
`;

describe("parsePiModelList", () => {
  it("maps Pi model ids and thinking capabilities", () => {
    const models = parsePiModelList(MODEL_LIST);

    expect(models.map((model) => model.slug)).toEqual([
      "openai-codex/gpt-5.6-sol",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(models[0]?.isDefault).toBe(true);
    expect(models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "reasoning",
      currentValue: "high",
    });
    expect(models[1]?.capabilities?.optionDescriptors).toEqual([]);
  });
});

describe("buildInitialPiProviderSnapshot", () => {
  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(decodePiSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("Checking Pi");
      expect(snapshot.slashCommands).toEqual([
        {
          name: "compact",
          description: "Compact the current Pi context",
          input: { hint: "[instructions]" },
        },
        {
          name: "reload",
          description: "Reload Pi extensions, skills, prompts, themes, and context files",
        },
      ]);
    }),
  );
});

it.layer(NodeServices.layer)("checkPiProviderStatus", (it) => {
  it.effect("requires the Pi executable", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({ piBinaryPath: "/definitely/not/installed/pi" }),
      );

      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("Pi (`pi`)");
    }),
  );

  it.effect("discovers authenticated models from Pi", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-provider-" });
        const piPath = path.join(dir, "pi");
        yield* fs.writeFileString(
          piPath,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then printf "pi 0.84.1\\n"; exit 0; fi',
            'if [ "$1" = "--list-models" ]; then',
            `  cat <<'EOF'`,
            MODEL_LIST.trimEnd(),
            "EOF",
            "  exit 0",
            "fi",
            "exit 2",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(piPath, 0o755);

        const snapshot = yield* checkPiProviderStatus(decodePiSettings({ piBinaryPath: piPath }));

        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.version).toBe("0.84.1");
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "openai-codex/gpt-5.6-sol",
          "anthropic/claude-sonnet-4-6",
        ]);
      }),
    ),
  );
});

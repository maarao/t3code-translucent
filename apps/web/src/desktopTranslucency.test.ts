// @effect-diagnostics nodeBuiltinImport:off - Regression coverage compares shipped desktop CSS.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

describe("desktop translucency", () => {
  it("keeps the mounted main canvas transparent", () => {
    const styles = NodeFS.readFileSync(new URL("./index.css", import.meta.url), "utf8");
    const mainCanvasRule = styles.match(
      /html\.electron \[data-slot="sidebar-inset"\] \{(?<declarations>[^}]*)\}/,
    );

    expect(mainCanvasRule?.groups?.declarations).toMatch(/background-color:\s*transparent;/);
  });
});

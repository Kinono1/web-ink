import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

describe("original note icon packaging", () => {
  it("fails for a missing allowed icon and packages only the seven official local note icons", async () => {
    const directory = await mkdtemp(join(tmpdir(), "web-ink-native-icons-"));
    const source = join(directory, "node_modules/pdfjs-dist");
    const script = resolve("scripts/pdf-assets.mjs");
    const names = ["note", "comment", "key", "help", "newparagraph", "paragraph", "insert"];
    try {
      for (const folder of ["legacy/build", "web/images", "cmaps", "standard_fonts", "wasm", "iccs"])
        await mkdir(join(source, folder), { recursive: true });
      await writeFile(join(source, "legacy/build/pdf.worker.min.mjs"), "// synthetic worker\n");
      await writeFile(join(source, "LICENSE"), "synthetic license\n");
      for (const name of names.slice(0, -1))
        await writeFile(join(source, `web/images/annotation-${name}.svg`), `<svg><title>${name}</title></svg>`);
      await writeFile(join(source, "web/images/unneeded-viewer.svg"), "<svg/>");
      const missing = spawnSync(process.execPath, [script], { cwd: directory, encoding: "utf8" });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("annotation-insert.svg");

      await writeFile(join(source, "web/images/annotation-insert.svg"), "<svg><title>insert</title></svg>");
      const complete = spawnSync(process.execPath, [script], { cwd: directory, encoding: "utf8" });
      expect(complete.status, complete.stderr).toBe(0);
      const target = join(directory, "public/pdfjs/images");
      expect((await readdir(target)).sort()).toEqual(names.map(name => `annotation-${name}.svg`).sort());
      for (const name of names) {
        expect(await readFile(join(target, `annotation-${name}.svg`))).toEqual(
          await readFile(join(source, `web/images/annotation-${name}.svg`)));
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

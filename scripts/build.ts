// scripts/build.ts — `bun run build`: the dashboard bundle at dist/ui/main.js, then the compiled CLI at dist/meddle.
import { join } from "node:path";

const root = join(import.meta.dir, "..");

const ui = await Bun.build({
  entrypoints: [join(root, "src/dashboard/ui/main.tsx")],
  outdir: join(root, "dist/ui"),
  target: "browser",
  format: "esm",
  naming: "main.js",
});
if (!ui.success) {
  for (const log of ui.logs) console.error(log);
  console.error("build: bundling the dashboard UI failed");
  process.exit(1);
}

const compile = Bun.spawnSync([process.execPath, "build", "--compile", "src/cli.ts", "--outfile", "dist/meddle"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (!compile.success) {
  console.error("build: compiling dist/meddle failed");
  process.exit(compile.exitCode || 1);
}

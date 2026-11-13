// scripts/build.ts — `bun run build [--target=bun-<os>-<arch>[-musl] | --all] [--embed-claude]`: the dashboard bundle at
// dist/ui/main.js, then the single binary at dist/meddle (or, with --all, one per platform the pool runs on, at
// dist/meddle-<platform>). It embeds the dashboard, the service unit's template, the build's mark (its build id and
// platform: see src/update/build.ts) and the Claude Code the Agent SDK pins for the target platform (version, SHA-256
// and size, from the SDK's manifest), which a node downloads from the npm registry on first start and verifies.
// --embed-claude embeds Claude Code itself instead, for machines that cannot reach the registry; its platform package
// must be installed (`bun install` brings this machine's; another's with
// `bun add --no-save @anthropic-ai/claude-agent-sdk-<platform>`).
//
// The build id is the jj commit of the working copy (`MEDDLE_BUILD_ID` overrides it), read once, so that every binary
// of one build carries the same id: `meddle update` takes them as one release.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudePin } from "../src/claude-code";
import { buildMark, hashFile } from "../src/update/build";
import { claudePackage } from "./claude-package";

/** The targets `--all` builds: every platform the pool runs on. */
const ALL_TARGETS = ["bun-linux-x64", "bun-linux-arm64"];

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
for (const a of args) {
  if (!a.startsWith("--target=") && a !== "--embed-claude" && a !== "--all") {
    console.error(`build: unknown argument ${a} (--target=bun-<os>-<arch>[-musl], --all, --embed-claude)`);
    process.exit(2);
  }
}
const target = args.find((a) => a.startsWith("--target="))?.slice("--target=".length) ?? null;
const all = args.includes("--all");
if (all && target !== null) {
  console.error("build: give --target or --all, not both");
  process.exit(2);
}
const embedClaude = args.includes("--embed-claude");

/** The jj commit id of the working copy (its first 12 hex digits), or `MEDDLE_BUILD_ID` when set. */
function buildId(): string {
  const given = process.env.MEDDLE_BUILD_ID;
  if (given !== undefined && given !== "") return given;
  // jj snapshots the working copy first, so an edit not yet described still gives the source a commit of its own.
  const jj = Bun.spawnSync(["jj", "log", "-r", "@", "--no-graph", "-T", "commit_id"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const out = jj.stdout.toString().trim();
  if (!jj.success || !/^[0-9a-f]{12,}$/.test(out)) {
    console.error(`build: cannot read the jj commit of the source (${jj.stderr.toString().trim() || out}); set MEDDLE_BUILD_ID`);
    process.exit(1);
  }
  return out.slice(0, 12);
}

const sdkDir = join(root, "node_modules/@anthropic-ai/claude-agent-sdk");
const manifest = JSON.parse(readFileSync(join(sdkDir, "manifest.json"), "utf8")) as {
  version: string;
  platforms: Record<string, { binary: string; checksum: string; size: number }>;
};
const sdkVersion = (JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")) as { version: string }).version;

/** What one binary embeds of Claude Code, and the file it embeds with --embed-claude; exits on what is missing. */
function claudeFor(t: string | null): { pin: ClaudePin; file: string } {
  const claude = claudePackage(t);
  const entryOf = manifest.platforms[claude.platform];
  if (entryOf === undefined) {
    console.error(`build: the Agent SDK's manifest has no Claude Code for ${claude.platform}`);
    process.exit(1);
  }
  const file = join(root, "node_modules", claude.binary);
  if (embedClaude && !existsSync(file)) {
    console.error(`build: ${claude.binary} is not installed; \`bun add --no-save ${claude.name}\` (or npm install --force) first`);
    process.exit(1);
  }
  return { pin: { version: manifest.version, sdkVersion, platform: claude.platform, ...entryOf }, file };
}

const targets: (string | null)[] = all ? ALL_TARGETS : [target];
// Checked before anything is built: --all with --embed-claude needs every platform's package.
const plans = targets.map((t) => ({ target: t, ...claudeFor(t) }));
const id = buildId();

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

mkdirSync(join(root, "dist/build"), { recursive: true });
const q = JSON.stringify;
for (const plan of plans) {
  const { pin } = plan;
  const outfile = all ? `dist/meddle-${pin.platform}` : "dist/meddle";
  // The binary's entry: embeds the files, then runs the CLI. Generated, so that a checkout's CLI imports none of them.
  const entry = join(root, "dist/build", `entry-${pin.platform}.ts`);
  writeFileSync(entry, `// Generated by scripts/build.ts: the single binary's entry.
import { embed } from ${q(join(root, "src/embedded.ts"))};
${embedClaude ? `import claude from ${q(plan.file)} with { type: "file" };` : "const claude = null;"}
import html from ${q(join(root, "src/dashboard/ui/index.html"))} with { type: "text" };
import script from ${q(join(root, "dist/ui/main.js"))} with { type: "text" };
import unit from ${q(join(root, "install/meddle.service"))} with { type: "text" };

// The build's mark, as plain text in the binary: \`meddle update\` reads it from the file without running it.
const build = ${q(buildMark({ buildId: id, platform: pin.platform }))};
embed({ claude, claudeCode: ${q(pin)}, html, script, unit, build });
await import(${q(join(root, "src/cli.ts"))});
`);

  const compileArgs = [process.execPath, "build", "--compile", entry, "--outfile", outfile];
  if (plan.target !== null) compileArgs.push(`--target=${plan.target}`);
  const compile = Bun.spawnSync(compileArgs, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (!compile.success) {
    console.error(`build: compiling ${outfile} failed`);
    process.exit(compile.exitCode || 1);
  }
  const { sha256 } = await hashFile(join(root, outfile));
  console.log(
    `${outfile}: build ${id} for ${pin.platform}, sha256 ${sha256.slice(0, 16)}…, Claude Code ${pin.version} ` +
      (embedClaude ? "embedded" : "downloaded from the npm registry on first start") +
      (plan.target === null ? "" : ` (target ${plan.target})`),
  );
}
if (all) console.log(`roll it out with: meddle update ${plans.map((p) => `dist/meddle-${p.pin.platform}`).join(" ")}`);

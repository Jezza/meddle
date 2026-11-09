// test/context.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config";
import { git } from "../src/jj";
import {
  composeEnv, composeSettings, contextTextAt, DEFAULT_CONTEXT, loadBranchContext, loadProjectSettings, parseContext,
  withTaskRules,
} from "../src/projects/context";
import { initServiceRepo } from "../src/projects/project";
test("parses and composes", () => {
  const c = parseContext(`instructions = "Use cargo nextest."\n[env]\nRUST_LOG = "debug"\n[claude]\nask = ["Bash(git push *)"]\n[claude.autoMode]\nallow = ["Cargo builds"]\n[resources]\nruns = ["cargo"]\n`);
  expect(c.env.RUST_LOG).toBe("debug");
  const s = composeSettings([c]) as any;
  expect(s.autoMode.allow).toEqual(["$defaults", "Cargo builds"]);
  expect(s.permissions.ask).toEqual(["Bash(git push *)"]);
  expect(composeEnv([DEFAULT_CONTEXT, c])).toEqual({ RUST_LOG: "debug" });
});
test("unknown key is named", () => {
  expect(() => parseContext(`[claude]\nallwo = []\n`)).toThrow("unknown key claude.allwo");
});
test("project settings come first, context rules are appended", () => {
  const c = parseContext(`[claude]\nask = ["Bash(git push *)"]\n[claude.autoMode]\nallow = ["Cargo builds"]\n`);
  const s = composeSettings([c], [{ autoMode: { allow: ["Project rule"] }, permissions: { ask: ["Bash(rm *)"] } }]) as any;
  expect(s.autoMode.allow).toEqual(["$defaults", "Project rule", "Cargo builds"]);
  expect(s.permissions.ask).toEqual(["Bash(rm *)", "Bash(git push *)"]);
});
test("project settings are {} without .claude/settings.json", async () => {
  expect(await loadProjectSettings(await mkdtemp("/tmp/ctx-"))).toEqual({});
});
test("without a task, a project's context is its default branch's, read from the service repo with git", async () => {
  const home = await mkdtemp("/tmp/ctx-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  // A folder whose `main` has a context and whose `bare` has none; the service repo fetches both, its working copy empty.
  const folder = `${home}/folder`;
  const g = (...args: string[]) => git(["-c", "user.name=t", "-c", "user.email=t@t", ...args], folder);
  await mkdir(`${folder}/.meddle`, { recursive: true });
  await g("init", "-b", "bare");
  await writeFile(`${folder}/README`, "r\n");
  await g("add", "README");
  await g("commit", "-m", "bare");
  await g("checkout", "-b", "main");
  await writeFile(`${folder}/.meddle/context.toml`, `instructions = "From main."\n`);
  await g("add", ".");
  await g("commit", "-m", "context");
  const repo = `${home}/service`;
  await initServiceRepo(cfg, repo);
  await git(["fetch", folder, "main:refs/heads/main", "bare:refs/heads/bare"], repo, cfg);
  expect((await loadBranchContext(cfg, repo, "main")).instructions).toBe("From main.");
  expect(await loadBranchContext(cfg, repo, "bare")).toEqual(DEFAULT_CONTEXT);
  expect(await loadBranchContext(cfg, repo, "nope")).toEqual(DEFAULT_CONTEXT);
  expect(await loadBranchContext(cfg, repo, null)).toEqual(DEFAULT_CONTEXT);
  // The text a task captures at its start commit: none for a commit without the file, or for jj's root commit.
  const at = async (rev: string) => (await git(["rev-parse", rev], repo, cfg)).trim();
  expect(await contextTextAt(cfg, repo, await at("main"))).toBe(`instructions = "From main."\n`);
  expect(parseContext(await contextTextAt(cfg, repo, await at("main"))).instructions).toBe("From main.");
  expect(await contextTextAt(cfg, repo, await at("bare"))).toBeNull();
  expect(await contextTextAt(cfg, repo, "0".repeat(40))).toBeNull();
  // Any other failure is refused, not taken for the defaults: a commit the repo lacks, or a repo that isn't one.
  await expect(contextTextAt(cfg, repo, "1".repeat(40))).rejects.toThrow("rev-parse");
  await mkdir(`${home}/not-a-repo`);
  await expect(contextTextAt(cfg, `${home}/not-a-repo`, await at("main"))).rejects.toThrow("not a git repository");
  expect(parseContext(null)).toEqual(DEFAULT_CONTEXT);
  // A context that does not parse is refused, as from a workspace.
  await writeFile(`${folder}/.meddle/context.toml`, `[claude]\nallwo = []\n`);
  await g("commit", "-am", "bad");
  await git(["fetch", folder, "+main:refs/heads/main"], repo, cfg);
  await expect(loadBranchContext(cfg, repo, "main")).rejects.toThrow("unknown key claude.allwo");
});

test("a task with a project gets the agent rules after its projects' instructions; one without has none", () => {
  const rules =
    "If jj says a commit is immutable, it isn't yours: leave it. Never pass --ignore-immutable. Only set or delete " +
    "bookmarks under meddle/task/t1/. Never run jj undo or jj op restore: the operation log is shared with other tasks.";
  const own = { ...DEFAULT_CONTEXT, instructions: "Use nextest." };
  const contexts = withTaskRules([own], "t1");
  expect(contexts.map((c) => c.instructions)).toEqual(["Use nextest.", rules]);
  expect(contexts[0]).toBe(own);
  expect({ ...contexts[1]!, instructions: "" }).toEqual(DEFAULT_CONTEXT);
  expect(withTaskRules([], "t1")).toEqual([]);
});

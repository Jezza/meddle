// test/preload.ts — loaded before every test file (bunfig.toml). Every jj a test runs, in this process or in a child
// (`jjEnv` and `childEnv` pass this environment on), reads only test/jj-config.toml instead of the developer's own
// config, and has an author: jj refuses to push a commit without one, and a fresh machine or CI has no user config.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JJ_CONFIG = `${import.meta.dir}/jj-config.toml`;
process.env.JJ_USER = "meddle test";
process.env.JJ_EMAIL = "test@meddle.invalid";

// jj keeps per-repo and per-workspace config under `$XDG_CONFIG_HOME/jj/` (`~/.config/jj/` without it), outside the
// repo: a config dir of this run's own, removed when it ends, so that no test writes into the developer's.
const configHome = mkdtempSync(join(tmpdir(), "meddle-test-config-"));
process.env.XDG_CONFIG_HOME = configHome;
// A preload's `afterAll` runs once, after every test file (bun test does not run `exit` handlers).
afterAll(() => rmSync(configHome, { recursive: true, force: true }));

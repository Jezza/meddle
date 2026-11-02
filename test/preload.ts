// test/preload.ts — loaded before every test file (bunfig.toml). Every jj a test runs, in this process or in a child
// (`jjEnv` and `childEnv` pass this environment on), reads only test/jj-config.toml instead of the developer's own
// config, and has an author: jj refuses to push a commit without one, and a fresh machine or CI has no user config.
process.env.JJ_CONFIG = `${import.meta.dir}/jj-config.toml`;
process.env.JJ_USER = "meddle test";
process.env.JJ_EMAIL = "test@meddle.invalid";

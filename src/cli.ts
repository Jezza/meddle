import { VERSION } from "./version";
import { loadConfig, ensureDataDirs } from "./config";
import { setToken, tokenStatus } from "./token";

const USAGE = "usage: meddle --version | meddle token set [--file <path>] | meddle token status";

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === "--version") {
  console.log(`meddle ${VERSION}`);
  process.exit(0);
}

if (args[0] === "token" && args[1] === "set" && (args.length === 2 || (args.length === 4 && args[2] === "--file"))) {
  try {
    const input = args.length === 4 ? await Bun.file(args[3]!).text() : await Bun.stdin.text();
    const cfg = loadConfig();
    await ensureDataDirs(cfg);
    await setToken(cfg, input);
  } catch (err) {
    console.error(`meddle: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log("token set");
  process.exit(0);
}

if (args.length === 2 && args[0] === "token" && args[1] === "status") {
  const s = await tokenStatus(loadConfig());
  console.log(`present: ${s.present}`);
  if (s.present) {
    console.log(`setAt: ${s.setAt}`);
    console.log(`expiresAt: ${s.expiresAt}`);
  }
  process.exit(0);
}

console.error(USAGE);
process.exit(2);

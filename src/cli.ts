import { VERSION } from "./version";

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === "--version") {
  console.log(`meddle ${VERSION}`);
  process.exit(0);
}

console.error("usage: meddle --version");
process.exit(2);

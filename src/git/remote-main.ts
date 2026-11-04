// `git-remote <remote> [<url>]`: git's remote helper on this process's stdio. Run as its own entry point from a
// checkout (the wrapper `writeHelperWrapper` writes), it loads only the helper and the config, not the whole CLI:
// git starts one for every fetch and push to a peer, and the CLI's imports take a few hundred ms to load.
import { loadConfig } from "../config";
import { paths } from "../paths";
import { runRemoteHelper } from "./helper";

/**
 * git's remote helper for a `meddle://` remote, run by the `git-remote-meddle` wrapper: the protocol on stdio, piped
 * through the git socket `MEDDLE_GIT_SOCKET` (or this node's) names. Resolves with its exit code.
 */
export async function gitRemote(url: string): Promise<number> {
  const writable = (sink: ReturnType<typeof Bun.stdout.writer>) => new WritableStream<Uint8Array>({
    async write(chunk) {
      sink.write(chunk);
      await sink.flush();
    },
    async close() {
      await sink.flush();
    },
  });
  return runRemoteHelper({
    url,
    socketPath: paths(loadConfig()).gitSocket,
    stdin: Bun.stdin.stream(),
    stdout: writable(Bun.stdout.writer()),
    stderr: writable(Bun.stderr.writer()),
  });
}

if (import.meta.main) {
  // git runs a helper as `git-remote-<scheme> <remote> [<url>]`; without a url, the remote is the url.
  const [command, remote, url, ...extra] = process.argv.slice(2);
  if (command !== "git-remote" || remote === undefined || extra.length > 0) {
    console.error("usage: git-remote <remote> [<url>]");
    process.exit(2);
  }
  try {
    process.exit(await gitRemote(url ?? remote));
  } catch (err) {
    console.error(`meddle: ${(err as Error).message}`);
    process.exit(1);
  }
}

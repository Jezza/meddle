// scripts/claude-package.ts — which of the Agent SDK's platform packages carries the Claude Code a build embeds.

/** Whether this machine's libc is musl: glibc answers `getconf GNU_LIBC_VERSION`, musl has no such variable. */
function hostIsMusl(): boolean {
  if (process.platform !== "linux") return false;
  const glibc = Bun.spawnSync(["getconf", "GNU_LIBC_VERSION"], { stdout: "pipe", stderr: "ignore" });
  return !(glibc.success && glibc.stdout.toString().startsWith("glibc"));
}

/**
 * The Agent SDK's platform for a target (its manifest's key), the platform's package,
 * `@anthropic-ai/claude-agent-sdk-<os>-<arch>[-musl]`, and the path of Claude Code in it: named from a Bun compile target (`bun-linux-arm64-musl`; a `-baseline` or `-modern` CPU suffix
 * is ignored), or from this machine when `target` is null.
 */
export function claudePackage(target: string | null, host = { platform: process.platform as string, arch: process.arch as string, musl: hostIsMusl }): { platform: string; name: string; binary: string } {
  let platform: string;
  if (target === null) platform = `${host.platform}-${host.arch}${host.musl() ? "-musl" : ""}`;
  else {
    const m = /^bun-(linux|darwin|windows)-(x64|arm64)(?:-(?:baseline|modern))?(-musl)?(?:-(?:baseline|modern))?$/.exec(target);
    if (m === null) throw new Error(`build: unsupported --target ${target} (bun-<linux|darwin|windows>-<x64|arm64>[-musl])`);
    platform = `${m[1] === "windows" ? "win32" : m[1]}-${m[2]}${m[3] ?? ""}`;
  }
  const name = `@anthropic-ai/claude-agent-sdk-${platform}`;
  return { platform, name, binary: `${name}/${platform.startsWith("win32") ? "claude.exe" : "claude"}` };
}

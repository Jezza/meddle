// test/claude-code.test.ts — the single binary's Claude Code: downloaded from a registry (or taken from the binary),
// unpacked from the platform package's tarball as it arrives, and installed only once its SHA-256 is the pinned one.
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { claudePath, ensureClaude, tarFile, tarballUrl, type ClaudePin } from "../src/claude-code";

const CLAUDE = "#!/bin/sh\necho 9.9.9 '(Claude Code)'\n";

function pinFor(content: string, over: Partial<ClaudePin> = {}): ClaudePin {
  return {
    version: "9.9.9",
    sdkVersion: "0.9.9",
    platform: "linux-x64",
    binary: "claude",
    checksum: createHash("sha256").update(content).digest("hex"),
    size: Buffer.byteLength(content),
    ...over,
  };
}

/** A gzipped tarball of `files` (path under the archive's root to content), in that order, as tar writes it. */
async function tarball(files: Record<string, string>, format: "ustar" | "pax" = "ustar"): Promise<Uint8Array> {
  const dir = await mkdtemp("/tmp/meddle-tgz-");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(`${dir}/src/${path}`.replace(/\/[^/]*$/, ""), { recursive: true });
    await writeFile(`${dir}/src/${path}`, content, { mode: 0o755 });
  }
  const tar = Bun.spawnSync(["tar", `--format=${format}`, "-czf", `${dir}/out.tgz`, "-C", `${dir}/src`, ...Object.keys(files)]);
  if (!tar.success) throw new Error(tar.stderr.toString());
  return new Uint8Array(await Bun.file(`${dir}/out.tgz`).arrayBuffer());
}

/** A registry serving `body` at the pin's tarball path (404 elsewhere), counting requests. */
function registry(pin: ClaudePin, body: Uint8Array | null) {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests++;
      const path = new URL(request.url).pathname;
      return body !== null && path === new URL(tarballUrl(pin, "http://x")).pathname ? new Response(body) : new Response("no", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests: () => requests, stop: () => server.stop(true) };
}

const quiet = { log: () => {} };

test("the tarball is the platform package's on the registry", () => {
  expect(tarballUrl({ platform: "linux-arm64-musl", sdkVersion: "0.3.314" }, "https://registry.npmjs.org")).toBe(
    "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-arm64-musl/-/claude-agent-sdk-linux-arm64-musl-0.3.314.tgz",
  );
});

test("Claude Code is downloaded once, unpacked, verified and installed executable at <data dir>/bin/claude-<version>", async () => {
  const pin = pinFor(CLAUDE);
  const reg = registry(pin, await tarball({ "package/README.md": "readme", "package/claude": CLAUDE, "package/package.json": "{}" }));
  const dataDir = await mkdtemp("/tmp/meddle-claude-");
  const lines: string[] = [];
  try {
    const path = await ensureClaude(pin, dataDir, { registry: reg.url, embedded: null, log: (l) => lines.push(l) });
    expect(path).toBe(`${dataDir}/bin/claude-9.9.9`);
    expect((await stat(path)).mode & 0o777).toBe(0o755);
    expect(Bun.spawnSync([path]).stdout.toString()).toBe("9.9.9 (Claude Code)\n");
    expect(lines).toEqual([
      `meddle: downloading Claude Code 9.9.9 (linux-x64) from ${tarballUrl(pin, reg.url)}`,
      `meddle: Claude Code 9.9.9 installed at ${path} (SHA-256 verified)`,
    ]);
    // Installed: not fetched again.
    expect(await ensureClaude(pin, dataDir, { registry: reg.url, embedded: null, ...quiet })).toBe(path);
    expect(reg.requests()).toBe(1);
  } finally {
    reg.stop();
  }
});

test("a download whose binary is not the pinned one is refused, and leaves nothing behind", async () => {
  const tampered = CLAUDE.replace("9.9.9", "6.6.6");
  for (const [what, pin, files] of [
    ["another checksum", pinFor(CLAUDE), { "package/claude": tampered }],
    ["another size", pinFor(CLAUDE), { "package/claude": `${CLAUDE}# more\n` }],
    ["no binary", pinFor(CLAUDE), { "package/README.md": "readme" }],
  ] as const) {
    const reg = registry(pin, await tarball(files));
    const dataDir = await mkdtemp("/tmp/meddle-claude-");
    try {
      const failed = await ensureClaude(pin, dataDir, { registry: reg.url, embedded: null, ...quiet }).catch((e: Error) => e);
      expect(failed, what).toBeInstanceOf(Error);
      const message = (failed as Error).message;
      expect(message).toStartWith(`cannot download Claude Code 9.9.9 (linux-x64) from ${tarballUrl(pin, reg.url)}: `);
      expect(message).toEndWith("; set MEDDLE_NPM_REGISTRY to a mirror, or use a binary built with --embed-claude");
      if (what === "another checksum") expect(message).toContain(`not the ${pin.checksum} the Agent SDK's manifest gives`);
      if (what === "another size") expect(message).toContain(`more than the ${pin.size} bytes expected`);
      if (what === "no binary") expect(message).toContain("the archive has no package/claude");
      expect(await readdir(`${dataDir}/bin`).catch(() => [])).toEqual([]);
    } finally {
      reg.stop();
    }
  }
});

test("a registry without the package, or none at all, fails with what to do", async () => {
  const pin = pinFor(CLAUDE);
  const reg = registry(pin, null);
  const dataDir = await mkdtemp("/tmp/meddle-claude-");
  try {
    await expect(ensureClaude(pin, dataDir, { registry: reg.url, embedded: null, ...quiet })).rejects.toThrow(": HTTP 404; set MEDDLE_NPM_REGISTRY");
  } finally {
    reg.stop();
  }
  await expect(ensureClaude(pin, dataDir, { registry: "http://127.0.0.1:1", embedded: null, ...quiet })).rejects.toThrow("set MEDDLE_NPM_REGISTRY");
});

test("a file of another size at the install path is replaced; a binary built with --embed-claude installs from itself, verified", async () => {
  const pin = pinFor(CLAUDE);
  const dataDir = await mkdtemp("/tmp/meddle-claude-");
  const inBinary = `${dataDir}/in-binary`;
  await writeFile(inBinary, CLAUDE);
  await mkdir(`${dataDir}/bin`);
  await writeFile(claudePath(pin, dataDir), "short");
  const path = await ensureClaude(pin, dataDir, { registry: "http://127.0.0.1:1", embedded: inBinary, ...quiet });
  expect(await Bun.file(path).text()).toBe(CLAUDE);

  await writeFile(inBinary, CLAUDE.replace("9.9.9", "6.6.6"));
  const other = pinFor(CLAUDE, { version: "9.9.10" });
  await expect(ensureClaude(other, dataDir, { registry: "http://127.0.0.1:1", embedded: inBinary, ...quiet })).rejects.toThrow(
    "cannot install the embedded Claude Code 9.9.10: SHA-256",
  );
  expect(await Bun.file(claudePath(other, dataDir)).exists()).toBe(false);
});

test("the tar reader finds a file past others, by a pax long name too, and across chunk boundaries", async () => {
  const long = `package/${"d".repeat(120)}/claude`;
  const tgz = await tarball({ "package/a": "x".repeat(700), [long]: CLAUDE }, "pax");
  // Fed a byte at a time at first, then in odd sizes: headers and data straddle every boundary.
  const raw = new Uint8Array(await new Response(new Blob([tgz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  const sizes = [1, 1, 1, 7, 13, 511, 2, 1000];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0, i = 0; at < raw.length; i++) {
        const n = sizes[i % sizes.length]!;
        controller.enqueue(raw.slice(at, at + n));
        at += n;
      }
      controller.close();
    },
  });
  const parts: Uint8Array[] = [];
  for await (const piece of tarFile(stream, long)) parts.push(piece.slice());
  expect(new TextDecoder().decode(Buffer.concat(parts))).toBe(CLAUDE);
});

// Names on the git transport: repos (`project/<id>`, `memory/<id>`), `meddle://<nodeId>/<repo>` remote URLs and the
// header of a `git` stream.
import type { StreamHeader } from "../pool/frames";

export type Repo = { kind: "project" | "memory"; id: string };

export type GitService = "upload-pack" | "receive-pack";

/** The header a `git` stream opens with: the repo to serve and the git service to run on it. */
export type GitHeader = { stream: "git"; repo: string; service: GitService };

const REPO = /^(project|memory)\/([A-Za-z0-9_-]+)$/;
const URL = /^meddle:\/\/([0-9a-f]{64})\/(.*)$/;

/** `project/<id>` or `memory/<id>` (an id of letters, digits, `_` and `-`); throws "bad repo name". */
export function parseRepo(text: string): Repo {
  const match = REPO.exec(text);
  if (!match) throw new Error("bad repo name");
  return { kind: match[1] as Repo["kind"], id: match[2]! };
}

export function repoName(repo: Repo): string {
  return `${repo.kind}/${repo.id}`;
}

/** `meddle://<64 lowercase hex>/<repo>`; throws "bad meddle url". */
export function parseMeddleUrl(url: string): { nodeId: string; repo: Repo } {
  const match = URL.exec(url);
  if (!match) throw new Error("bad meddle url");
  try {
    return { nodeId: match[1]!, repo: parseRepo(match[2]!) };
  } catch {
    throw new Error("bad meddle url");
  }
}

export function isGitService(value: unknown): value is GitService {
  return value === "upload-pack" || value === "receive-pack";
}

/** The repo and service of a `git` stream's header; throws "bad git header" for anything else. */
export function parseGitHeader(header: StreamHeader | Record<string, unknown>): { repo: Repo; service: GitService } {
  const { repo, service } = header as { repo?: unknown; service?: unknown };
  if (typeof repo !== "string" || !isGitService(service)) throw new Error("bad git header");
  try {
    return { repo: parseRepo(repo), service };
  } catch {
    throw new Error("bad git header");
  }
}

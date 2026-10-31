import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import Type from "typebox";
import Value from "typebox/value";

export type Context = {
  env: Record<string, string>;
  claude: {
    ask: string[];
    autoMode: { allow: string[]; soft_deny: string[]; hard_deny: string[] };
    mcpServers: Record<string, unknown>;
    skills: string[] | "all" | null;
  };
  instructions: string;
  resources: { memoryMb?: number; runs: string[] };
};

const Rules = Type.Array(Type.String());

export const ContextSchema = Type.Object(
  {
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    claude: Type.Optional(Type.Object(
      {
        ask: Type.Optional(Rules),
        autoMode: Type.Optional(Type.Object(
          { allow: Type.Optional(Rules), soft_deny: Type.Optional(Rules), hard_deny: Type.Optional(Rules) },
          { additionalProperties: false },
        )),
        mcpServers: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        skills: Type.Optional(Type.Union([Rules, Type.Literal("all")])),
      },
      { additionalProperties: false },
    )),
    instructions: Type.Optional(Type.String()),
    resources: Type.Optional(Type.Object(
      { memoryMb: Type.Optional(Type.Number()), runs: Type.Optional(Rules) },
      { additionalProperties: false },
    )),
  },
  { additionalProperties: false },
);

type ContextToml = Type.Static<typeof ContextSchema>;

function fill(toml: ContextToml): Context {
  const resources: Context["resources"] = { runs: toml.resources?.runs ?? [] };
  if (toml.resources?.memoryMb !== undefined) resources.memoryMb = toml.resources.memoryMb;
  return {
    env: { ...toml.env },
    claude: {
      ask: toml.claude?.ask ?? [],
      autoMode: {
        allow: toml.claude?.autoMode?.allow ?? [],
        soft_deny: toml.claude?.autoMode?.soft_deny ?? [],
        hard_deny: toml.claude?.autoMode?.hard_deny ?? [],
      },
      mcpServers: { ...toml.claude?.mcpServers },
      skills: toml.claude?.skills ?? null,
    },
    instructions: toml.instructions ?? "",
    resources,
  };
}

export const DEFAULT_CONTEXT: Context = fill({});

function dotted(pointer: string): string {
  const parts = pointer.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  return parts.length === 0 ? "(root)" : parts.join(".");
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function loadContext(replicaPath: string): Promise<Context> {
  const text = await readOptional(join(replicaPath, ".meddle", "context.toml"));
  if (text === null) return fill({});
  const data = parse(text);
  if (Value.Check(ContextSchema, data)) return fill(data);
  const errors = Value.Errors(ContextSchema, data);
  const unknown = errors.find((e) => e.keyword === "additionalProperties");
  if (unknown) {
    const key = (unknown.params as { additionalProperties: string[] }).additionalProperties[0];
    throw new Error(`context.toml: unknown key ${dotted(`${unknown.instancePath}/${key}`)}`);
  }
  const first = errors[0];
  throw new Error(`context.toml: ${dotted(first.instancePath)}: ${first.message}`);
}

export async function loadProjectSettings(replica: string): Promise<Record<string, unknown>> {
  const text = await readOptional(join(replica, ".claude", "settings.json"));
  return text === null ? {} : JSON.parse(text);
}

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] = isPlainObject(out[key]) && isPlainObject(value) ? deepMerge(out[key] as Json, value) : structuredClone(value);
  }
  return out;
}

function dedupe(items: unknown[]): unknown[] {
  return [...new Set(items)];
}

function listAt(obj: unknown, key: string): unknown[] {
  return isPlainObject(obj) && Array.isArray(obj[key]) ? obj[key] : [];
}

export function composeSettings(contexts: Context[], projectSettings: Json[] = []): Json {
  const settings = projectSettings.reduce<Json>((acc, s) => deepMerge(acc, s), {});
  // Claude Code unions `autoMode` lists across setting scopes and expands `$defaults` in place, so these lists add to
  // the defaults and to the user's own rules (verified with `claude auto-mode config`, Claude Code 2.1.314, 2026-10-31).
  const autoMode: Json = isPlainObject(settings.autoMode) ? settings.autoMode : {};
  for (const key of ["allow", "soft_deny", "hard_deny"] as const) {
    autoMode[key] = dedupe(["$defaults", ...listAt(autoMode, key), ...contexts.flatMap((c) => c.claude.autoMode[key])]);
  }
  settings.autoMode = autoMode;
  const ask = dedupe([...listAt(settings.permissions, "ask"), ...contexts.flatMap((c) => c.claude.ask)]);
  if (ask.length > 0) settings.permissions = { ...(isPlainObject(settings.permissions) ? settings.permissions : {}), ask };
  return settings;
}

export function composeEnv(contexts: Context[]): Record<string, string> {
  return Object.assign({}, ...contexts.map((c) => c.env));
}

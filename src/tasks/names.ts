// src/tasks/names.ts — a new task's title when it is given none: two adjectives and a noun at first, then, with a
// prompt, the title a model gives it (else its first line).
import { randomInt } from "node:crypto";

const ADJECTIVES = [
  "amber", "ancient", "autumn", "bold", "brave", "bright", "brisk", "calm", "clever", "cosmic", "crimson", "curious",
  "dapper", "dusty", "eager", "early", "fancy", "fierce", "fluffy", "gentle", "gilded", "glad", "golden", "grand",
  "happy", "hidden", "humble", "icy", "jolly", "keen", "kind", "lively", "lucky", "mellow", "merry", "misty", "nimble",
  "noble", "patient", "plucky", "polite", "proud", "quick", "quiet", "rapid", "restless", "rosy", "rustic", "shy",
  "silent", "silver", "sleepy", "sly", "snowy", "spry", "steady", "stormy", "sunny", "swift", "tidy", "tiny", "velvet",
  "vivid", "wandering", "warm", "wild", "wise", "witty", "young", "zesty",
];

const NOUNS = [
  "badger", "beacon", "bear", "beetle", "bison", "cedar", "comet", "coyote", "crane", "falcon", "fern", "finch", "fox",
  "gecko", "glacier", "harbor", "hare", "hedgehog", "heron", "ibis", "lantern", "lark", "lemur", "lynx", "maple",
  "marmot", "meadow", "meteor", "moose", "moth", "newt", "nova", "oak", "orca", "osprey", "otter", "owl", "panda",
  "pebble", "pelican", "pine", "puffin", "quail", "raven", "reef", "river", "robin", "salmon", "sparrow", "spruce",
  "squid", "starling", "stoat", "summit", "tapir", "thistle", "tiger", "toucan", "tundra", "turtle", "valley", "walrus",
  "willow", "wombat", "wren", "yak", "zebra",
];

const pick = (words: readonly string[], rand: (n: number) => number) => words[rand(words.length)]!;

/** Two different adjectives and a noun, such as `quiet amber otter`; `rand(n)` picks an index below n. */
export function taskName(rand: (n: number) => number = randomInt): string {
  const first = pick(ADJECTIVES, rand);
  let second = pick(ADJECTIVES, rand);
  while (second === first) second = pick(ADJECTIVES, rand);
  return `${first} ${second} ${pick(NOUNS, rand)}`;
}

/** How many characters a task's title takes at most when it is given none. */
const TITLE_CHARS = 60;

/** At most `TITLE_CHARS` characters of `s`. */
const clip = (s: string) => Array.from(s).slice(0, TITLE_CHARS).join("");

/** A title wrapped in quotes, backticks or markdown emphasis: group 1 is what is inside. */
const WRAPPED = /^["'`*_“‘](.*)["'`*_”’]$/;

/**
 * What a model's reply makes of a title: its first non-blank line, without the markdown heading marks, `Title:` label,
 * wrapping quotes or trailing full stop a model may add anyway, at most `TITLE_CHARS` characters; null when nothing is
 * left.
 */
export function cleanTitle(reply: string | null | undefined): string | null {
  let line = reply?.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  line = line.replace(/^#+\s*/, "").replace(/^title\s*:\s*/i, "").trim();
  for (let m = WRAPPED.exec(line); m !== null; m = WRAPPED.exec(line)) line = m[1]!.trim();
  line = line.replace(/\.$/, "").trim();
  return line === "" ? null : clip(line);
}

/** A new task's title as it is created: `title` when it has one (not blank), else two adjectives and a noun (`taskName`). */
export function initialTitle(title: string | null | undefined): string {
  return title != null && title.trim() !== "" ? title : taskName();
}

/**
 * The title a task's first prompt gives it (in place of the name `initialTitle` made up): what `ask` (a model asked to
 * name the prompt, see `askTitle`) answers, cleaned (`cleanTitle`), or when it answers nothing usable or throws, the
 * first `TITLE_CHARS` characters of the prompt's first line; null for a blank prompt.
 */
export async function promptTitle(prompt: string, ask?: (prompt: string) => Promise<string | null>): Promise<string | null> {
  const text = prompt.trim();
  if (text === "") return null;
  if (ask !== undefined) {
    const asked = cleanTitle(await ask(text).catch(() => null));
    if (asked !== null) return asked;
  }
  return clip(text.split("\n")[0]!.trim());
}

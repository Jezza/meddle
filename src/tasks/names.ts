// src/tasks/names.ts — a new task's title when it is given none: from its prompt, or two adjectives and a noun.
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

/** How many characters of a prompt's first line a task's title takes when it is given none. */
const TITLE_CHARS = 60;

/**
 * A new task's title: `title` when it has one (not blank); else the first `TITLE_CHARS` characters of the prompt's
 * first line; else, with no prompt either, two adjectives and a noun (`taskName`).
 */
export function taskTitle(title: string | null | undefined, prompt: string | null | undefined): string {
  if (title != null && title.trim() !== "") return title;
  const first = prompt?.trim().split("\n")[0]!.trim() ?? "";
  return first === "" ? taskName() : Array.from(first).slice(0, TITLE_CHARS).join("");
}

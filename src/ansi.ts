// src/ansi.ts — colour on the CLI's output: on a terminal, unless NO_COLOR; always with FORCE_COLOR.

/** Whether output written to `stream` is coloured: on a terminal, unless NO_COLOR is set; always when FORCE_COLOR is. */
export function wantsColour(stream: { isTTY?: boolean }, env: Record<string, string | undefined> = process.env): boolean {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return stream.isTTY === true && env.TERM !== "dumb";
}

/** An SGR style, ended by its own reset (not a full one), so a span inside another keeps the outer style. */
export const sgr = (on: string, off: string) => (s: string) => `\x1b[${on}m${s}\x1b[${off}m`;

const PREFIX = sgr("1;35", "22;39");

/**
 * An id as printed (`shown`, the id or the start of it), its first `prefix` characters (the unique prefix,
 * `uniquePrefixLengths`) in bold magenta when `colour`, as jj prints change ids. Plain, it is `shown` unchanged.
 */
export function highlightId(shown: string, prefix: number, colour: boolean): string {
  if (!colour) return shown;
  const n = Math.max(1, Math.min(prefix, shown.length));
  return PREFIX(shown.slice(0, n)) + shown.slice(n);
}

/** Named styles, each the identity when colour is off. */
export function palette(colour: boolean) {
  const on = (style: (s: string) => string) => (colour ? style : (s: string) => s);
  return {
    bold: on(sgr("1", "22")),
    green: on(sgr("32", "39")),
    yellow: on(sgr("33", "39")),
    red: on(sgr("31", "39")),
    cyan: on(sgr("36", "39")),
    /** This node's marker, `@`, as jj marks the working copy. */
    self: on(sgr("1;32", "22;39")),
  };
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** How many columns `s` takes on a terminal: its length without ANSI escapes. */
export function visibleLength(s: string): number {
  return Array.from(s.replace(ANSI, "")).length;
}

/**
 * Rows laid out in columns two spaces apart, each padded to its widest cell (by visible width, so coloured cells
 * line up), the last column unpadded; the header bold when `colour`.
 */
export function table(header: readonly string[], rows: readonly (readonly string[])[], colour: boolean): string[] {
  const all = [header.map((h) => (colour ? sgr("1", "22")(h) : h)), ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => visibleLength(r[i] ?? ""))));
  return all.map((r) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell + " ".repeat(widths[i]! - visibleLength(cell))))
      .join("  ")
      .trimEnd(),
  );
}

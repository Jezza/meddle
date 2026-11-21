// A usage meter (`usage-model.ts`): its label, a short bar, its text, and where there is room its note.
import type { Meter } from "./usage-model";

/** One meter; `wide` adds its note (`resets 14:30`). No bar while the whole is not known. */
export function UsageMeter({ meter, wide, class: cls }: { meter: Meter; wide?: boolean; class?: string }) {
  const classes = ["usage-meter", `level-${meter.level}`, meter.faded ? "faded" : "", cls ?? ""].filter((c) => c !== "").join(" ");
  return (
    <span class={classes} title={meter.title}>
      <span class="usage-k">{meter.label}</span>
      {!Number.isNaN(meter.fraction) && <span class="meter"><i style={{ width: `${Math.round(meter.fraction * 100)}%` }} /></span>}
      <span class="usage-v">{meter.text}</span>
      {wide === true && meter.note !== null && <span class="muted usage-note">{meter.note}</span>}
    </span>
  );
}

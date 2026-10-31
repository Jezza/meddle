// chord references and state members as Preact hooks.
import { useEffect, useState } from "preact/hooks";
import type { AnyContract, Host, InputOf, Readable, Ref } from "@earendil-works/chord";

/** The current value of a state member, re-rendering on every new one. */
export function useValue<T>(readable: Readable<T>): T {
  const [, tick] = useState(0);
  useEffect(() => readable.subscribe(() => tick((n) => n + 1)), [readable]);
  return readable.value;
}

/** A reference held while the component is mounted (and released after), or why it could not be had. */
export function useObject<C extends AnyContract>(host: Host, contract: C, input: InputOf<C>): { ref?: Ref<C>; error?: string } {
  const key = JSON.stringify(input);
  const [state, setState] = useState<{ ref?: Ref<C>; error?: string }>({});
  useEffect(() => {
    let live = true;
    let held: { release(): void } | undefined;
    setState({});
    host.get(contract, input).then(
      (ref) => {
        const releasable = ref as unknown as { release(): void };
        if (!live) return releasable.release();
        held = releasable;
        setState({ ref });
      },
      (err: unknown) => { if (live) setState({ error: errorText(err) }); },
    );
    return () => {
      live = false;
      held?.release();
    };
  }, [host, contract, key]);
  return state;
}

/** Runs a method call, remembering whether one is in flight and its error. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

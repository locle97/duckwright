import type { Action, WebState } from "./store.ts";
import { Button } from "./ui.tsx";

/** The global options as chips; the value shown is the effective one (an override, else the default). */
export function OptionsStrip(p: { state: WebState; dispatch(a: Action): void }) {
  const g = p.state.globals;
  if (!g) return <div className="options-strip">…</div>;
  const o = g.overrides;
  const eff = { ...g.base, ...o };
  const open = () => p.dispatch({ type: "dialog", value: { kind: "options", taskId: null } });
  const chip = (label: string, value: string, overridden: boolean) => (
    <Button key={label} small className="chip" onClick={open} title={overridden ? "Changed from the default" : "Default"}>
      {label}: {value}{overridden ? " ✱" : ""}
    </Button>
  );
  return (
    <div className="options-strip" aria-label="Global options">
      <span>Options</span>
      {chip("model", eff.model, o.model !== undefined)}
      {chip("max steps", String(eff.maxSteps), o.maxSteps !== undefined)}
      {chip("headed", eff.headed ? "on" : "off", o.headed !== undefined)}
      {chip("snapshot", eff.snapshot, o.snapshot !== undefined)}
    </div>
  );
}

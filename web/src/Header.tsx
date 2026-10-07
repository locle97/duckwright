import { liveCount, totalCost } from "./store.ts";
import type { WebState } from "./store.ts";
import { Button } from "./ui.tsx";

export function Header(p: { state: WebState; onHelp(): void; onQuit(): void; onDrawer(): void }) {
  const s = p.state;
  return (
    <header className="header">
      <Button small className="drawer-toggle" onClick={p.onDrawer} title="Tasks">☰</Button>
      <span>🦆 Duckwright</span>
      <span className="status">
        {liveCount(s)}/{s.maxParallel} running · ${totalCost(s).toFixed(4)}
      </span>
      <Button small onClick={p.onHelp} title="Keyboard shortcuts (?)">?</Button>
      <Button small kind="red" onClick={p.onQuit} title="Stop every run and shut the server down">Quit</Button>
    </header>
  );
}

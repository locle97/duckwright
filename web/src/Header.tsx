import { liveCount, totalCost } from "./store.ts";
import type { WebState } from "./store.ts";
import { Button } from "./ui.tsx";

export function Header(p: { state: WebState; onHelp(): void; onEnvironments(): void; onView(v: "workspace" | "chat"): void; onQuit(): void; onDrawer(): void }) {
  const s = p.state;
  return (
    <header className="header">
      <Button small className="drawer-toggle" onClick={p.onDrawer} title="Tasks">☰</Button>
      <span>🦆 Duckwright</span>
      <div className="tabs view-toggle" role="group" aria-label="View">
        <button type="button" className={`tab ${s.view === "workspace" ? "active" : ""}`} aria-pressed={s.view === "workspace"} onClick={() => p.onView("workspace")}>Workspace</button>
        <button type="button" className={`tab ${s.view === "chat" ? "active" : ""}`} aria-pressed={s.view === "chat"} onClick={() => p.onView("chat")}>Chat</button>
      </div>
      <span className="status">
        {liveCount(s)}/{s.maxParallel} running · ${totalCost(s).toFixed(4)}
      </span>
      <Button small onClick={p.onEnvironments} title="Environments and accounts (v)">Environments</Button>
      <Button small onClick={p.onHelp} title="Keyboard shortcuts (?)">?</Button>
      <Button small kind="red" onClick={p.onQuit} title="Stop every run and shut the server down">Quit</Button>
    </header>
  );
}

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import type { TaskState } from "../../src/runs/manager.ts";
import { clean } from "./clean.ts";
import { isTopModal, popModal, pushModal } from "./modalStack.ts";
import type { Toast } from "./store.ts";

type Tone = "idle" | "run" | "paused" | "pass" | "fail" | "stop" | "warn" | "ask";

export function Button(p: {
  children: ReactNode; onClick?: () => void; kind?: "default" | "blue" | "red" | "green" | "pink"; disabled?: boolean;
  title?: string; small?: boolean; type?: "button" | "submit"; className?: string;
}) {
  const cls = ["btn", p.kind && p.kind !== "default" ? p.kind : "", p.small ? "small" : "", p.className ?? ""].filter(Boolean).join(" ");
  return (
    <button type={p.type ?? "button"} className={cls} onClick={p.onClick} disabled={p.disabled} title={p.title}>
      {p.children}
    </button>
  );
}

export function Tag(p: { children: ReactNode; tone?: Tone }) {
  return <span className={`tag ${p.tone ?? ""}`}>{p.children}</span>;
}

export const STATE_TAG: Record<TaskState, { label: string; tone: Tone }> = {
  idle: { label: "idle", tone: "idle" },
  running: { label: "run", tone: "run" },
  paused: { label: "paused", tone: "paused" },
  passed: { label: "pass", tone: "pass" },
  failed: { label: "fail", tone: "fail" },
  stopping: { label: "stopping", tone: "stop" },
  stopped: { label: "stopped", tone: "stop" },
};

export function Modal(p: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
  /** A mousedown on the backdrop closes the modal (default true). */
  dismissOnBackdrop?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>("input, textarea, select, button.autofocus, .modal-body button");
    first?.focus();
  }, []);
  const onClose = useRef(p.onClose);
  onClose.current = p.onClose;
  useEffect(() => {
    const id = pushModal();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && isTopModal(id)) {
        e.stopPropagation();
        onClose.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      popModal(id);
    };
  }, []);
  return (
    <div className="backdrop" onMouseDown={(e) => { if (p.dismissOnBackdrop !== false && e.target === e.currentTarget) p.onClose(); }}>
      <div className={`modal ${p.wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={p.title} ref={ref}>
        <div className="modal-title">
          <span>{clean(p.title)}</span>
          <Button small onClick={p.onClose} title="Close (Esc)">✕</Button>
        </div>
        <div className="modal-body">{p.children}</div>
        {p.footer ? <div className="modal-foot">{p.footer}</div> : null}
      </div>
    </div>
  );
}

export function Toasts(p: { toasts: Toast[] }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {p.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>{clean(t.message)}</div>
      ))}
    </div>
  );
}

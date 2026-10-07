// Opens the event stream. The server sends the whole state as its first message after every
// (re)connect, so a dropped connection heals itself: EventSource reconnects, the state replaces
// what the page knew, and events follow in order.
import { useEffect } from "react";

import type { Action, StreamMessage } from "./store.ts";

export function useServer(dispatch: (a: Action) => void): void {
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onopen = () => dispatch({ type: "connection", connected: true });
    source.onerror = () => {
      dispatch({ type: "connection", connected: false });
      // An event stream cannot say why it failed: ask for the state to tell a dead token from a down server.
      void fetch("/api/state").then((r) => { if (r.status === 401) dispatch({ type: "expired" }); }, () => {});
    };
    source.onmessage = (ev) => {
      try {
        dispatch({ type: "stream", message: JSON.parse(ev.data) as StreamMessage, now: Date.now() });
      } catch {
        // A message that does not parse is dropped; the next state message resyncs.
      }
    };
    const tick = setInterval(() => dispatch({ type: "tick", now: Date.now() }), 500);
    return () => {
      source.close();
      clearInterval(tick);
    };
  }, [dispatch]);
}

export const EXPLORE_MAX_STEPS = 40;

export function exploreTask(url: string): string {
  const u = new URL(url);
  const URL_ = u.href;
  const HOST = u.host;
  return `Explore the website at ${URL_} like a curious first-time visitor. There is no fixed goal: find the site's main user flows and check whether they work.

Rules:
- Start with goto ${URL_}.
- Stay on the host ${HOST}. Do not open links to other hosts; mention them in a flow's notes instead.
- Follow navigation menus, links, buttons and forms. Try each distinct flow once and do not revisit pages you have already checked.
- Never do anything destructive or irreversible: do not delete, pay, buy, order, send messages, invite people, change passwords or settings, sign out, or submit a form that creates or changes real data. Search and filter forms are fine to submit.
- Do not log in or sign up unless the environment context gives you a test account for it.
- You do not need expect checks in this task.
- Judge each flow: "ok" when it reaches the page or result it promises; "dead-end" when it leads nowhere useful (no way forward, an empty page, a link back to the same page, a form that does nothing); "broken" when it shows an error (a 404 or 500 page, an error message, a control that fails).
- Watch the step budget shown as Step N/M. When you are within 3 steps of the limit, or have explored enough, finish.

Finish with done success, and set args[1] to one JSON object and nothing else, like:
{"flows":[{"title":"Search products","start_url":"https://shop.example/","steps":["Type 'mug' into the search box","Press Enter"],"expected":"A results list with at least one product","status":"ok","notes":""}]}
Each flow has: title (a short name), start_url (the full URL where the flow starts), steps (what a person does, in order, in plain words), expected (what shows the flow worked, or should have), status ("ok", "dead-end" or "broken"), and notes (what went wrong, or ""). List every flow you tried. Use done failure only if the site cannot be opened at all.`;
}

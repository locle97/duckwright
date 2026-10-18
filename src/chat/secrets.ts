// What a chat transcript must never hold besides what redactText finds: every environment account's
// password and TOTP secret, and DUCKWRIGHT_TOTP_SECRET, masked as run files mask them.
import { AccountStore } from "../accounts/store.ts";
import { Scrubber, secretMarker } from "../scrub.ts";
import { SECRET_ENV } from "../twofa.ts";

/** A fresh scrubber over the project's secrets now. An unreadable account database masks nothing from it. */
export function projectScrubber(root: string, env: Record<string, string | undefined> = process.env): Scrubber {
  const s = new Scrubber();
  const totp = env[SECRET_ENV];
  if (totp !== undefined) s.addSecret(totp);
  let store: AccountStore | null = null;
  try {
    store = AccountStore.open(root, { create: false });
    for (const a of store?.allAccounts() ?? []) {
      // A short password never mangles a placeholder the agent writes into a task.
      s.addProtected(`{{${a.id}.username}}`);
      s.addProtected(`{{${a.id}.password}}`);
      s.addNamedSecret(a.password, secretMarker(a.id));
      if (a.totpSecret) s.addSecret(a.totpSecret);
    }
  } catch {
    // the environments page reports a broken database; the chat still works
  } finally {
    store?.close();
  }
  return s;
}

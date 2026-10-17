/** Pure helpers for the environment setting; no Node imports, this ships in the browser bundle. */

export const envValue = (env: string | null): string => env ?? "none";

/** The select value for an overrides object: "" inherits, "none" disables, else the name. */
export const envDraft = (o: { env?: string | null }): string => (o.env === undefined ? "" : o.env === null ? "none" : o.env);

export const envBody = (draft: string): { env?: string | null } =>
  draft === "" ? {} : draft === "none" ? { env: null } : { env: draft };

export function envOptions(
  inherited: string | null,
  environments: readonly string[],
  draft: string,
): { value: string; label: string }[] {
  const out = [
    { value: "", label: `inherit (${inherited ?? "none"})` },
    { value: "none", label: "none" },
    ...environments.map((n) => ({ value: n, label: n })),
  ];
  if (draft !== "" && draft !== "none" && !environments.includes(draft)) out.push({ value: draft, label: draft });
  return out;
}

/** The account form's fields. Secrets always start empty: the server never sends one back. */
export interface AccountDraft {
  id: string; label: string; role: string; username: string; password: string; totpSecret: string; clearTotp: boolean;
}

/** The PUT body for an account. An empty secret is left out (the server keeps it); clearTotp sends null. */
export function accountBody(d: AccountDraft): Record<string, unknown> {
  const b: Record<string, unknown> = { label: d.label, role: d.role, username: d.username };
  if (d.password !== "") b.password = d.password;
  if (d.clearTotp) b.totpSecret = null;
  else if (d.totpSecret !== "") b.totpSecret = d.totpSecret;
  return b;
}

export const shortPasswordWarning = (pw: string): string | null =>
  pw !== "" && pw.length < 8 ? "This password is shorter than 8 characters." : null;

/** Why a new account's id cannot be added (it would overwrite one in the list), or null. */
export const duplicateAccountWarning = (id: string, existing: readonly string[], editing: boolean): string | null =>
  !editing && id !== "" && existing.includes(id) ? `An account ${id} already exists; edit it instead.` : null;

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

// Codex CLI as a magpie agent.
//
// magpie writes an agent's model and connection keys itself, but only into
// JSON, YAML or ENV files: Codex CLI's config.toml is TOML, which magpie's
// agent support refuses ("agent.format %q: json, yaml or env"). So magpie
// writes a small ENV file it can own, back up and restore, and `codex-magpie`
// converts that file into what Codex CLI actually reads (-c overrides, or
// config.toml with a journal for restore). See lib/codex.mjs.
const ICON =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%20width%3D%2264%22%20height%3D%2264%22%3E%20%3Cdefs%3E%20%3ClinearGradient%20id%3D%22bg%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%220%22%20y2%3D%221%22%3E%20%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23242B36%22%2F%3E%20%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23141922%22%2F%3E%20%3C%2FlinearGradient%3E%20%3C%2Fdefs%3E%20%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22url(%23bg)%22%2F%3E%20%3Crect%20x%3D%220.75%22%20y%3D%220.75%22%20width%3D%2262.5%22%20height%3D%2262.5%22%20rx%3D%2213.25%22%20fill%3D%22none%22%20stroke%3D%22%2339414F%22%20stroke-width%3D%221.5%22%2F%3E%20%3Cpath%20d%3D%22M21%2023%20L30%2032%20L21%2041%22%20fill%3D%22none%22%20stroke%3D%22%23E6EDF3%22%20stroke-width%3D%225%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%20%3Cpath%20d%3D%22M35%2041%20H45%22%20fill%3D%22none%22%20stroke%3D%22%237EE787%22%20stroke-width%3D%225%22%20stroke-linecap%3D%22round%22%2F%3E%20%3C%2Fsvg%3E"

export const agent = {
  id: "codex-cli",
  name: "Codex CLI",
  // terminal prompt mark, inlined so it works offline
  icon: ICON,
  bin: "codex",
  config: "~/.codex/magpie-codex-cli.env",
  // the key magpie fills with the chosen model, e.g. auto/hy3
  model: "CODEX_MODEL",
  ua: ["codex"],
  notice:
    "Run `codex-magpie` instead of `codex` to use magpie's model in the console. " +
    "`codex-magpie install` also writes config.toml (with a backup you can restore).",
}

// Extra keys magpie writes beside the model. They are the source of truth the
// launcher converts from, so the gateway address and key never need to be
// copied into TOML by hand.
export function connect({ gateway } = {}) {
  // Only write values that exist: a missing gateway must leave the keys out
  // (magpie then reports "not connected") instead of writing the string
  // "undefined", which readSelection would happily accept as a base URL.
  const out = {}
  if (gateway && typeof gateway.v1 === "string" && gateway.v1.trim()) out.CODEX_BASE_URL = gateway.v1
  if (gateway && typeof gateway.key === "string" && gateway.key.trim()) out.CODEX_API_KEY = gateway.key
  return out
}

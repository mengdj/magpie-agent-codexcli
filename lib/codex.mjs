// The conversion layer: magpie's env file -> what Codex CLI reads.
//
// magpie owns `~/.codex/magpie-codex-cli.env` and rewrites it whenever the
// model changes, back it up and restores it when the row is switched off. It
// cannot own config.toml, so this module does the TOML side:
//
//   * `codex-magpie` (dynamic)  passes -c overrides and changes nothing on disk
//   * `codex-magpie install`    writes config.toml, journaling what it touched
//   * `codex-magpie restore`    puts every journaled key back

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parse, setKey, getKey, delKey, rawLine, putRawLine, hasTable } from "./toml.mjs"

export const ENV_FILE = "magpie-codex-cli.env"
export const JOURNAL_FILE = "magpie-codex-cli.journal.json"
export const CATALOG_FILE = "magpie-models.json"
export const STATE_FILE = "magpie-codex-cli.state.json"

/** ~/.codex, honouring CODEX_HOME the way Codex CLI does. */
export function codexHome() {
  const fromEnv = process.env.CODEX_HOME
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return path.join(os.homedir(), ".codex")
}

export function envPath() {
  return path.join(codexHome(), ENV_FILE)
}

export function configPath() {
  return path.join(codexHome(), "config.toml")
}

export function journalPath() {
  return path.join(codexHome(), JOURNAL_FILE)
}

export function statePath() {
  return path.join(codexHome(), STATE_FILE)
}

/**
 * What we last launched with, and where config.toml's `model` stood at that
 * moment. This is how we tell "the user changed it in the TUI" apart from
 * "another writer (magpie's built-in Codex row) changed it" — a file's mtime
 * cannot, because three programs write the same path.
 */
function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), "utf8"))
    if (s && typeof s === "object") return s
  } catch {}
  return null
}

function writeState(next) {
  writeText(statePath(), JSON.stringify(next, null, 2) + "\n")
}

/**
 * magpie writes its model catalog here (context windows, reasoning levels…).
 * Without it Codex falls back to generic metadata for magpie's model ids.
 */
export function catalogPath() {
  const file = path.join(codexHome(), CATALOG_FILE)
  try {
    return fs.statSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

/** Parse a KEY=VALUE file magpie wrote. Unknown keys are kept. */
export function parseEnv(text) {
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * Read what magpie chose. Returns null when magpie has not connected Codex CLI
 * (no model chosen, or the row is off).
 */
export function readSelection() {
  const file = envPath()
  let text
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
  const env = parseEnv(text)
  const model = (env.CODEX_MODEL || "").trim()
  const base = (env.CODEX_BASE_URL || "").trim()
  const key = (env.CODEX_API_KEY || "").trim()
  if (!model || !base || !key) return null
  return { model, base, key, env, file }
}

/**
 * The config.toml keys this agent owns.
 *
 * Codex CLI keys its provider settings by a provider id; we use `magpie` to
 * match what magpie's built-in Codex support already writes, so switching
 * between the two does not fight over a second block.
 */
export function ownedKeys(sel) {
  return [
    ["model_provider", "magpie"],
    ["model", sel.model],
    [`model_providers.magpie.name`, "magpie"],
    [`model_providers.magpie.base_url`, sel.base],
    [`model_providers.magpie.wire_api`, "responses"],
    [`model_providers.magpie.experimental_bearer_token`, sel.key],
  ]
}

/**
 * The same settings as `-c key=value` arguments, which take precedence over
 * config.toml, so a wrapper run never edits the user's file.
 */
export function toCLIArgs(sel) {
  const args = []
  for (const [key, value] of ownedKeys(sel)) {
    args.push("-c", `${key}=${JSON.stringify(value)}`)
  }
  const catalog = catalogPath()
  if (catalog) args.push("-c", `model_catalog_json=${JSON.stringify(catalog)}`)
  return args
}

/**
 * Resolve which model to actually launch with.
 *
 * Three programs write the same `~/.codex/config.toml`:
 *
 *   1. this plugin's `install`      (the 6 keys we own)
 *   2. magpie's built-in Codex row  (model / model_reasoning_effort / …)
 *   3. the user, inside Codex's TUI via `/model`
 *
 * So a file's mtime cannot tell us who chose a model: magpie's *other* row
 * rewrote the file, and taking that as "the user just picked this in the TUI"
 * silently threw away the model chosen on our own Agents row. That is the
 * "some models don't take effect" symptom.
 *
 * What we can rely on is history: we remember the model we launched with and
 * what config.toml said right after that launch. If config.toml still says
 * that, nobody has chosen anything since — magpie's env value wins. Only when
 * it has moved *away* from that snapshot did someone change it, and per Codex's
 * semantics only the TUI's `/model` does that; then the TUI wins.
 */
export function resolveModel(sel) {
  const text = readText(configPath())
  const configured = text ? getKey(text, "model") : undefined
  const configuredProvider = text ? getKey(text, "model_provider") : undefined
  const magpieModel = sel.model

  // config.toml only speaks for the user when it points at magpie; a model
  // left over from before magpie was connected must not win.
  const usable = typeof configured === "string" && configured !== "" && configuredProvider === "magpie"
  if (!usable || configured === magpieModel) {
    return { model: magpieModel, source: "magpie", configured, configuredProvider }
  }

  // `install` wrote this value and nothing has changed it since: it is our own
  // echo, not a choice.
  const journal = readJournal()
  const installed = journal?.saved?.model
  const echoOfInstall = Boolean(installed && installed.present && configured === installed.value)

  // We launched with this model and config.toml said exactly this afterwards:
  // nobody has chosen since, so magpie's newer pick wins.
  const state = readState()
  const unchangedSinceLaunch = Boolean(state && state.configModel === configured)

  // A "/model" pick can only happen inside a session we started, and every
  // launch writes state, so "no state and no journal" means config.toml was
  // written by someone else (magpie's built-in Codex row) before we ever ran.
  // That is not a user choice, so magpie's own row must win — otherwise the
  // model picked on our Agents page is thrown away on the first launch.
  const hasHistory = Boolean(journal || state)
  const source = hasHistory && !echoOfInstall && !unchangedSinceLaunch ? "codex" : "magpie"
  return {
    model: source === "codex" ? configured : magpieModel,
    source,
    configured,
    configuredProvider,
  }
}

/**
 * Remember what this launch settled on, so the next one can tell who moved.
 * `configModel` is read back from the file *after* syncing, because that is
 * the value a later comparison has to be made against.
 */
export function rememberLaunch(resolved) {
  const text = readText(configPath())
  writeState({
    launchedAt: new Date().toISOString(),
    model: resolved.model,
    source: resolved.source,
    configModel: text ? getKey(text, "model") ?? null : null,
  })
}

/**
 * Keep magpie's env file and config.toml pointing at the same model, so the
 * Agents page and `codex-magpie` never disagree.
 */
export function syncModel(sel, resolved) {
  const changes = []
  if (resolved.source === "codex") {
    // the TUI's choice wins: write it back to the env file magpie owns
    const file = envPath()
    let text
    try {
      text = fs.readFileSync(file, "utf8")
    } catch {
      return changes
    }
    // Written through a real ENV rewrite, not a `^CODEX_MODEL=` regex: magpie
    // (or a hand edit) may spell it `CODEX_MODEL = x` or `export CODEX_MODEL=x`,
    // and a regex that silently matched nothing left the env stale while the
    // launch state still recorded the new model — which made the next launch
    // hand the win back to magpie and reverted the pick.
    const next = setEnvValue(text, "CODEX_MODEL", resolved.model)
    if (next !== text) {
      writeText(file, next)
      changes.push(`env: CODEX_MODEL=${resolved.model}`)
    }
  } else if (resolved.configured && resolved.configured !== resolved.model) {
    // magpie's choice wins: keep config.toml's model in step
    const text = readText(configPath())
    const next = setKey(text, "model", resolved.model)
    if (next !== text) {
      writeText(configPath(), next)
      changes.push(`config: model=${resolved.model}`)
    }
  }
  return changes
}

/**
 * Set one KEY=VALUE line in an ENV file, keeping every other line as it was.
 * Handles spacing around "=", an `export` prefix, quoted values and CRLF;
 * appends the key when it is missing entirely.
 */
export function setEnvValue(text, key, value) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const lines = text === "" ? [] : text.split(/\r?\n/)
  const re = new RegExp(`^(\\s*(?:export\\s+)?)${key}\\s*=`)
  const rendered = `${key}=${/\s|["'#]/.test(value) ? JSON.stringify(value) : value}`
  let found = false
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re)
    if (!m) continue
    lines[i] = m[1] + rendered
    found = true
  }
  if (!found) {
    if (lines.length && lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, rendered)
    else lines.push(rendered)
  }
  return lines.join(eol)
}

/** The args for a launch, using the resolved model instead of magpie's raw one. */
export function launchArgs(sel, resolved) {
  const effective = { ...sel, model: resolved.model }
  return toCLIArgs(effective)
}

export function toEnv(sel) {
  return { ...sel.env, CODEX_MODEL: sel.model, CODEX_BASE_URL: sel.base, CODEX_API_KEY: sel.key }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch (e) {
    if (e && e.code === "ENOENT") return ""
    throw e
  }
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.magpie-tmp`
  fs.writeFileSync(tmp, text, "utf8")
  fs.renameSync(tmp, file)
}

/**
 * Write magpie's selection into config.toml, recording the previous value of
 * every key for the first time so `restore()` can put it back exactly.
 */
export function install(sel) {
  const file = configPath()
  const before = readText(file)
  const journal = readJournal() || { file, saved: {}, createdAt: new Date().toISOString() }
  // Tables we have to create from scratch. restore() needs to know: a table we
  // appended by hand must go away entirely (header included), while a table the
  // user already had must keep its header even when we empty it.
  const createdTables = new Set(journal.createdTables || [])
  let after = before
  const wrote = []

  for (const [key, value] of ownedKeys(sel)) {
    const table = tableOf(key)
    if (table && !hasTable(before, table)) createdTables.add(table)
    if (!(key in journal.saved)) {
      const old = getKey(before, key)
      // Keep the exact source line too: it carries the user's trailing comment
      // and spacing, which a re-rendered value would lose on restore.
      journal.saved[key] =
        old === undefined
          ? { present: false }
          : { present: true, value: old, line: rawLine(before, key) }
    }
    const next = setKey(after, key, value)
    if (next !== after) wrote.push(key)
    after = next
  }

  journal.createdTables = [...createdTables]
  if (after !== before) writeText(file, after)
  writeText(journalPath(), JSON.stringify(journal, null, 2) + "\n")
  // config.toml now holds a value we wrote ourselves; snapshot it so a later
  // resolution does not mistake our own echo for a user choice.
  writeState({
    launchedAt: new Date().toISOString(),
    model: sel.model,
    source: "install",
    configModel: getKey(after, "model") ?? null,
  })
  return { file, wrote, changed: after !== before }
}

/** The table part of a dotted key ("a.b.c" -> "a.b"), or "" at top level. */
function tableOf(dotted) {
  const parts = dotted.split(".")
  parts.pop()
  return parts.join(".")
}

function readJournal() {
  try {
    const j = JSON.parse(fs.readFileSync(journalPath(), "utf8"))
    if (j && typeof j === "object" && j.saved) return j
    return null
  } catch {
    return null
  }
}

/**
 * Put every journaled key back to what it was before `install()` (removing keys
 * that were absent). Only keys we wrote are touched, so later hand edits to
 * unrelated settings survive.
 */
export function restore() {
  const journal = readJournal()
  const file = configPath()
  if (!journal) return { file, restored: [], changed: false }

  const before = readText(file)
  let after = before
  const restored = []
  const createdTables = new Set(journal.createdTables || [])
  // reverse order so re-created tables unwind cleanly
  for (const [key, saved] of Object.entries(journal.saved).reverse()) {
    if (!saved.present) after = delKey(after, key, { pruneEmptyTable: createdTables.has(tableOf(key)) })
    else if (typeof saved.line === "string") after = putRawLine(after, key, saved.line)
    else after = setKey(after, key, saved.value)
    restored.push(key)
  }

  if (after !== before) writeText(file, after)
  try {
    fs.unlinkSync(journalPath())
  } catch {}
  return { file, restored, changed: after !== before }
}

/** Whether config.toml currently holds exactly magpie's key for this provider. */
export function isInstalled(sel) {
  const text = readText(configPath())
  if (!text) return false
  const current = getKey(text, "model_providers.magpie.experimental_bearer_token")
  return typeof current === "string" && sel ? current === sel.key : false
}

/** A short report for `codex-magpie status`. */
export function status() {
  const sel = readSelection()
  const file = configPath()
  const text = readText(file)
  const journal = readJournal()
  const parsed = text ? parse(text) : {}
  const provider = (parsed.model_providers && parsed.model_providers.magpie) || {}
  const resolved = sel ? resolveModel(sel) : null
  return {
    codexHome: codexHome(),
    selection: sel,
    resolved,
    envFile: envPath(),
    catalog: catalogPath(),
    configFile: file,
    configExists: text !== "",
    configuredModel: parsed.model || null,
    configuredProvider: parsed.model_provider || null,
    configuredBaseURL: provider.base_url || null,
    journaledKeys: journal ? Object.keys(journal.saved) : [],
    pointsAtMagpie: sel ? provider.experimental_bearer_token === sel.key : false,
    // magpie's built-in Codex row edits the same config.toml; say so before we
    // write into it, because the two would otherwise overwrite each other.
    // the built-in row writes an absolute path, so compare the file name
    builtinCodexManagesConfig:
      (typeof parsed.model_catalog_json === "string" &&
        path.basename(parsed.model_catalog_json) === CATALOG_FILE) ||
      (typeof parsed.openai_base_url === "string" && parsed.openai_base_url.includes("/backend-api/codex")),
  }
}

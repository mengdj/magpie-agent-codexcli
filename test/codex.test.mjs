// Run with: npm test   (or: node --test test/codex.test.mjs test/platform.test.mjs)
//
// `node --test test/` does not work: newer Node treats the directory as a
// module specifier and fails with MODULE_NOT_FOUND.
//
// The conversion layer must never damage a user's config.toml, so the tests
// here are mostly about "everything else stays byte-for-byte the same".
import test from "node:test"
import assert from "node:assert"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { parse, setKey, getKey, delKey } from "../lib/toml.mjs"

const SAMPLE = `# my codex settings
model = "gpt-5.6"
model_provider = "openai"
approval_policy = "on-request"

[desktop]
followUpQueueMode = "steer"

[model_providers.magpie]
name = "old"   # hand edit
base_url = "http://127.0.0.1:1/v1"

[mcp_servers.context7]
url = "https://mcp.context7.com/mcp"
`

test("parse reads scalars, tables and comments", () => {
  const p = parse(SAMPLE)
  assert.equal(p.model, "gpt-5.6")
  assert.equal(p.approval_policy, "on-request")
  assert.equal(p.model_providers.magpie.name, "old")
  assert.equal(p.mcp_servers.context7.url, "https://mcp.context7.com/mcp")
})

test("setKey edits one line and keeps the rest", () => {
  const out = setKey(SAMPLE, "model_providers.magpie.base_url", "http://127.0.0.1:3425/v1")
  assert.equal(getKey(out, "model_providers.magpie.base_url"), "http://127.0.0.1:3425/v1")
  assert.ok(out.includes("# my codex settings"))
  assert.ok(out.includes('[mcp_servers.context7]'))
  assert.equal(getKey(out, "model_providers.magpie.name"), "old")
})

test("setKey adds a top-level key above the first table", () => {
  const out = setKey(SAMPLE, "model_reasoning_effort", "high")
  assert.equal(getKey(out, "model_reasoning_effort"), "high")
  // must not be swallowed by the last table
  assert.equal(parse(out).model_reasoning_effort, "high")
})

test("setKey creates a missing table instead of writing into a sibling", () => {
  const out = setKey(SAMPLE, "model_providers.newprov.name", "n")
  assert.equal(getKey(out, "model_providers.newprov.name"), "n")
  assert.equal(getKey(out, "model_providers.magpie.name"), "old")
})

test("setKey keeps an inline table intact", () => {
  const text = 'model = "x"\n\n[model_providers.magpie]\nhttp_headers = { "a" = "b" }\n'
  const out = setKey(text, "model_providers.magpie.base_url", "http://h/v1")
  assert.deepEqual(getKey(out, "model_providers.magpie.http_headers"), { a: "b" })
})

test("delKey removes only that key", () => {
  const out = delKey(SAMPLE, "approval_policy")
  assert.equal(getKey(out, "approval_policy"), undefined)
  assert.equal(getKey(out, "model"), "gpt-5.6")
})

test("install then restore is byte-exact", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cxmagpie-test-"))
  process.env.CODEX_HOME = home
  fs.writeFileSync(path.join(home, "config.toml"), SAMPLE)
  fs.writeFileSync(
    path.join(home, "magpie-codex-cli.env"),
    "CODEX_MODEL=auto/hy3\nCODEX_API_KEY=magpie-codex-cli\nCODEX_BASE_URL=http://127.0.0.1:3425/v1\n",
  )

  const { readSelection, install, restore, toCLIArgs } = await import("../lib/codex.mjs")
  const sel = readSelection()
  assert.equal(sel.model, "auto/hy3")

  const args = toCLIArgs(sel).join(" ")
  assert.ok(args.includes('-c model="auto/hy3"'))
  assert.ok(args.includes('model_providers.magpie.wire_api="responses"'))

  install(sel)
  const after = fs.readFileSync(path.join(home, "config.toml"), "utf8")
  assert.ok(after.includes('model = "auto/hy3"'))
  assert.ok(after.includes('model_provider = "magpie"'))
  assert.ok(after.includes('experimental_bearer_token = "magpie-codex-cli"'))
  assert.ok(after.includes("# my codex settings"))

  restore()
  assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), SAMPLE)
  assert.equal(fs.existsSync(path.join(home, "magpie-codex-cli.journal.json")), false)
})

// The Agents row and Codex's own /model picker both write a model. Whichever
// was chosen later must win, and the other side must be brought in line —
// otherwise "some models don't take effect".
test("a model picked in the TUI wins and is written back to magpie's env", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cxmagpie-sync-"))
  process.env.CODEX_HOME = home
  const envFile = path.join(home, "magpie-codex-cli.env")
  const cfgFile = path.join(home, "config.toml")

  fs.writeFileSync(envFile, "CODEX_MODEL=trae-cn/DeepSeek-V4-Flash\nCODEX_API_KEY=k\nCODEX_BASE_URL=http://h/v1\n")
  // a "/model" pick can only happen in a session we launched, so a previous
  // launch (and its state snapshot) always exists
  fs.writeFileSync(cfgFile, 'model = "workbuddy/glm-5.3-flash"\nmodel_provider = "magpie"\n')
  fs.writeFileSync(
    path.join(home, "magpie-codex-cli.state.json"),
    JSON.stringify({ model: "trae-cn/DeepSeek-V4-Flash", configModel: "trae-cn/DeepSeek-V4-Flash" }),
  )

  const { readSelection, resolveModel, syncModel, launchArgs } = await import("../lib/codex.mjs")
  const sel = readSelection()
  const resolved = resolveModel(sel)
  assert.equal(resolved.source, "codex")
  assert.equal(resolved.model, "workbuddy/glm-5.3-flash")

  const synced = syncModel(sel, resolved)
  assert.ok(synced.length > 0, "should report the sync")
  assert.match(fs.readFileSync(envFile, "utf8"), /CODEX_MODEL=workbuddy\/glm-5\.3-flash/)

  // the launcher must inject the winning model, not magpie's stale one
  assert.ok(launchArgs(sel, resolved).join(" ").includes('-c model="workbuddy/glm-5.3-flash"'))
})

test("a model picked in magpie wins while config.toml still holds what we launched with", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cxmagpie-sync2-"))
  process.env.CODEX_HOME = home
  const envFile = path.join(home, "magpie-codex-cli.env")
  const cfgFile = path.join(home, "config.toml")

  fs.writeFileSync(cfgFile, 'model = "workbuddy/glm-5.3-flash"\nmodel_provider = "magpie"\n')
  fs.writeFileSync(envFile, "CODEX_MODEL=auto/hy3\nCODEX_API_KEY=k\nCODEX_BASE_URL=http://h/v1\n")
  // we launched last time with glm-5.3-flash and config.toml still says so,
  // so nobody has chosen since: magpie's newer pick must win
  fs.writeFileSync(
    path.join(home, "magpie-codex-cli.state.json"),
    JSON.stringify({ model: "workbuddy/glm-5.3-flash", configModel: "workbuddy/glm-5.3-flash" }),
  )

  const { readSelection, resolveModel, syncModel } = await import("../lib/codex.mjs")
  const sel = readSelection()
  const resolved = resolveModel(sel)
  assert.equal(resolved.source, "magpie")
  assert.equal(resolved.model, "auto/hy3")

  syncModel(sel, resolved)
  assert.match(fs.readFileSync(cfgFile, "utf8"), /model = "auto\/hy3"/)
})

test("magpie's own built-in Codex row writing config.toml is not mistaken for a TUI pick", async () => {
  // The real-world bug: three writers share config.toml. magpie's built-in
  // Codex row rewrites `model`; that must NOT outrank the Codex CLI row.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cxmagpie-sync4-"))
  process.env.CODEX_HOME = home
  const envFile = path.join(home, "magpie-codex-cli.env")
  const cfgFile = path.join(home, "config.toml")

  fs.writeFileSync(envFile, "CODEX_MODEL=auto/qfmodel\nCODEX_API_KEY=k\nCODEX_BASE_URL=http://h/v1\n")
  fs.writeFileSync(cfgFile, 'model = "trae-cn/DeepSeek-V4-Flash"\nmodel_provider = "magpie"\n')
  // last launch settled on trae-cn and config.toml still says trae-cn,
  // i.e. the value came from our own launch, not from a /model pick
  fs.writeFileSync(
    path.join(home, "magpie-codex-cli.state.json"),
    JSON.stringify({ model: "trae-cn/DeepSeek-V4-Flash", configModel: "trae-cn/DeepSeek-V4-Flash" }),
  )

  const { readSelection, resolveModel } = await import("../lib/codex.mjs")
  const resolved = resolveModel(readSelection())
  assert.equal(resolved.source, "magpie")
  assert.equal(resolved.model, "auto/qfmodel", "magpie's Codex CLI row wins over its own Codex row")
})

test("a real TUI pick (config.toml moved after our launch) still wins", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cxmagpie-sync5-"))
  process.env.CODEX_HOME = home
  fs.writeFileSync(path.join(home, "magpie-codex-cli.env"),
    "CODEX_MODEL=auto/qfmodel\nCODEX_API_KEY=k\nCODEX_BASE_URL=http://h/v1\n")
  fs.writeFileSync(path.join(home, "config.toml"),
    'model = "qoder/qfmodel"\nmodel_provider = "magpie"\n')
  // we last launched with auto/qfmodel; config.toml now says something else
  fs.writeFileSync(path.join(home, "magpie-codex-cli.state.json"),
    JSON.stringify({ model: "auto/qfmodel", configModel: "auto/qfmodel" }))

  const { readSelection, resolveModel } = await import("../lib/codex.mjs")
  const resolved = resolveModel(readSelection())
  assert.equal(resolved.source, "codex")
  assert.equal(resolved.model, "qoder/qfmodel")
})

test("a value install() wrote does not outrank a newer magpie pick", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cxmagpie-sync3-"))
  process.env.CODEX_HOME = home
  const envFile = path.join(home, "magpie-codex-cli.env")
  const cfgFile = path.join(home, "config.toml")

  fs.writeFileSync(envFile, "CODEX_MODEL=workbuddy/glm-5.3-flash\nCODEX_API_KEY=k\nCODEX_BASE_URL=http://h/v1\n")
  fs.writeFileSync(cfgFile, 'model = "old/model"\nmodel_provider = "openai"\n')

  const { readSelection, install, resolveModel } = await import("../lib/codex.mjs")
  install(readSelection())
  const installedModel = fs.readFileSync(cfgFile, "utf8").match(/^model = "(.+)"$/m)[1]
  assert.equal(installedModel, "workbuddy/glm-5.3-flash")

  // magpie now picks something else, newer than config.toml
  fs.writeFileSync(envFile, "CODEX_MODEL=auto/hy3\nCODEX_API_KEY=k\nCODEX_BASE_URL=http://h/v1\n")
  const resolved = resolveModel(readSelection())
  assert.equal(resolved.source, "magpie", "config.toml is just echoing install()")
  assert.equal(resolved.model, "auto/hy3")
})

// ---------------------------------------------------------------------------
// Regressions for the bugs found in the 2026-10 review. Each of these failed
// before the fix; keep them green.
// ---------------------------------------------------------------------------

test("setKey keeps a trailing comment even though every value is quoted", () => {
  const text = 'model = "gpt-5.6"   # user note\n[model_providers.magpie]\nname = "old"  # hand edit\n'
  assert.ok(setKey(text, "model", "auto/hy3").includes("# user note"))
  const out = setKey(text, "model_providers.magpie.name", "magpie")
  assert.equal(getKey(out, "model_providers.magpie.name"), "magpie")
  assert.ok(out.includes("# hand edit"), "install() must not eat the user's comment")
})

test("a '#' inside a quoted value is not a comment", () => {
  const out = setKey('note = "a # b"  # real comment\n', "note", "c")
  assert.equal(getKey(out, "note"), "c")
  assert.ok(out.includes("# real comment"))
})

test("restore is byte-exact even when install() had to create the table", async () => {
  const { readSelection, install, restore } = await import("../lib/codex.mjs")
  for (const orig of ['model = "x"\n', 'model = "x"', '# top\nmodel = "x"\n', ""]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cxmagpie-reg-"))
    process.env.CODEX_HOME = home
    const cfg = path.join(home, "config.toml")
    const env = path.join(home, "magpie-codex-cli.env")
    fs.writeFileSync(cfg, orig)
    fs.writeFileSync(env, "CODEX_MODEL=a/b\nCODEX_API_KEY=k\nCODEX_BASE_URL=http://h/v1\n")

    install(readSelection())
    assert.ok(fs.readFileSync(cfg, "utf8").includes("[model_providers.magpie]"))
    restore()
    assert.equal(fs.readFileSync(cfg, "utf8"), orig, "single install: " + JSON.stringify(orig))

    // installing twice must still unwind to the same bytes
    fs.writeFileSync(cfg, orig)
    install(readSelection())
    fs.writeFileSync(env, "CODEX_MODEL=c/d\nCODEX_API_KEY=k2\nCODEX_BASE_URL=http://h2/v1\n")
    install(readSelection())
    restore()
    assert.equal(fs.readFileSync(cfg, "utf8"), orig, "double install: " + JSON.stringify(orig))
  }
})

test("delKey keeps a table header the user already had", () => {
  assert.equal(delKey('[model_providers.magpie]\nname = "x"\n', "model_providers.magpie.name"), '[model_providers.magpie]\n')
})

test("first launch with no history lets magpie's own row win", async () => {
  // No journal, no state: config.toml can only have been written by magpie's
  // built-in Codex row, which must not outrank the model picked on our row.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cxmagpie-first-"))
  process.env.CODEX_HOME = home
  const cfg = path.join(home, "config.toml")
  fs.writeFileSync(path.join(home, "magpie-codex-cli.env"),
    "CODEX_MODEL=auto/hy3\nCODEX_API_KEY=k\nCODEX_BASE_URL=http://h/v1\n")
  fs.writeFileSync(cfg, 'model = "builtin/leftover"\nmodel_provider = "magpie"\n')

  const { readSelection, resolveModel, syncModel } = await import("../lib/codex.mjs")
  const sel = readSelection()
  const resolved = resolveModel(sel)
  assert.equal(resolved.source, "magpie")
  assert.equal(resolved.model, "auto/hy3")
  assert.equal(resolved.configured, "builtin/leftover")

  syncModel(sel, resolved)
  assert.match(fs.readFileSync(cfg, "utf8"), /model = "auto\/hy3"/)
})

test("syncModel rewrites an env line spelled 'KEY = value'", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cxmagpie-env-"))
  process.env.CODEX_HOME = home
  const envFile = path.join(home, "magpie-codex-cli.env")
  fs.writeFileSync(envFile, "CODEX_MODEL = old/model\nCODEX_API_KEY=k\nCODEX_BASE_URL=http://h/v1\n")
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "tui/new"\nmodel_provider = "magpie"\n')
  fs.writeFileSync(path.join(home, "magpie-codex-cli.state.json"),
    JSON.stringify({ model: "old/model", configModel: "old/model" }))

  const { readSelection, resolveModel, syncModel, rememberLaunch } = await import("../lib/codex.mjs")
  const sel = readSelection()
  assert.equal(sel.model, "old/model")
  const resolved = resolveModel(sel)
  assert.equal(resolved.source, "codex")

  const synced = syncModel(sel, resolved)
  assert.ok(synced.length > 0, "a silent no-op is what reverted the pick")
  const text = fs.readFileSync(envFile, "utf8")
  assert.match(text, /^CODEX_MODEL=tui\/new$/m)
  assert.match(text, /^CODEX_API_KEY=k$/m, "the rest of the file must survive")

  // the next launch must not hand the win back to magpie
  rememberLaunch(resolved)
  const again = resolveModel(readSelection())
  assert.equal(again.model, "tui/new")
})

test("status sees the built-in row's catalog by file name", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cxmagpie-cat-"))
  process.env.CODEX_HOME = home
  const catalog = path.join(home, "magpie-models.json")
  fs.writeFileSync(catalog, "{}")
  fs.writeFileSync(path.join(home, "magpie-codex-cli.env"),
    "CODEX_MODEL=a/b\nCODEX_API_KEY=k\nCODEX_BASE_URL=http://h/v1\n")
  fs.writeFileSync(path.join(home, "config.toml"),
    'model = "a/b"\nmodel_provider = "magpie"\nmodel_catalog_json = ' + JSON.stringify(catalog) + "\n")

  const { status } = await import("../lib/codex.mjs")
  const s = status()
  assert.equal(s.catalog, catalog)
  assert.equal(s.builtinCodexManagesConfig, true)
})

test("connect() never writes the string 'undefined'", async () => {
  const { connect } = await import("../codex.agent.js")
  assert.deepEqual(connect({ gateway: { v1: "http://h/v1", key: "k" } }), {
    CODEX_BASE_URL: "http://h/v1",
    CODEX_API_KEY: "k",
  })
  assert.deepEqual(connect({ gateway: {} }), {})
  assert.deepEqual(connect(), {})
  assert.deepEqual(connect({ gateway: { v1: "http://h/v1" } }), { CODEX_BASE_URL: "http://h/v1" })
})


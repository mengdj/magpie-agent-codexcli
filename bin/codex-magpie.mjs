#!/usr/bin/env node
// codex-magpie — run the real Codex CLI on magpie's model.
//
//   codex-magpie [codex args...]     run Codex with magpie's model (-c overrides, no file edits)
//   codex-magpie install             write config.toml, journaling the previous values
//   codex-magpie restore             put config.toml back the way install() found it
//   codex-magpie status              what magpie chose and what Codex reads
//   codex-magpie which               print the Codex CLI binary that would run

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  readSelection,
  toCLIArgs,
  launchArgs,
  resolveModel,
  syncModel,
  rememberLaunch,
  install,
  restore,
  status,
  journalPath,
} from "../lib/codex.mjs"

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, "..")

function fail(message, hint) {
  process.stderr.write(`codex-magpie: ${message}\n`)
  if (hint) process.stderr.write(`${hint}\n`)
  process.exit(1)
}

const onWindows = process.platform === "win32"
export const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]

/** The shell convention for "died from signal N": 128 + N. */
export function signalExitCode(signal) {
  const n = os.constants.signals[signal]
  return typeof n === "number" ? 128 + n : 1
}

/** Find the real Codex CLI, skipping this package's own shim. */
export function findCodex() {
  const explicit = process.env.CODEX_MAGPIE_CODEX
  if (explicit) return explicit

  const names = onWindows ? ["codex.exe", "codex.cmd", "codex.bat", "codex"] : ["codex"]
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        const st = fs.statSync(candidate)
        if (!st.isFile()) continue
      } catch {
        continue
      }
      // never recurse into our own bin directory
      if (path.resolve(candidate).startsWith(path.resolve(pkgRoot))) continue
      // a Node CLI shim named codex-magpie isn't what we want either
      if (path.basename(candidate).startsWith("codex-magpie")) continue
      return candidate
    }
  }
  return null
}

function runCodex(codexBin, extra, userArgs) {
  // On Windows a .cmd/.bat cannot be spawned without a shell.
  const needsShell = onWindows && /\.(cmd|bat)$/i.test(codexBin)
  const child = needsShell
    ? spawn(`"${codexBin}" ${[...extra, ...userArgs].map(shellQuote).join(" ")}`, { stdio: "inherit", shell: true })
    : spawn(codexBin, [...extra, ...userArgs], { stdio: "inherit" })

  child.on("error", (e) => fail(`could not start ${codexBin}: ${e.message}`))
  child.on("exit", (code, signal) => {
    // Our own signal listeners keep Node alive, so re-raising SIGINT here
    // would just call the listener again and hang. Drop the listeners first,
    // re-raise so the shell records "killed by signal", and only fall back to
    // the 128+N exit code if the signal did not take.
    for (const sig of FORWARDED_SIGNALS) process.removeAllListeners(sig)
    if (!signal) {
      process.exit(code ?? 0)
      return
    }
    try {
      process.kill(process.pid, signal)
    } catch {}
    // If the re-raise was swallowed (some shells, or Windows' emulation), still
    // exit with the conventional code instead of dropping out with 0.
    setTimeout(() => process.exit(signalExitCode(signal)), 200)
  })
  for (const sig of FORWARDED_SIGNALS) {
    process.on(sig, () => {
      try { child.kill(sig) } catch {}
    })
  }
}

function shellQuote(s) {
  return /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

function printStatus() {
  const s = status()
  const line = (k, v) => process.stdout.write(`  ${k.padEnd(20)} ${v}\n`)
  line("CODEX_HOME", s.codexHome)
  if (!s.selection) {
    line("selection", "magpie has not connected Codex CLI yet")
    process.stdout.write(
      "\n  Pick a model for the Codex CLI row in magpie (Agents), or run:\n" +
        "    magpie codex-cli <provider>/<model>\n",
    )
  } else {
    line("model", s.selection.model)
    if (s.resolved && s.resolved.model !== s.selection.model) {
      const who = s.resolved.source === "codex" ? "Codex's /model" : "magpie"
      line("in effect", `${s.resolved.model}  (${who} wins; syncing)`)
    }
    line("gateway", s.selection.base)
    line("env file", s.envFile)
    line("model catalog", s.catalog ?? "(magpie has not written one)")
    line("config.toml", s.configFile + (s.configExists ? "" : " (missing)"))
    line("config model", s.configuredModel ?? "-")
    line("config provider", s.configuredProvider ?? "-")
    // config.toml only enters the picture for `install`; in the default
    // (-c override) mode it is expected to say something else.
    line("config→this key", s.pointsAtMagpie ? "yes (via install)" : "no (not installed)")
    line("journal", s.journaledKeys.length ? `${s.journaledKeys.length} keys (restore available)` : "none")
    if (s.builtinCodexManagesConfig && s.journaledKeys.length === 0) {
      process.stdout.write(
        "\n  Note: magpie's built-in “Codex” row also writes config.toml. `codex-magpie`\n" +
          "  does not edit that file, so nothing is fought over. If you run `install`,\n" +
          "  re-selecting a model in magpie's Codex row will overwrite it.\n",
      )
    }
  }
  process.stdout.write("\n  Run `codex-magpie` to start Codex on magpie's model.\n")
}

function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]

  if (command === "status") {
    printStatus()
    return
  }

  if (command === "install") {
    const sel = readSelection()
    if (!sel) fail("magpie has not chosen a model for Codex CLI", "Pick one in magpie's Agents page first.")
    const r = install(sel)
    process.stdout.write(`Wrote ${r.wrote.length} key(s) to ${r.file}\n`)
    for (const k of r.wrote) process.stdout.write(`  ${k}\n`)
    process.stdout.write(`Journal: ${journalPath()} (undo with: codex-magpie restore)\n`)
    process.stdout.write("\nRestart Codex to load it. Prefer `codex-magpie` — it needs no file edits at all.\n")
    return
  }

  if (command === "restore") {
    const r = restore()
    process.stdout.write(`Restored ${r.restored.length} key(s) in ${r.file}\n`)
    return
  }

  if (command === "which") {
    const bin = findCodex()
    if (!bin) fail("Codex CLI not found on PATH", "Install it, or set CODEX_MAGPIE_CODEX=/path/to/codex")
    process.stdout.write(bin + "\n")
    return
  }

  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(
      "codex-magpie — run Codex CLI on magpie's model\n\n" +
        "  codex-magpie [args...]   start Codex with magpie's model and gateway (-c overrides)\n" +
        "  codex-magpie install     write them into config.toml, keeping a journal\n" +
        "  codex-magpie restore     undo install, key by key\n" +
        "  codex-magpie status      show magpie's choice and what Codex reads\n" +
        "  codex-magpie which       print the Codex CLI binary used\n",
    )
    return
  }

  const sel = readSelection()
  if (!sel) {
    fail(
      "magpie has not chosen a model for Codex CLI",
      "Pick one for the “Codex CLI” row in magpie's Agents page, then run this again.",
    )
  }
  const bin = findCodex()
  if (!bin) fail("Codex CLI not found on PATH", "Install it, or set CODEX_MAGPIE_CODEX=/path/to/codex")

  // Keep magpie's Agents row and Codex's own /model picker from fighting:
  // whichever was chosen last wins, and the other side is brought in line.
  const resolved = resolveModel(sel)
  // Sync before remembering: rememberLaunch snapshots config.toml after we
  // aligned it, so the next launch does not mistake our own echo for a pick.
  const synced = syncModel(sel, resolved)
  if (synced.length) {
    process.stderr.write(`codex-magpie: synced ${synced.join(", ")}\n`)
  }
  rememberLaunch(resolved)
  runCodex(bin, launchArgs(sel, resolved), argv)
}

if (isMain) main()

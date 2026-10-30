#!/usr/bin/env node
// Put `codex-magpie` on PATH without registering a global npm package.
//
// magpie runs agent plugins inside its own sandbox (no Node APIs, no install
// hooks), so "installing the plugin" cannot create a shell command by itself.
// This script does that one step explicitly: it drops two small shim files in
// npm's global bin directory that point back at this package. Nothing is added
// to the global package list, and `--uninstall` removes exactly what it wrote.
//
//   node bin/setup.mjs                add codex-magpie to PATH
//   node bin/setup.mjs --uninstall    remove the shims
//   node bin/setup.mjs --print-dir    just show where they would go

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, "..")
const entry = path.join(here, "codex-magpie.mjs")
const setupSelf = path.join(here, "setup.mjs")
const NAME = "codex-magpie"
const onWindows = process.platform === "win32"

/**
 * npm's global bin directory. `npm prefix -g` prints the prefix; on Windows the
 * shims live directly in it, elsewhere in <prefix>/bin.
 */
function globalBinDir() {
  try {
    const prefix = execFileSync(onWindows ? "npm.cmd" : "npm", ["prefix", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    if (prefix) return onWindows ? prefix : path.join(prefix, "bin")
  } catch {}
  // fall back to the usual locations when npm cannot be asked
  if (onWindows) {
    if (process.env.APPDATA) return path.join(process.env.APPDATA, "npm")
  } else {
    return path.join(os.homedir(), ".local", "bin")
  }
  return null
}

function shimFiles(dir) {
  if (onWindows) {
    const cmd = [
      "@ECHO OFF",
      `REM written by magpie-agent-codex-cli setup — delete with: node "${setupSelf}" --uninstall`,
      `node "${entry}" %*`,
      "",
    ].join("\r\n")
    const ps1 = [
      `# written by magpie-agent-codex-cli setup — delete with: node "${setupSelf}" --uninstall`,
      `& node "${entry}" @args`,
      "",
    ].join("\r\n")
    return [
      { file: path.join(dir, `${NAME}.cmd`), body: cmd },
      { file: path.join(dir, `${NAME}`), body: `#!/bin/sh\nexec node "${entry}" "$@"\n` },
      { file: path.join(dir, `${NAME}.ps1`), body: ps1 },
    ]
  }
  return [{ file: path.join(dir, NAME), body: `#!/bin/sh\nexec node "${entry}" "$@"\n`, mode: 0o755 }]
}

function main() {
  const arg = process.argv[2]
  const dir = globalBinDir()
  if (!dir) {
    process.stderr.write("setup: could not find npm's global bin directory\n")
    process.stderr.write(`You can still run: node "${entry}"\n`)
    process.exit(1)
  }

  if (arg === "--print-dir") {
    process.stdout.write(dir + "\n")
    return
  }

  if (arg === "--uninstall") {
    let removed = 0
    for (const { file } of shimFiles(dir)) {
      try {
        const head = fs.readFileSync(file, "utf8").slice(0, 300)
        // Only remove a shim this package wrote. Match the marker comment and
        // the launcher name, never a bare directory name: the checkout is
        // "magpie-agent-codexcli" while the package is "magpie-agent-codex-cli".
        const ours = head.includes("magpie-agent-codex-cli setup") || /codex-magpie\.mjs/.test(head)
        if (!ours) continue
        fs.unlinkSync(file)
        removed++
      } catch {}
    }
    process.stdout.write(`Removed ${removed} shim(s) from ${dir}\n`)
    return
  }

  if (arg && arg !== "--force") {
    process.stderr.write(`setup: unknown option ${arg}\nusage: node bin/setup.mjs [--uninstall|--print-dir]\n`)
    process.exit(1)
  }

  fs.mkdirSync(dir, { recursive: true })
  for (const { file, body, mode } of shimFiles(dir)) {
    fs.writeFileSync(file, body, mode ? { mode } : undefined)
    if (mode) fs.chmodSync(file, mode)
    process.stdout.write(`Wrote ${file}\n`)
  }
  process.stdout.write(`\nRun \`${NAME}\` in a new terminal (PATH is read at shell start).\n`)
  process.stdout.write(`Undo with: node "${setupSelf}" --uninstall\n`)
}

main()

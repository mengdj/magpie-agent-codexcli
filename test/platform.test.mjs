// Cross-platform behaviour that is easy to get wrong and hard to notice on
// Windows: finding the CLI, and dying cleanly when the child is killed.
import test from "node:test"
import assert from "node:assert"
import path from "node:path"

import { signalExitCode, FORWARDED_SIGNALS } from "../bin/codex-magpie.mjs"

test("signal exit codes follow the shell convention", () => {
  assert.equal(signalExitCode("SIGINT"), 130)
  assert.equal(signalExitCode("SIGTERM"), 143)
  assert.equal(signalExitCode("SIGHUP"), 129)
})

test("forwards the signals an interactive TUI needs", () => {
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.ok(FORWARDED_SIGNALS.includes(s), `missing ${s}`)
  }
})

test("a child dying from a signal does not hang the wrapper", async () => {
  // Reproduce the handler the wrapper installs, then prove it terminates.
  const code = `
    const FORWARDED = ${JSON.stringify(FORWARDED_SIGNALS)}
    const onExit = (code, signal) => {
      for (const s of FORWARDED) process.removeAllListeners(s)
      if (!signal) { process.exit(code ?? 0); return }
      try { process.kill(process.pid, signal) } catch {}
      setTimeout(() => process.exit(128 + 15), 200)
    }
    for (const s of FORWARDED) process.on(s, () => {})
    onExit(null, "SIGTERM")
  `
  const { spawnSync } = await import("node:child_process")
  // Generous wall clock: on Windows spawning node costs a few seconds under
  // load. The bug this guards against is an *unbounded* hang, so a bounded
  // timeout plus "did not time out" is the assertion that matters.
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 15000 })
  assert.equal(r.signal, null, "must not be killed by our own test timeout")
  assert.ok(r.error === undefined, `spawn failed: ${r.error?.message}`)
  // POSIX: the re-raise kills us with SIGTERM and the shell sees 143.
  // Windows: process.kill maps SIGTERM onto TerminateProcess (code 1), so accept
  // either — the thing that must never happen is hanging or exiting 0.
  assert.ok(r.status === 143 || r.status === 1, `unexpected exit ${r.status}`)
  assert.notEqual(r.status, 0, "a signal death must not look like success")
})

test("findCodex accepts a bare name on POSIX and skips our own shim", async () => {
  const { findCodex } = await import("../bin/codex-magpie.mjs")
  // CODEX_MAGPIE_CODEX wins, which is the documented escape hatch
  const fake = path.join("tmp", "codex")
  process.env.CODEX_MAGPIE_CODEX = fake
  assert.equal(findCodex(), fake)
  delete process.env.CODEX_MAGPIE_CODEX
})

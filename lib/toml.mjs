// A deliberately small TOML reader/writer.
//
// Codex CLI's config.toml holds exactly the shape we touch: top-level scalars,
// a few [tables], and one inline table (`http_headers = { ... }`). Rather than
// reformat a user's whole file (which would lose comments and ordering), we
// only need to (a) read the keys we own and (b) patch those same keys in place,
// leaving every other line byte-for-byte alone.
//
// So: parse what we must read, and edit by locating the key's line span.

const BARE_KEY = /^[A-Za-z0-9_-]+$/

function unquote(s) {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\(["\\ntr])/g, (_, c) => ({ '"': '"', "\\": "\\", n: "\n", t: "\t", r: "\r" })[c])
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1)
  return s
}

function quote(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"'
}

// Split "[a.b]" into ["a","b"], honouring quoted segments.
function splitPath(path) {
  const out = []
  let cur = ""
  let q = null
  for (const ch of path) {
    if (q) {
      if (ch === q) q = null
      cur += ch
    } else if (ch === '"' || ch === "'") {
      q = ch
      cur += ch
    } else if (ch === ".") {
      out.push(unquote(cur.trim()))
      cur = ""
    } else {
      cur += ch
    }
  }
  if (cur.trim() !== "") out.push(unquote(cur.trim()))
  return out
}

function parseValue(raw) {
  const t = raw.trim()
  if (t === "") return ""
  if (t[0] === '"' || t[0] === "'") return unquote(t)
  if (t === "true") return true
  if (t === "false") return false
  if (/^[+-]?\d+$/.test(t)) return Number(t)
  if (t[0] === "[" && t[t.length - 1] === "]") {
    const inner = t.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(",").map((x) => parseValue(x))
  }
  if (t[0] === "{" && t[t.length - 1] === "}") {
    const obj = {}
    for (const part of splitTopLevel(t.slice(1, -1))) {
      const eq = part.indexOf("=")
      if (eq < 0) continue
      obj[unquote(part.slice(0, eq).trim())] = parseValue(part.slice(eq + 1))
    }
    return obj
  }
  return t
}

// split on commas that are not inside quotes/braces/brackets
function splitTopLevel(s) {
  const out = []
  let cur = ""
  let depth = 0
  let q = null
  for (const ch of s) {
    if (q) {
      cur += ch
      if (ch === q) q = null
      continue
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue }
    if (ch === "{" || ch === "[") depth++
    if (ch === "}" || ch === "]") depth--
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue }
    cur += ch
  }
  if (cur.trim() !== "") out.push(cur)
  return out
}

// Strip a trailing comment that is outside quotes.
function stripComment(s) {
  let q = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) { if (ch === q) q = null; continue }
    if (ch === '"' || ch === "'") { q = ch; continue }
    if (ch === "#") return s.slice(0, i)
  }
  return s
}

export function parse(text) {
  const root = {}
  let table = root
  let tablePath = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim()
    if (!line) continue
    if (line.startsWith("[")) {
      const isArray = line.startsWith("[[")
      const inner = isArray ? line.slice(2, line.lastIndexOf("]]")) : line.slice(1, line.lastIndexOf("]"))
      tablePath = splitPath(inner)
      table = root
      for (const key of tablePath) {
        if (isArray) {
          if (!Array.isArray(table[key])) table[key] = []
          const arr = table[key]
          if (arr.length === 0) arr.push({})
          table = arr[arr.length - 1]
        } else {
          if (typeof table[key] !== "object" || table[key] === null) table[key] = {}
          table = table[key]
        }
      }
      continue
    }
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = unquote(line.slice(0, eq).trim())
    table[key] = parseValue(line.slice(eq + 1))
  }
  return root
}

// Find the line range of the table named by path, plus the keys inside it.
// Returns { header: index|-1, start, end } where start/end bound the body.
function findTable(lines, path) {
  const target = path.join(".")
  // Top level: everything above the first table header.
  if (!target) {
    let end = lines.findIndex((l) => stripComment(l).trim().startsWith("["))
    if (end < 0) end = lines.length
    return { header: -1, start: 0, end }
  }
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim()
    if (!line.startsWith("[")) continue
    const isArray = line.startsWith("[[")
    const inner = isArray ? line.slice(2, line.lastIndexOf("]]")) : line.slice(1, line.lastIndexOf("]"))
    const p = splitPath(inner).join(".")
    if (start < 0) {
      if (p === target) start = i
      continue
    }
    // any following header ends this table's body
    return { header: start, start: start + 1, end: i }
  }
  if (start < 0) return { header: -1, start: 0, end: 0 }
  return { header: start, start: start + 1, end: lines.length }
}

// Locate `key` inside the table body. Returns the line index or -1.
function findKeyLine(lines, range, key) {
  for (let i = range.start; i < range.end; i++) {
    const line = stripComment(lines[i]).trim()
    if (!line || line.startsWith("[")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    if (unquote(line.slice(0, eq).trim()) === key) return i
  }
  return -1
}

function formatValue(v) {
  if (typeof v === "string") return quote(v)
  if (typeof v === "number") return String(v)
  if (typeof v === "boolean") return v ? "true" : "false"
  if (Array.isArray(v)) return "[" + v.map(formatValue).join(", ") + "]"
  if (v && typeof v === "object") {
    return "{ " + Object.entries(v).map(([k, val]) => `${BARE_KEY.test(k) ? k : quote(k)} = ${formatValue(val)}`).join(", ") + " }"
  }
  return quote(String(v))
}

/**
 * Set a dotted key to a value, editing only that key's line (or inserting a line
 * in the right table). Everything else in `text` is left as it was.
 *
 * @param {string} text existing file contents ("" to start a new file)
 * @param {string} dotted e.g. "model" or "model_providers.magpie.base_url"
 * @param {unknown} value
 */
export function setKey(text, dotted, value) {
  const parts = splitPath(dotted)
  const key = parts.pop()
  const tablePath = parts
  const lines = text === "" ? [] : text.split(/\r?\n/)
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const range = findTable(lines, tablePath)
  const idx = findKeyLine(lines, range, key)
  const rendered = `${BARE_KEY.test(key) ? key : quote(key)} = ${formatValue(value)}`

  if (idx >= 0) {
    // Keep any trailing comment on the line. A "#" only starts a comment when
    // it sits outside quotes — and every value we render is quoted, so testing
    // for quotes before the "#" (the old check) dropped every comment.
    const original = lines[idx]
    const body = stripComment(original)
    const trailing = body !== original ? " " + original.slice(body.length).trim() : ""
    lines[idx] = rendered + trailing
    return lines.join(eol)
  }

  if (range.header < 0 && tablePath.length > 0) {
    // Table does not exist yet: append it at the end. Whether we leave a
    // trailing newline behind is decided by the file we were given, so that
    // removing this table again restores the exact bytes.
    const body = lines.slice()
    const trailingEol = body.length === 0 || body[body.length - 1] === ""
    while (body.length && body[body.length - 1].trim() === "") body.pop()
    const block = [`[${tablePath.join(".")}]`, rendered]
    const out = body.length ? [...body, "", ...block] : block
    if (trailingEol) out.push("")
    return out.join(eol)
  }

  // A top-level key must stay above the first table header, or it would be
  // parsed as part of that table.
  if (tablePath.length === 0) {
    let firstHeader = lines.findIndex((l) => stripComment(l).trim().startsWith("["))
    if (firstHeader < 0) firstHeader = lines.length
    let insertAt = firstHeader
    while (insertAt - 1 >= 0 && lines[insertAt - 1].trim() === "") insertAt--
    lines.splice(insertAt, 0, rendered)
    return lines.join(eol)
  }

  // insert inside the existing table, after its last non-blank line
  let insertAt = range.end
  while (insertAt - 1 >= range.start && lines[insertAt - 1].trim() === "") insertAt--
  lines.splice(insertAt, 0, rendered)
  return lines.join(eol)
}

/** Read a dotted key, or undefined. */
export function getKey(text, dotted) {
  const parts = splitPath(dotted)
  let node = parse(text)
  for (const p of parts) {
    if (node == null || typeof node !== "object") return undefined
    node = node[p]
  }
  return node
}

/**
 * Remove a dotted key. Returns text unchanged if it was not there.
 *
 * With `pruneEmptyTable`, the table header is removed too once its body holds
 * nothing but blank lines — that is what makes an append we did earlier
 * (blank line, header, keys) unwind to the exact bytes that preceded it.
 * Only pass it for tables we created; emptying a table the user already had
 * must keep its header.
 */
export function delKey(text, dotted, options = {}) {
  const parts = splitPath(dotted)
  const key = parts.pop()
  const tablePath = parts
  const lines = text.split(/\r?\n/)
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const range = findTable(lines, tablePath)
  const idx = findKeyLine(lines, range, key)
  if (idx < 0) return text
  lines.splice(idx, 1)
  if (options.pruneEmptyTable && tablePath.length > 0) {
    const now = findTable(lines, tablePath)
    if (now.header >= 0 && !hasTableBody(lines, now)) {
      lines.splice(now.header, 1)
      // and the separator line we inserted in front of the header
      if (now.header - 1 >= 0 && lines[now.header - 1].trim() === "") lines.splice(now.header - 1, 1)
    }
  }
  return lines.join(eol)
}

/** Whether a table range still holds any key (blank/comment lines do not count). */
function hasTableBody(lines, range) {
  for (let i = range.start; i < range.end; i++) {
    const line = stripComment(lines[i]).trim()
    if (line && !line.startsWith("[")) return true
  }
  return false
}

/** The raw source line holding a dotted key, or null. */
export function rawLine(text, dotted) {
  const parts = splitPath(dotted)
  const key = parts.pop()
  const lines = text.split(/\r?\n/)
  const idx = findKeyLine(lines, findTable(lines, parts), key)
  return idx < 0 ? null : lines[idx]
}

/**
 * Put a verbatim source line back for a dotted key, keeping its comments and
 * spacing. Used to undo an edit exactly.
 */
export function putRawLine(text, dotted, line) {
  const parts = splitPath(dotted)
  const key = parts.pop()
  const tablePath = parts
  const lines = text.split(/\r?\n/)
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const range = findTable(lines, tablePath)
  const idx = findKeyLine(lines, range, key)
  if (idx >= 0) {
    lines[idx] = line
    return lines.join(eol)
  }
  if (tablePath.length === 0) {
    let firstHeader = lines.findIndex((l) => stripComment(l).trim().startsWith("["))
    if (firstHeader < 0) firstHeader = lines.length
    let insertAt = firstHeader
    while (insertAt - 1 >= 0 && lines[insertAt - 1].trim() === "") insertAt--
    lines.splice(insertAt, 0, line)
    return lines.join(eol)
  }
  if (range.header < 0) {
    const body = lines.slice()
    const trailingEol = body.length === 0 || body[body.length - 1] === ""
    while (body.length && body[body.length - 1].trim() === "") body.pop()
    const block = [`[${tablePath.join(".")}]`, line]
    const out = body.length ? [...body, "", ...block] : block
    if (trailingEol) out.push("")
    return out.join(eol)
  }
  let insertAt = range.end
  while (insertAt - 1 >= range.start && lines[insertAt - 1].trim() === "") insertAt--
  lines.splice(insertAt, 0, line)
  return lines.join(eol)
}

/** Whether a table exists (a header line was found). */
export function hasTable(text, dotted) {
  const lines = text.split(/\r?\n/)
  return findTable(lines, splitPath(dotted)).header >= 0
}

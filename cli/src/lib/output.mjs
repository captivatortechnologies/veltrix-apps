// ============================================================================
// Terminal output helpers — ANSI colors (no dependency), table rendering,
// byte/time formatting, and the shared pretty-printer for sandbox run
// results (used by both `veltrix sandbox run` and `veltrix dev --run`).
//
// Colors are disabled automatically when stdout is not a TTY or NO_COLOR
// is set (https://no-color.org/).
// ============================================================================

const colorsEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR

const paint = (code) => (s) => (colorsEnabled ? `\x1b[${code}m${s}\x1b[0m` : String(s))

export const c = {
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  cyan: paint(36),
  gray: paint(90),
  dim: paint(2),
  bold: paint(1),
}

/** Paint a sandbox status with its conventional color. */
export function paintStatus(status) {
  switch (status) {
    case 'ACTIVE':
      return c.green
    case 'SYNCING':
      return c.cyan
    case 'ERROR':
      return c.red
    case 'EXPIRED':
      return c.gray
    default:
      return (s) => s
  }
}

/** "1.2 MB", "340 KB", "87 B" */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

/** Relative time: past dates → "5m ago", future dates → "in 6d". */
export function formatRelative(dateLike) {
  if (!dateLike) return 'never'
  const date = new Date(dateLike)
  if (Number.isNaN(date.getTime())) return 'never'

  const deltaMs = date.getTime() - Date.now()
  const abs = Math.abs(deltaMs)
  const units = [
    [24 * 60 * 60 * 1000, 'd'],
    [60 * 60 * 1000, 'h'],
    [60 * 1000, 'm'],
    [1000, 's'],
  ]
  let text = '0s'
  for (const [ms, suffix] of units) {
    if (abs >= ms) {
      text = `${Math.floor(abs / ms)}${suffix}`
      break
    }
  }
  return deltaMs >= 0 ? `in ${text}` : `${text} ago`
}

/**
 * Render an aligned table. Cells are strings, or `{ text, paint }` objects
 * when a column needs color (padding is computed on the raw text so ANSI
 * escape codes never break alignment).
 */
export function renderTable(headers, rows) {
  const cellText = (cell) =>
    typeof cell === 'object' && cell !== null ? String(cell.text) : String(cell)

  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => cellText(row[i]).length), 0),
  )

  console.log(c.bold(headers.map((h, i) => h.padEnd(widths[i])).join('  ').trimEnd()))
  for (const row of rows) {
    const line = row
      .map((cell, i) => {
        const padded = cellText(cell).padEnd(widths[i])
        return typeof cell === 'object' && cell?.paint ? cell.paint(padded) : padded
      })
      .join('  ')
    console.log(line.trimEnd())
  }
}

/**
 * Pretty-print a sandbox run result: { ok, result?, error?, logs, durationMs }.
 * Tolerant of shape drift — the runner (S3) may still be evolving.
 */
export function printRunResult(res, { configTypeId, handler } = {}) {
  const label = configTypeId && handler ? ` ${configTypeId}:${handler}` : ''
  const duration = Number.isFinite(res?.durationMs) ? ` in ${res.durationMs}ms` : ''

  if (res?.ok) {
    console.log(`${c.green('✔')} run${label} succeeded${duration}`)
  } else {
    const reason = res?.error ? ` — ${res.error}` : ''
    console.log(`${c.red('✖')} run${label} failed${duration}${reason}`)
  }

  if (res?.result !== undefined && res?.result !== null) {
    const rendered =
      typeof res.result === 'string' ? res.result : JSON.stringify(res.result, null, 2)
    console.log(c.dim('  result:'))
    for (const line of rendered.split('\n')) console.log(`    ${line}`)
  }

  const logs = Array.isArray(res?.logs) ? res.logs : []
  if (logs.length > 0) {
    console.log(c.dim(`  logs (${logs.length}):`))
    for (const entry of logs) console.log(`    ${c.dim('⇢')} ${formatLogEntry(entry)}`)
  }
}

/** Render one log entry (string or structured {level, message, timestamp}). */
export function formatLogEntry(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') {
    const level = entry.level ? `[${String(entry.level).toLowerCase()}] ` : ''
    const message = entry.message ?? JSON.stringify(entry)
    return `${level}${message}`
  }
  return String(entry)
}

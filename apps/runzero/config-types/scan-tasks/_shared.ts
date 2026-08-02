// Shared helpers for the runZero Scan Tasks config type (deploy + rollback + drift + validate).
//
// A runZero scan task runs (or schedules) a scan of a Site. The console API models it as:
//   Create:  PUT /org/sites/{site_id}/scan   body ScanOptions   → returns a Task
//   List:    GET /org/tasks                  → array of Task
//   Update:  PATCH /org/tasks/{task_id}      body TaskOptions   → returns a Task
//   Stop:    POST /org/tasks/{task_id}/stop  (cancel a scheduled/recurring task)
// (verified against runZeroInc/runzero-api runzero-api.yml — ScanOptions / Task / TaskOptions.)
//
// NOTE ON VERBS: runZero CREATES a scan with PUT /org/sites/{site_id}/scan (not POST); there is
// NO delete-a-task verb, so a created recurring schedule is undone with POST .../stop.
//
// IDENTITY: a recurring scan is upserted by (site, scan-name). The API keys are hyphenated
// (scan-name, scan-frequency, tcp-ports, scan-tags) — the canvas uses camelCase keys that
// buildScanOptions maps across.
//
// FLAG (best-effort): the Task.params keys used on the PATCH update path are ASSUMED to match
// the ScanOptions request keys (targets, excludes, tcp-ports, rate, scan-tags). The spec does
// not enumerate the params map, so update of scan parameters is unverified against a live org;
// recurrence (recur / recur_frequency, well-defined TaskBase fields) is authoritative.

/** The runZero scan-frequency vocabulary (ScanOptions.scan-frequency enum). */
export const SCAN_FREQUENCIES = ['once', 'hourly', 'daily', 'weekly', 'monthly', 'continuous'] as const
export type ScanFrequency = (typeof SCAN_FREQUENCIES)[number]

/** One runZero Task as returned by GET /org/tasks (subset of the fields we use). */
export interface RunzeroTask {
  id?: string
  name?: string
  description?: string
  site_id?: string
  type?: string
  status?: string
  recur?: boolean
  recur_frequency?: string
  template_id?: string
  params?: Record<string, string>
  [key: string]: unknown
}

/** A runZero Site as far as scan tasks need it — resolve a site name to its id. */
export interface RunzeroSiteLite {
  id?: string
  name?: string
  [key: string]: unknown
}

/** One entry in deploy's rollbackData.previous — what deploy did to a single scan task. */
export interface ScanTaskRollbackEntry {
  name: string
  site: string
  taskId: string | null
  existed: boolean
  recurring: boolean
  prior: RunzeroTask | null
}

/** Trim any value to a string. */
export function text(value: unknown): string {
  return String(value ?? '').trim()
}

/** Normalize a frequency to the runZero vocabulary; unknown/blank falls back to `once`. */
export function normalizeFrequency(value: unknown): ScanFrequency {
  const f = text(value).toLowerCase()
  return (SCAN_FREQUENCIES as readonly string[]).includes(f) ? (f as ScanFrequency) : 'once'
}

/**
 * Normalize a targets/excludes blob into the single space-separated string runZero expects.
 * Accepts CIDRs/hosts separated by newlines, commas or whitespace; the literal `defaults`
 * (scan the site's default scope) passes through untouched. Empty stays empty.
 */
export function normalizeTargets(value: unknown): string {
  return text(value)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(' ')
}

/**
 * Build the ScanOptions body from canvas fields for a create (PUT /org/sites/{id}/scan).
 * `targets` is the only API-required field; it defaults to `defaults` (the site's own scope).
 * Only non-empty optional fields are included so runZero applies its own defaults otherwise.
 */
export function buildScanOptions(fields: Record<string, unknown>): Record<string, string> {
  const opts: Record<string, string> = {
    targets: normalizeTargets(fields.targets) || 'defaults',
    'scan-name': text(fields.scanName),
    'scan-frequency': normalizeFrequency(fields.frequency),
  }
  const map: Array<[string, string]> = [
    ['scan-description', text(fields.description)],
    ['excludes', normalizeTargets(fields.excludes)],
    ['scan-template', text(fields.scanTemplate)],
    ['tcp-ports', text(fields.tcpPorts)],
    ['rate', text(fields.rate)],
    ['scan-tags', text(fields.tags)],
  ]
  for (const [key, value] of map) if (value) opts[key] = value
  return opts
}

/** The scan-parameter subset carried in a Task.params map (best-effort key mapping — see header). */
export function scanParamsFrom(fields: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = { targets: normalizeTargets(fields.targets) || 'defaults' }
  const map: Array<[string, string]> = [
    ['excludes', normalizeTargets(fields.excludes)],
    ['tcp-ports', text(fields.tcpPorts)],
    ['rate', text(fields.rate)],
    ['scan-tags', text(fields.tags)],
  ]
  for (const [key, value] of map) if (value) params[key] = value
  return params
}

/** Build a TaskOptions PATCH body to bring an existing recurring task up to the declared shape. */
export function buildTaskUpdate(prior: RunzeroTask, fields: Record<string, unknown>): Record<string, unknown> {
  const frequency = normalizeFrequency(fields.frequency)
  return {
    name: text(fields.scanName) || prior.name || '',
    description: text(fields.description),
    recur: frequency !== 'once',
    recur_frequency: frequency,
    params: { ...(prior.params ?? {}), ...scanParamsFrom(fields) },
  }
}

/** Build a TaskOptions PATCH body that restores a task to its prior recorded shape (rollback). */
export function taskUpdateFromPrior(prior: RunzeroTask): Record<string, unknown> {
  return {
    name: prior.name ?? '',
    description: prior.description ?? '',
    recur: prior.recur ?? false,
    recur_frequency: prior.recur_frequency ?? '',
    params: prior.params ?? {},
  }
}

/** Resolve a site reference (name or UUID) to a site id using the live site list; falls back to the raw ref. */
export function resolveSiteId(sites: RunzeroSiteLite[], siteRef: unknown): string {
  const ref = text(siteRef)
  if (!ref) return ref
  const byName = sites.find((s) => text(s.name).toLowerCase() === ref.toLowerCase())
  return byName?.id ?? ref
}

/**
 * Find the recurring scan task that owns a (site, scan-name) — the upsert identity. Only
 * recurring tasks (recur === true) are treated as managed schedules; one-off runs are not
 * matched, so a `once` scan always creates a fresh task rather than clobbering history.
 */
export function findRecurringTask(tasks: RunzeroTask[], siteId: string, name: string): RunzeroTask | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return (
    tasks.find(
      (t) => t.recur === true && text(t.site_id) === siteId && text(t.name).toLowerCase() === n,
    ) ?? null
  )
}

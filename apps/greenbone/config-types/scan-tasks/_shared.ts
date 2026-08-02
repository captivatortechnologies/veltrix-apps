// Shared helpers for the Greenbone Scan Tasks config type (deploy + rollback +
// drift). A scan task ties a target to a scan config and a scanner (and optionally
// a schedule), each referenced BY NAME in the canvas and resolved to a gvmd UUID at
// deploy time. The task NAME is the stable identity used to upsert — gvmd does not
// enforce unique names, so this app treats the name as the key.
//
// FLAG (GMP 22.5): modify_task cannot re-point config/target/scanner on a task that
// has already run unless the task is alterable (gvmd issue #1305). deploy therefore
// only re-sends a foreign key that actually changed, so an unchanged re-deploy never
// trips this — but a genuine target/config/scanner change on a task with reports is
// surfaced as the gvmd error it is.

import { UUID_RE, type GmpTask, type GmpTarget, type GmpNamedRef, type GmpSchedule } from '../../lib/greenboneApi'

export { UUID_RE }

/**
 * Well-known feed UUIDs. Only used as canvas DEFAULT NAMES for the common case;
 * resolution is by name against the live gvmd, so these are documentation, not
 * hardcoded ids. Stable across installs that load the Greenbone feed.
 */
export const DEFAULT_SCAN_CONFIG_NAME = 'Full and fast'
export const DEFAULT_SCANNER_NAME = 'OpenVAS Default'

export interface TaskFields {
  name: string
  target: string
  config: string
  scanner: string
  schedule: string
  comment: string
}

/** Build the task fields (names, not ids) from a canvas item. */
export function buildTaskFields(fields: Record<string, unknown>): TaskFields {
  return {
    name: String(fields.name ?? '').trim(),
    target: String(fields.target ?? '').trim(),
    config: String(fields.config ?? '').trim() || DEFAULT_SCAN_CONFIG_NAME,
    scanner: String(fields.scanner ?? '').trim() || DEFAULT_SCANNER_NAME,
    schedule: String(fields.schedule ?? '').trim(),
    comment: String(fields.comment ?? '').trim(),
  }
}

/** Find a live task by name (trimmed, case-sensitive). */
export function findTaskByName(tasks: GmpTask[], name: string): GmpTask | null {
  const n = name.trim()
  if (!n) return null
  return tasks.find((t) => t.name.trim() === n) ?? null
}

/**
 * Resolve a canvas reference to a gvmd id. The user may type the entity NAME
 * (the normal case) OR paste the UUID directly — a value shaped like a UUID is
 * matched against ids, everything else against names (trimmed, case-sensitive).
 */
export function resolveRef(list: Array<{ id: string; name: string }>, value: string): string | null {
  const v = value.trim()
  if (!v) return null
  if (UUID_RE.test(v)) return list.find((e) => e.id === v)?.id ?? null
  return list.find((e) => e.name.trim() === v)?.id ?? null
}

export interface ResolvedRefs {
  configId: string
  targetId: string
  scannerId: string
  /** '' when no schedule is referenced (deploy sends id="0" to clear one on modify). */
  scheduleId: string
}

export interface RefResolution {
  resolved: ResolvedRefs | null
  /** Human-readable "kind \"name\"" tokens that could not be resolved. */
  missing: string[]
}

export interface LiveLookups {
  targets: GmpTarget[]
  configs: GmpNamedRef[]
  scanners: GmpNamedRef[]
  schedules: GmpSchedule[]
}

/**
 * Resolve a task's target / config / scanner (required) and schedule (optional)
 * names to gvmd ids against the live lookups. Pure and network-free so it is unit
 * tested directly; deploy loads the lookups over the socket and calls this.
 */
export function resolveTaskRefs(fields: TaskFields, live: LiveLookups): RefResolution {
  const missing: string[] = []

  const targetId = resolveRef(live.targets, fields.target)
  if (!targetId) missing.push(`target "${fields.target}"`)

  const configId = resolveRef(live.configs, fields.config)
  if (!configId) missing.push(`scan config "${fields.config}"`)

  const scannerId = resolveRef(live.scanners, fields.scanner)
  if (!scannerId) missing.push(`scanner "${fields.scanner}"`)

  let scheduleId = ''
  if (fields.schedule) {
    const resolved = resolveRef(live.schedules, fields.schedule)
    if (!resolved) missing.push(`schedule "${fields.schedule}"`)
    else scheduleId = resolved
  }

  if (missing.length > 0 || !targetId || !configId || !scannerId) return { resolved: null, missing }
  return { resolved: { configId, targetId, scannerId, scheduleId }, missing }
}

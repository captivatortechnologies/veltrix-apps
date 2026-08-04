import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { rubrikConnect, getJson, resolveServiceAccount } from '../../lib/rubrikApi'
import { buildSyslogBody, currentSyslogConfig, summarizeSyslog, type RubrikSyslogConfig } from './_shared'

/**
 * Drift for Syslog Configuration: compare the declared target's hostname,
 * protocol and port against the cluster's current (single) syslog target.
 * Best-effort — a connection failure asserts no drift rather than raising a
 * false positive. Read-only: GET /api/internal/syslog.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveServiceAccount(credential)) return { hasDrift: false, diffs }
  if (items.length === 0) return { hasDrift: false, diffs }

  let conn
  try {
    conn = await rubrikConnect(component, credential, settings)
  } catch {
    return { hasDrift: false, diffs }
  }

  let live: RubrikSyslogConfig | null
  try {
    live = currentSyslogConfig(await getJson<unknown>(conn, '/api/internal/syslog'))
  } catch {
    return { hasDrift: false, diffs }
  }

  const expected = summarizeSyslog(buildSyslogBody(items[0].fields) as RubrikSyslogConfig)
  const actual = summarizeSyslog(live)

  if (!live) {
    diffs.push({ field: 'syslog.exists', expected: 'configured', actual: 'missing', severity: 'warning' })
    return { hasDrift: true, diffs }
  }

  for (const key of ['hostname', 'protocol', 'port'] as const) {
    if (expected[key] !== actual[key]) {
      diffs.push({ field: `syslog.${key}`, expected: expected[key] ?? '', actual: actual[key] ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

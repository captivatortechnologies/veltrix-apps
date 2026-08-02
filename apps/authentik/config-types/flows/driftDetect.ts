import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAuthentikUrl, buildApiBase, resolveApiToken, resolveVerifyTls, getJsonOrNull } from '../../lib/authentikApi'
import { readManagedFields, sameManagedFields, snapshotManagedFields, type AuthentikFlow, type ManagedFlowFields } from './_shared'

/**
 * Drift for authentik flows: re-fetch each declared item by slug and compare
 * the managed fields (name, title, designation, authentication) against the
 * live flow. A missing flow is critical drift; a changed field is a warning.
 * `authentication` is only compared when declared (see _shared.ts).
 * Best-effort — a transport error on one item skips it rather than asserting
 * false drift. Read-only: GET /flows/instances/{slug}/ per item.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, deployedConfig, settings } = ctx
  const items = deployedConfig.items ?? deployedConfig.sections ?? []
  const diffs: DriftDiff[] = []

  const token = resolveApiToken(credential)
  if (!token) return { hasDrift: false, diffs }

  const base = buildApiBase(buildAuthentikUrl(component, connectivity, connectivityProvider))
  const verifyTls = resolveVerifyTls(settings)

  for (const item of items) {
    const slug = String(item.fields.slug ?? '').trim()
    if (!slug) continue

    let live: AuthentikFlow | null
    try {
      live = await getJsonOrNull<AuthentikFlow>(`${base}/flows/instances/${encodeURIComponent(slug)}/`, token, { verifyTls })
    } catch {
      continue // best-effort: can't read this item, don't assert drift
    }

    if (!live) {
      diffs.push({ field: slug, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const expected = readManagedFields(item.fields)
    const actual = snapshotManagedFields(live)
    if (sameManagedFields(expected, actual)) continue

    if (expected.name !== actual.name) {
      diffs.push({ field: `${slug}.name`, expected: expected.name, actual: actual.name, severity: 'warning' })
    }
    if (expected.title !== actual.title) {
      diffs.push({ field: `${slug}.title`, expected: expected.title, actual: actual.title, severity: 'warning' })
    }
    if (expected.designation !== actual.designation) {
      diffs.push({ field: `${slug}.designation`, expected: expected.designation, actual: actual.designation, severity: 'warning' })
    }
    if (expected.authentication && expected.authentication !== actual.authentication) {
      diffs.push({ field: `${slug}.authentication`, expected: expected.authentication, actual: actual.authentication, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

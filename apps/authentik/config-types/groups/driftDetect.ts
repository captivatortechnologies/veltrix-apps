import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAuthentikUrl, buildApiBase, resolveApiToken, resolveVerifyTls, findByName } from '../../lib/authentikApi'
import { readManagedFields, sameAttributes, sameManagedFields, snapshotManagedFields, type AuthentikGroup } from './_shared'

/**
 * Drift for authentik groups: re-find each declared item by name and compare
 * the managed fields (name, is_superuser, parent, attributes) against the live
 * group. A missing group is critical drift; a changed field is a warning
 * (`is_superuser` drift is flagged as critical — a privilege change). `parent`
 * is only compared when declared (see _shared.ts). Best-effort — a transport
 * error on one item skips it rather than asserting false drift. Read-only:
 * GET /core/groups/?name=<name> per item.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, deployedConfig, settings } = ctx
  const items = deployedConfig.items ?? deployedConfig.sections ?? []
  const diffs: DriftDiff[] = []

  const token = resolveApiToken(credential)
  if (!token) return { hasDrift: false, diffs }

  const base = buildApiBase(buildAuthentikUrl(component, connectivity, connectivityProvider))
  const verifyTls = resolveVerifyTls(settings)
  const listUrl = `${base}/core/groups/`

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue

    let live: AuthentikGroup | null
    try {
      live = await findByName<AuthentikGroup>(listUrl, token, name, { verifyTls })
    } catch {
      continue // best-effort: can't read this item, don't assert drift
    }

    if (!live) {
      diffs.push({ field: name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const expected = readManagedFields(item.fields)
    const actual = snapshotManagedFields(live)
    if (sameManagedFields(expected, actual)) continue

    if (expected.name !== actual.name) {
      diffs.push({ field: `${name}.name`, expected: expected.name, actual: actual.name, severity: 'warning' })
    }
    if (expected.isSuperuser !== actual.isSuperuser) {
      diffs.push({ field: `${name}.isSuperuser`, expected: expected.isSuperuser, actual: actual.isSuperuser, severity: 'critical' })
    }
    if (expected.parent && expected.parent !== actual.parent) {
      diffs.push({ field: `${name}.parent`, expected: expected.parent, actual: actual.parent, severity: 'warning' })
    }
    if (!sameAttributes(expected.attributes, actual.attributes)) {
      diffs.push({ field: `${name}.attributes`, expected: expected.attributes, actual: actual.attributes, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

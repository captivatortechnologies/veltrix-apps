import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAuthentikUrl, buildApiBase, resolveApiToken, resolveVerifyTls, findByName } from '../../lib/authentikApi'
import { readManagedFields, sameManagedFields, snapshotManagedFields, type AuthentikScopeMapping, type ManagedScopeMappingFields } from './_shared'

/** Drift for scope mappings: re-find by name, compare managed fields. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, deployedConfig, settings } = ctx
  const items = deployedConfig.items ?? deployedConfig.sections ?? []
  const diffs: DriftDiff[] = []

  const token = resolveApiToken(credential)
  if (!token) return { hasDrift: false, diffs }

  const base = buildApiBase(buildAuthentikUrl(component, connectivity, connectivityProvider))
  const verifyTls = resolveVerifyTls(settings)
  const listUrl = `${base}/propertymappings/provider/scope/`

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue

    let live: AuthentikScopeMapping | null
    try {
      live = await findByName<AuthentikScopeMapping>(listUrl, token, name, { verifyTls })
    } catch {
      continue
    }

    if (!live) {
      diffs.push({ field: name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const expected = readManagedFields(item.fields)
    const actual = snapshotManagedFields(live)
    if (sameManagedFields(expected, actual)) continue

    const keys: Array<keyof ManagedScopeMappingFields> = ['name', 'scopeName', 'description', 'expression']
    for (const key of keys) {
      if (expected[key] !== actual[key]) {
        diffs.push({ field: `${name}.${key}`, expected: expected[key], actual: actual[key], severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

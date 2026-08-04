import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAuthentikUrl, buildApiBase, resolveApiToken, resolveVerifyTls, findByName } from '../../lib/authentikApi'
import {
  readManagedFields,
  sameManagedFields,
  sameStringSet,
  snapshotManagedFields,
  type AuthentikSAMLProvider,
  type ManagedSAMLProviderFields,
} from './_shared'

/** Drift for SAML providers: re-find by name, compare managed fields. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, deployedConfig, settings } = ctx
  const items = deployedConfig.items ?? deployedConfig.sections ?? []
  const diffs: DriftDiff[] = []

  const token = resolveApiToken(credential)
  if (!token) return { hasDrift: false, diffs }

  const base = buildApiBase(buildAuthentikUrl(component, connectivity, connectivityProvider))
  const verifyTls = resolveVerifyTls(settings)
  const listUrl = `${base}/providers/saml/`

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue

    let live: AuthentikSAMLProvider | null
    try {
      live = await findByName<AuthentikSAMLProvider>(listUrl, token, name, { verifyTls })
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

    const scalarKeys: Array<keyof Pick<ManagedSAMLProviderFields, 'name' | 'authorizationFlow' | 'invalidationFlow' | 'acsUrl' | 'audience' | 'spBinding' | 'signAssertion' | 'signResponse'>> = [
      'name',
      'authorizationFlow',
      'invalidationFlow',
      'acsUrl',
      'audience',
      'spBinding',
      'signAssertion',
      'signResponse',
    ]
    for (const key of scalarKeys) {
      if (expected[key] !== actual[key]) {
        diffs.push({ field: `${name}.${key}`, expected: expected[key], actual: actual[key], severity: 'warning' })
      }
    }
    if (expected.propertyMappings.length > 0 && !sameStringSet(expected.propertyMappings, actual.propertyMappings)) {
      diffs.push({ field: `${name}.propertyMappings`, expected: expected.propertyMappings, actual: actual.propertyMappings, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

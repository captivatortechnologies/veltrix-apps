import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAuthentikUrl, buildApiBase, resolveApiToken, resolveVerifyTls, findByField } from '../../lib/authentikApi'
import { readManagedFields, sameAttributes, sameManagedFields, snapshotManagedFields, type AuthentikBrand, type ManagedBrandFields } from './_shared'

/** Drift for brands: re-find by domain, compare managed fields. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, deployedConfig, settings } = ctx
  const items = deployedConfig.items ?? deployedConfig.sections ?? []
  const diffs: DriftDiff[] = []

  const token = resolveApiToken(credential)
  if (!token) return { hasDrift: false, diffs }

  const base = buildApiBase(buildAuthentikUrl(component, connectivity, connectivityProvider))
  const verifyTls = resolveVerifyTls(settings)
  const listUrl = `${base}/core/brands/`

  for (const item of items) {
    const domain = String(item.fields.domain ?? '').trim()
    if (!domain) continue

    let live: AuthentikBrand | null
    try {
      live = await findByField<AuthentikBrand>(listUrl, token, 'domain', domain, { verifyTls })
    } catch {
      continue
    }

    if (!live) {
      diffs.push({ field: domain, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const expected = readManagedFields(item.fields)
    const actual = snapshotManagedFields(live)
    if (sameManagedFields(expected, actual)) continue

    const scalarKeys: Array<keyof Pick<ManagedBrandFields, 'domain' | 'default' | 'brandingTitle' | 'brandingLogo' | 'brandingFavicon' | 'flowAuthentication' | 'flowInvalidation' | 'flowRecovery'>> = [
      'domain',
      'default',
      'brandingTitle',
      'brandingLogo',
      'brandingFavicon',
      'flowAuthentication',
      'flowInvalidation',
      'flowRecovery',
    ]
    for (const key of scalarKeys) {
      if (expected[key] && expected[key] !== actual[key]) {
        diffs.push({ field: `${domain}.${key}`, expected: expected[key], actual: actual[key], severity: key === 'default' ? 'warning' : 'warning' })
      }
    }
    if (!sameAttributes(expected.attributes, actual.attributes)) {
      diffs.push({ field: `${domain}.attributes`, expected: expected.attributes, actual: actual.attributes, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAuthentikUrl, buildApiBase, resolveApiToken, resolveVerifyTls, findByName } from '../../lib/authentikApi'
import {
  readManagedFields,
  sameManagedFields,
  sameStringSet,
  snapshotManagedFields,
  type AuthentikOAuth2Provider,
  type ManagedOAuth2ProviderFields,
} from './_shared'

/**
 * Drift for authentik OAuth2/OpenID providers: re-find each declared item by
 * name and compare the managed fields against the live provider. A missing
 * provider is critical drift; a changed field is a warning. `clientId` /
 * `signingKey` / `propertyMappings` are only compared when declared (see
 * _shared.ts). Best-effort — a transport error on one item skips it rather
 * than asserting false drift. Read-only: GET /providers/oauth2/?name=<name>
 * per item.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, deployedConfig, settings } = ctx
  const items = deployedConfig.items ?? deployedConfig.sections ?? []
  const diffs: DriftDiff[] = []

  const token = resolveApiToken(credential)
  if (!token) return { hasDrift: false, diffs }

  const base = buildApiBase(buildAuthentikUrl(component, connectivity, connectivityProvider))
  const verifyTls = resolveVerifyTls(settings)
  const listUrl = `${base}/providers/oauth2/`

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue

    let live: AuthentikOAuth2Provider | null
    try {
      live = await findByName<AuthentikOAuth2Provider>(listUrl, token, name, { verifyTls })
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

    const scalarKeys: Array<keyof Pick<ManagedOAuth2ProviderFields, 'name' | 'authorizationFlow' | 'invalidationFlow' | 'clientType'>> = [
      'name',
      'authorizationFlow',
      'invalidationFlow',
      'clientType',
    ]
    for (const key of scalarKeys) {
      if (expected[key] !== actual[key]) {
        diffs.push({ field: `${name}.${key}`, expected: expected[key], actual: actual[key], severity: 'warning' })
      }
    }
    if (expected.clientId && expected.clientId !== actual.clientId) {
      diffs.push({ field: `${name}.clientId`, expected: expected.clientId, actual: actual.clientId, severity: 'warning' })
    }
    if (expected.signingKey && expected.signingKey !== actual.signingKey) {
      diffs.push({ field: `${name}.signingKey`, expected: expected.signingKey, actual: actual.signingKey, severity: 'warning' })
    }
    if (!sameStringSet(expected.redirectUrls, actual.redirectUrls)) {
      diffs.push({ field: `${name}.redirectUrls`, expected: expected.redirectUrls, actual: actual.redirectUrls, severity: 'warning' })
    }
    if (expected.propertyMappings.length > 0 && !sameStringSet(expected.propertyMappings, actual.propertyMappings)) {
      diffs.push({ field: `${name}.propertyMappings`, expected: expected.propertyMappings, actual: actual.propertyMappings, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

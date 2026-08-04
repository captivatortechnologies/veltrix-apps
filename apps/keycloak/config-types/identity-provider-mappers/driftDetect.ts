import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, resolveGrant } from '../../lib/keycloakApi'
import { readString, stringMapsEqual } from '../../lib/fields'
import { findMapperByName, projectFromFields, projectFromLive, type KeycloakIdpMapperRep } from './_shared'

/**
 * Drift for identity-provider mappers: compare the fields we declare
 * (identityProviderMapper, config) against the live mapper in Keycloak. Secret
 * config keys are excluded from the comparison (Keycloak returns them masked).
 * Best-effort — a mapper whose identity provider, or whose own entry, can't be
 * resolved is skipped rather than raising false drift. Read-only:
 * GET /identity-provider/instances/{alias}(/mappers).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveGrant(credential)) return { hasDrift: false, diffs }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  for (const item of items) {
    const alias = readString(item.fields.alias)
    const name = readString(item.fields.name)
    if (!alias || !name) continue

    let match: KeycloakIdpMapperRep | null
    try {
      const idpRes = await admin.get(`/identity-provider/instances/${encodeURIComponent(alias)}`)
      if (!idpRes.ok) continue // best-effort: the identity provider is missing

      const res = await admin.get(`/identity-provider/instances/${encodeURIComponent(alias)}/mappers`)
      if (!res.ok) continue // best-effort: can't read, don't assert drift
      const list = parseJson<KeycloakIdpMapperRep[]>(res.body) ?? []
      match = findMapperByName(list, name)
    } catch {
      continue
    }
    if (!match) continue

    const label = `${alias}/${name}`
    const expected = projectFromFields(item.fields)
    const actual = projectFromLive(match)

    if (expected.identityProviderMapper !== actual.identityProviderMapper) {
      diffs.push({
        field: `${label}.identityProviderMapper`,
        expected: expected.identityProviderMapper,
        actual: actual.identityProviderMapper,
        severity: 'warning',
      })
    }

    if (!stringMapsEqual(expected.config, actual.config)) {
      diffs.push({
        field: `${label}.config`,
        expected: expected.config,
        actual: actual.config,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

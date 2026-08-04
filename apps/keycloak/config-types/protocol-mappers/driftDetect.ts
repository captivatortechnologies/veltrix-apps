import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, resolveGrant } from '../../lib/keycloakApi'
import { readString, stringMapsEqual } from '../../lib/fields'
import { resolveClientByClientId } from '../../lib/clients'
import {
  findMapperByName,
  mapperBasePath,
  projectFromFields,
  projectFromLive,
  resolveClientScopeByName,
  type KeycloakProtocolMapperRep,
  type ProtocolMapperTargetType,
} from './_shared'

/**
 * Drift for protocol mappers: compare the fields we declare (protocolMapper,
 * config) against the live mapper in Keycloak. Best-effort — a mapper whose
 * target (client / client scope) can't be resolved, or whose own entry can't be
 * found, is skipped rather than raising false drift. Read-only:
 * GET {base}/protocol-mappers/models.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveGrant(credential)) return { hasDrift: false, diffs }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  for (const item of items) {
    const targetType = readString(item.fields.targetType) as ProtocolMapperTargetType
    const targetRef = readString(item.fields.targetRef)
    const name = readString(item.fields.name)
    if (!targetType || !targetRef || !name) continue

    let parentId: string | null = null
    try {
      if (targetType === 'client') {
        const client = await resolveClientByClientId(admin, targetRef)
        parentId = client?.id ?? null
      } else if (targetType === 'client-scope') {
        const scope = await resolveClientScopeByName(admin, targetRef)
        parentId = scope?.id ?? null
      }
    } catch {
      continue
    }
    if (!parentId) continue // best-effort: target missing, don't assert drift

    const base = mapperBasePath(targetType, parentId)
    let match: KeycloakProtocolMapperRep | null
    try {
      const res = await admin.get(base)
      if (!res.ok) continue // best-effort: can't read, don't assert drift
      const list = parseJson<KeycloakProtocolMapperRep[]>(res.body) ?? []
      match = findMapperByName(list, name)
    } catch {
      continue
    }
    if (!match) continue

    const label = `${targetType}:${targetRef}/${name}`
    const expected = projectFromFields(item.fields)
    const actual = projectFromLive(match)

    if (expected.protocolMapper !== actual.protocolMapper) {
      diffs.push({
        field: `${label}.protocolMapper`,
        expected: expected.protocolMapper,
        actual: actual.protocolMapper,
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

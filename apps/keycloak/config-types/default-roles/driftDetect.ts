import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAdminClient, resolveGrant } from '../../lib/keycloakApi'
import { stringSetsEqual } from '../../lib/fields'
import {
  clientRoleMapsEqual,
  fetchComposites,
  projectFromFields,
  projectLiveComposites,
  resolveDefaultRoleId,
} from './_shared'

/**
 * Drift for default-roles: compare the declared composite children against the
 * realm's live default-role composites. Best-effort — when the default role
 * can't be resolved or the composites can't be read, no drift is asserted
 * rather than raising a false positive. Read-only: GET /admin/realms/{realm},
 * GET .../roles-by-id/{id}/composites, and GET /clients/{uuid} (to resolve
 * client-role containerIds back to their human clientId).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]
  const diffs: DriftDiff[] = []

  if (!item || !resolveGrant(credential)) return { hasDrift: false, diffs }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  const resolved = await resolveDefaultRoleId(admin)
  if ('error' in resolved) return { hasDrift: false, diffs }

  const expected = projectFromFields(item.fields)

  let actual
  try {
    const composites = await fetchComposites(admin, resolved.id)
    actual = await projectLiveComposites(admin, composites)
  } catch {
    return { hasDrift: false, diffs }
  }

  if (!stringSetsEqual(expected.realmRoles, actual.realmRoles)) {
    diffs.push({
      field: 'realmRoles',
      expected: expected.realmRoles,
      actual: actual.realmRoles,
      severity: 'warning',
    })
  }

  if (!clientRoleMapsEqual(expected.clientRoles, actual.clientRoles)) {
    diffs.push({
      field: 'clientRoles',
      expected: expected.clientRoles,
      actual: actual.clientRoles,
      severity: 'warning',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

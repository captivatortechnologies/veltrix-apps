import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOrcaClient, type OrcaClient } from '../../lib/orcaApi'
import { normalizeStringList, priorServerId, readPriorRollback } from '../../lib/reconcile'
import { customRoleFromEnvelope, type OrcaCustomRole } from './_shared'

/**
 * Drift for custom roles: for each declared item, recover the role id this
 * canvas assigned, GET the live role and compare description and permission
 * groups (order-insensitive) against what we declare. Best-effort — an item
 * with no known id, or a role that can't be read, is skipped. Read-only:
 * GET /api/rbac/roles/{id}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const previousData = await readPriorRollback<OrcaCustomRole>(ctx)

  for (const item of items) {
    const itemId = item.id ?? ''
    const name = String(item.fields.name ?? '').trim()
    const knownId = priorServerId(previousData.previous, itemId, name)
    if (!knownId) continue

    const live = await readCustomRole(client, knownId)
    if (!live) continue

    compare(diffs, name, 'description', String(item.fields.description ?? '').trim(), String(live.description ?? '').trim())

    const expectedPermissions = normalizeStringList(item.fields.permissionGroups)
    const livePermissions = Array.isArray(live.permission_groups) ? live.permission_groups.map((v) => String(v)) : []
    if ([...expectedPermissions].sort().join('\n') !== [...livePermissions].sort().join('\n')) {
      diffs.push({ field: `${name}.permissionGroups`, expected: expectedPermissions, actual: livePermissions, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function compare(diffs: DriftDiff[], label: string, field: string, expected: unknown, actual: unknown): void {
  if (expected !== actual) {
    diffs.push({ field: `${label}.${field}`, expected, actual, severity: 'warning' })
  }
}

async function readCustomRole(client: OrcaClient, id: string): Promise<OrcaCustomRole | null> {
  const res = await client.request<unknown>('GET', `/api/rbac/roles/${encodeURIComponent(id)}`)
  if (res.error) return null
  return customRoleFromEnvelope(res.data)
}

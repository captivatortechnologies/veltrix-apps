import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { attachDriftActor, veltrixActorLogins } from '../../lib/snykAuditLog'
import { listServiceAccounts } from './deploy'
import { extractServiceAccountSpecs, saKey, type LiveServiceAccount } from './validate'

/** Snyk audit event-name prefixes for service-account changes (best-effort attribution). */
const SERVICE_ACCOUNT_EVENT_PREFIXES = ['org.service_account']

/**
 * Detect drift between the deployed service accounts and the live org. A declared
 * account that no longer exists is critical drift; a role_id that no longer
 * matches is a warning. The generated token/secret is write-only and never
 * diffed.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built
  if (!client.hasOrg) return { hasDrift: false, diffs: [] }

  const specs = extractServiceAccountSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listServiceAccounts(client)
    const excludeActorLogins = veltrixActorLogins(ctx.credential)
    const byName = new Map<string, LiveServiceAccount>(
      live.filter((a) => a.attributes?.name).map((a) => [saKey(a.attributes!.name as string), a]),
    )
    for (const spec of specs) {
      const before = diffs.length
      const found = byName.get(saKey(spec.name))
      if (!found) {
        diffs.push({ field: `service_account:${spec.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
      } else if (spec.roleId && found.attributes?.role_id && found.attributes.role_id !== spec.roleId) {
        diffs.push({
          field: `service_account:${spec.name}.role_id`,
          expected: spec.roleId,
          actual: found.attributes.role_id,
          severity: 'warning',
        })
      }

      // Attribute this service account's drift ("who changed it + when") — best-effort.
      await attachDriftActor(client, diffs.slice(before), {
        targetId: found?.id,
        targetName: spec.name,
        eventPrefixes: SERVICE_ACCOUNT_EVENT_PREFIXES,
        excludeActorLogins,
      })
    }
  } catch (error) {
    diffs.push({
      field: 'snyk',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

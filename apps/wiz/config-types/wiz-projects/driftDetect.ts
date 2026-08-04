import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildWizClient } from '../../lib/wiz'
import { attachDriftActor, veltrixActorLogins } from '../lib/wizAuditLog'
import { listProjects, readProject } from './deploy'
import { extractProjectSpecs, projectKey, type LiveProject } from './validate'

/**
 * Detect drift between the deployed project configuration and the live
 * tenant. Re-finds each declared project by name and diffs the managed
 * scalar/set fields: a missing project is critical drift; a changed
 * description, business unit, archived state, business impact, or a changed
 * owner/champion/resource-link COUNT is a warning (a deep per-link diff is not
 * attempted — the same "count, not full diff" precedent this app already uses
 * for Security Frameworks' categories).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractProjectSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listProjects(client)
    const byName = new Map<string, LiveProject>(live.filter((p) => p.name).map((p) => [projectKey(p.name as string), p]))

    for (const spec of specs) {
      const before = diffs.length
      const label = spec.name
      const found = byName.get(projectKey(spec.name))
      if (!found || !found.id) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      const full = await readProject(client, found.id)

      if ((full.description ?? '') !== spec.description) {
        diffs.push({ field: `${label}.description`, expected: spec.description || '(none)', actual: full.description || '(none)', severity: 'warning' })
      }
      if ((full.businessUnit ?? '') !== spec.businessUnit) {
        diffs.push({ field: `${label}.business_unit`, expected: spec.businessUnit || '(none)', actual: full.businessUnit || '(none)', severity: 'warning' })
      }
      const liveArchived = full.archived ?? false
      if (liveArchived !== spec.archived) {
        diffs.push({ field: `${label}.archived`, expected: String(spec.archived), actual: String(liveArchived), severity: 'warning' })
      }
      const liveImpact = full.riskProfile?.businessImpact ?? 'MBI'
      if (liveImpact !== spec.riskProfile.businessImpact) {
        diffs.push({
          field: `${label}.risk_business_impact`,
          expected: spec.riskProfile.businessImpact,
          actual: liveImpact,
          severity: 'warning',
        })
      }

      compareSet(diffs, label, 'project_owners', spec.projectOwners, (full.projectOwners ?? []).map((o) => o.id ?? ''))
      compareSet(diffs, label, 'security_champions', spec.securityChampions, (full.securityChampions ?? []).map((c) => c.id ?? ''))

      const declaredLinkCount =
        (spec.resourceLinks && typeof spec.resourceLinks === 'object'
          ? Object.values(spec.resourceLinks as Record<string, unknown>).reduce(
              (sum: number, v) => sum + (Array.isArray(v) ? v.length : 0),
              0,
            )
          : 0) || 0
      const liveLinkCount =
        (full.cloudAccountLinks?.length ?? 0) + (full.cloudOrganizationLinks?.length ?? 0) + (full.kubernetesClustersLinks?.length ?? 0)
      if (declaredLinkCount !== liveLinkCount) {
        diffs.push({
          field: `${label}.resource_links_json`,
          expected: `${declaredLinkCount} link(s)`,
          actual: `${liveLinkCount} link(s)`,
          severity: 'warning',
        })
      }

      await attachDriftActor(client, diffs.slice(before), { targetId: found.id, targetName: spec.name, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({
      field: 'wiz',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Compare two id sets order-insensitively and push a warning diff on mismatch. */
function compareSet(diffs: DriftDiff[], label: string, field: string, declared: string[], live: string[]): void {
  const norm = (list: string[]): string[] => [...new Set(list.map((v) => v.toLowerCase()))].sort()
  const a = norm(declared)
  const b = norm(live)
  if (a.join(',') !== b.join(',')) {
    diffs.push({ field: `${label}.${field}`, expected: declared, actual: live, severity: 'warning' })
  }
}

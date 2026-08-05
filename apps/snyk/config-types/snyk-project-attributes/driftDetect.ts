import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { attachDriftActor, veltrixActorLogins } from '../../lib/snykAuditLog'
import { readProject } from './deploy'
import { extractProjectAttributesSpecs, tagsArrayToRecord } from './validate'

/** Snyk audit event-name prefixes for project attribute changes (best-effort attribution). */
const PROJECT_EVENT_PREFIXES = ['org.project.update', 'org.project.attributes', 'org.project.edit']

/** Deterministic JSON for comparing a string array regardless of order. */
function sortedArray(values: string[]): string {
  return JSON.stringify([...values].sort())
}

/** Deterministic JSON for comparing a string map regardless of key order. */
function sortedRecord(record: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(record)
      .sort(([a], [b]) => a.localeCompare(b)),
  )
}

/**
 * Detect drift between the deployed project attributes and the live org. A
 * declared project that can no longer be read is critical drift; a managed
 * attribute whose live value differs from the declared value is warning
 * drift. `test_frequency` and the owner are compared only when the operator
 * declared them (they are never sent otherwise, so an unmanaged value cannot
 * drift against nothing).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built
  if (!client.hasOrg) return { hasDrift: false, diffs: [] }

  const specs = extractProjectAttributesSpecs(ctx.deployedConfig).filter((s) => s.projectId)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await readProject(client, spec.projectId)
      const attrs = live.attributes ?? {}

      if (sortedArray(spec.businessCriticality) !== sortedArray(attrs.business_criticality ?? [])) {
        diffs.push({
          field: `${spec.projectId}.business_criticality`,
          expected: spec.businessCriticality.join(', ') || '(none)',
          actual: (attrs.business_criticality ?? []).join(', ') || '(none)',
          severity: 'warning',
        })
      }
      if (sortedArray(spec.environment) !== sortedArray(attrs.environment ?? [])) {
        diffs.push({
          field: `${spec.projectId}.environment`,
          expected: spec.environment.join(', ') || '(none)',
          actual: (attrs.environment ?? []).join(', ') || '(none)',
          severity: 'warning',
        })
      }
      if (sortedArray(spec.lifecycle) !== sortedArray(attrs.lifecycle ?? [])) {
        diffs.push({
          field: `${spec.projectId}.lifecycle`,
          expected: spec.lifecycle.join(', ') || '(none)',
          actual: (attrs.lifecycle ?? []).join(', ') || '(none)',
          severity: 'warning',
        })
      }
      if (sortedRecord(spec.tags) !== sortedRecord(tagsArrayToRecord(attrs.tags))) {
        diffs.push({
          field: `${spec.projectId}.tags`,
          expected: JSON.stringify(spec.tags),
          actual: JSON.stringify(tagsArrayToRecord(attrs.tags)),
          severity: 'warning',
        })
      }
      if (spec.testFrequency) {
        const liveFrequency = attrs.settings?.recurring_tests?.frequency ?? ''
        if (liveFrequency !== spec.testFrequency) {
          diffs.push({ field: `${spec.projectId}.test_frequency`, expected: spec.testFrequency, actual: liveFrequency || '(unset)', severity: 'warning' })
        }
      }
      if (spec.ownerUserId) {
        const liveOwner = live.relationships?.owner?.data?.id ?? ''
        if (liveOwner !== spec.ownerUserId) {
          diffs.push({ field: `${spec.projectId}.owner_user_id`, expected: spec.ownerUserId, actual: liveOwner || '(unset)', severity: 'warning' })
        }
      }
    } catch (error) {
      diffs.push({
        field: `project:${spec.projectId}`,
        expected: 'readable',
        actual: `unreadable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }

    await attachDriftActor(client, diffs.slice(before), {
      targetName: spec.projectId,
      eventPrefixes: PROJECT_EVENT_PREFIXES,
      excludeActorLogins,
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

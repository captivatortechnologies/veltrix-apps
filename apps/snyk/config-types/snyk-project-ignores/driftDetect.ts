import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { attachDriftActor, veltrixActorLogins } from '../../lib/snykAuditLog'
import { readIssueIgnore } from './deploy'
import { extractIgnoreSpecs } from './validate'

/** Snyk audit event-name prefixes for ignore changes (best-effort attribution). */
const IGNORE_EVENT_PREFIXES = ['org.project.ignore']

/**
 * Detect drift between the deployed ignores and the live org. A declared ignore
 * that is no longer present on its issue is critical drift; a live ignore whose
 * classification (reasonType) differs from the declared value is warning drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built
  if (!client.hasOrg) return { hasDrift: false, diffs: [] }

  const specs = extractIgnoreSpecs(ctx.deployedConfig).filter((s) => s.projectId && s.issueId)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const before = diffs.length
    const field = `ignore:${spec.projectId}:${spec.issueId}`
    try {
      const rules = await readIssueIgnore(client, spec.projectId, spec.issueId)
      if (rules.length === 0) {
        diffs.push({ field, expected: 'ignored', actual: 'not ignored', severity: 'critical' })
      } else if (!rules.some((r) => r.reasonType === spec.reasonType)) {
        diffs.push({
          field: `${field}.reasonType`,
          expected: spec.reasonType,
          actual: rules.map((r) => r.reasonType).join(', ') || 'unknown',
          severity: 'warning',
        })
      }
    } catch (error) {
      diffs.push({
        field,
        expected: 'readable',
        actual: `unreadable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }

    // Attribute this ignore's drift ("who changed it + when") — best-effort.
    await attachDriftActor(client, diffs.slice(before), {
      targetName: spec.issueId,
      eventPrefixes: IGNORE_EVENT_PREFIXES,
      excludeActorLogins,
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { attachDriftActor, veltrixActorLogins } from '../../lib/snykAuditLog'
import { readProjectSettings } from './deploy'
import { extractProjectSettingsSpecs } from './validate'

/** Snyk audit event-name prefixes for project setting changes (best-effort attribution). */
const PROJECT_EVENT_PREFIXES = ['org.project.settings', 'org.project.attributes']

/**
 * Detect drift between the deployed project settings and the live org. A declared
 * project that can no longer be read is critical drift; a managed setting whose
 * live value differs from the declared value is warning drift. The numeric
 * limits are only compared when they were declared.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built
  if (!client.hasOrg) return { hasDrift: false, diffs: [] }

  const specs = extractProjectSettingsSpecs(ctx.deployedConfig).filter((s) => s.projectId)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await readProjectSettings(client, spec.projectId)
      compareSetting(diffs, spec.projectId, 'pullRequestTestEnabled', spec.prTestEnabled, live.pullRequestTestEnabled)
      compareSetting(diffs, spec.projectId, 'pullRequestFailOnAnyVulns', spec.prFailOnAny, live.pullRequestFailOnAnyVulns)
      compareSetting(diffs, spec.projectId, 'pullRequestFailOnlyForHighSeverity', spec.prFailOnlyHigh, live.pullRequestFailOnlyForHighSeverity)
      compareSetting(diffs, spec.projectId, 'autoDepUpgradeEnabled', spec.autoDepUpgradeEnabled, live.autoDepUpgradeEnabled)
      if (spec.autoDepUpgradeLimit !== undefined) {
        compareSetting(diffs, spec.projectId, 'autoDepUpgradeLimit', spec.autoDepUpgradeLimit, live.autoDepUpgradeLimit)
      }
      if (spec.autoDepUpgradeMinAge !== undefined) {
        compareSetting(diffs, spec.projectId, 'autoDepUpgradeMinAge', spec.autoDepUpgradeMinAge, live.autoDepUpgradeMinAge)
      }
    } catch (error) {
      diffs.push({
        field: `project:${spec.projectId}`,
        expected: 'readable',
        actual: `unreadable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }

    // Attribute this project's drift ("who changed it + when") — best-effort.
    await attachDriftActor(client, diffs.slice(before), {
      targetName: spec.projectId,
      eventPrefixes: PROJECT_EVENT_PREFIXES,
      excludeActorLogins,
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/**
 * Push a warning diff when a managed setting's live value differs from the
 * declared value. Booleans compare against a coerced live value so an unset live
 * key reads as false.
 */
function compareSetting(
  diffs: DriftDiff[],
  projectId: string,
  key: string,
  expected: boolean | number,
  actual: boolean | number | undefined,
): void {
  const normalizedActual = typeof expected === 'boolean' ? Boolean(actual) : actual
  if (normalizedActual !== expected) {
    diffs.push({
      field: `${projectId}.${key}`,
      expected: String(expected),
      actual: actual === undefined ? 'unset' : String(actual),
      severity: 'warning',
    })
  }
}

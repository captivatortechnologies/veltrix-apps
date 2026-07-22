import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { attachDriftActor, veltrixActorLogins } from '../../lib/snykAuditLog'
import { listIntegrations, readIntegrationSettings } from './deploy'
import { extractIntegrationSpecs, integrationKey } from './validate'

/** Snyk audit event-name prefixes for integration changes (best-effort attribution). */
const INTEGRATION_EVENT_PREFIXES = ['org.integration']

/**
 * Detect drift between the deployed integration settings and the live org. A
 * declared integration type that is no longer connected is critical drift; a
 * managed setting whose live value differs from the declared value is warning
 * drift. The numeric limit is only compared when it was declared.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built
  if (!client.hasOrg) return { hasDrift: false, diffs: [] }

  const specs = extractIntegrationSpecs(ctx.deployedConfig).filter((s) => s.integrationType)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const integrations = await listIntegrations(client)
    const excludeActorLogins = veltrixActorLogins(ctx.credential)

    for (const spec of specs) {
      const before = diffs.length
      const integrationId = integrations[integrationKey(spec.integrationType)]
      if (!integrationId) {
        diffs.push({ field: `integration:${spec.integrationType}`, expected: 'connected', actual: 'missing', severity: 'critical' })
      } else {
        const live = await readIntegrationSettings(client, integrationId)
        compareSetting(diffs, spec.integrationType, 'pullRequestTestEnabled', spec.prTestEnabled, live.pullRequestTestEnabled)
        compareSetting(diffs, spec.integrationType, 'pullRequestFailOnAnyVulns', spec.prFailOnAny, live.pullRequestFailOnAnyVulns)
        compareSetting(diffs, spec.integrationType, 'pullRequestFailOnlyForHighSeverity', spec.prFailOnlyHigh, live.pullRequestFailOnlyForHighSeverity)
        compareSetting(diffs, spec.integrationType, 'autoDepUpgradeEnabled', spec.autoDepUpgradeEnabled, live.autoDepUpgradeEnabled)
        if (spec.autoDepUpgradeLimit !== undefined) {
          compareSetting(diffs, spec.integrationType, 'autoDepUpgradeLimit', spec.autoDepUpgradeLimit, live.autoDepUpgradeLimit)
        }
      }

      // Attribute this integration's drift ("who changed it + when") — best-effort.
      await attachDriftActor(client, diffs.slice(before), {
        targetId: integrationId,
        targetName: spec.integrationType,
        eventPrefixes: INTEGRATION_EVENT_PREFIXES,
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

/**
 * Push a warning diff when a managed setting's live value differs from the
 * declared value. Booleans compare against a coerced live value so an unset live
 * key reads as false.
 */
function compareSetting(
  diffs: DriftDiff[],
  integrationType: string,
  key: string,
  expected: boolean | number,
  actual: boolean | number | undefined,
): void {
  const normalizedActual = typeof expected === 'boolean' ? Boolean(actual) : actual
  if (normalizedActual !== expected) {
    diffs.push({
      field: `${integrationType}.${key}`,
      expected: String(expected),
      actual: actual === undefined ? 'unset' : String(actual),
      severity: 'warning',
    })
  }
}

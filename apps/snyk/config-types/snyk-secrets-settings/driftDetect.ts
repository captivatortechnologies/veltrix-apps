import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { attachDriftActor, veltrixActorLogins } from '../../lib/snykAuditLog'
import { readSecretsSettings } from './deploy'
import { extractSecretsSettings } from './validate'

/** Snyk audit event-name prefixes for org Secrets-settings changes (best-effort attribution). */
const SECRETS_EVENT_PREFIXES = ['org.secrets_settings', 'org.settings']

/**
 * Detect drift between the deployed Secrets settings and the live org: compare
 * the live secrets_enabled to the deployed value.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built
  if (!client.hasOrg) return { hasDrift: false, diffs: [] }

  const spec = extractSecretsSettings(ctx.deployedConfig)

  try {
    const live = await readSecretsSettings(client)
    const liveEnabled = live?.secrets_enabled ?? false
    if (liveEnabled !== spec.secretsEnabled) {
      diffs.push({
        field: 'secrets_enabled',
        expected: String(spec.secretsEnabled),
        actual: String(liveEnabled),
        severity: 'warning',
      })
    }

    await attachDriftActor(client, diffs, {
      eventPrefixes: SECRETS_EVENT_PREFIXES,
      excludeActorLogins: veltrixActorLogins(ctx.credential),
    })
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

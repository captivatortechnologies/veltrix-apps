import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
import { attachDriftActor, veltrixActorLogins } from '../lib/cloudflareAudit'
import { listIdentityProviders } from './deploy'
import { extractIdentityProviderSpecs, idpKey, type LiveIdentityProvider } from './validate'

/**
 * Detect drift between the deployed identity provider configuration and the
 * live account. Re-finds each declared provider by name and diffs its `type`;
 * a missing provider is critical drift.
 *
 * We intentionally do NOT diff `config_json`. Cloudflare redacts secret-bearing
 * fields (client_secret, etc.) on read and normalizes others, so a structural
 * diff against the raw JSON a user typed would flag constant false drift — the
 * same reasoning cloudflare-access-groups applies to its rule arrays. Presence
 * + type is the reliable, meaningful signal; config changes are managed by
 * re-deploying.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  if (!(await client.hasAccount())) {
    return { hasDrift: false, diffs: [] }
  }

  const specs = extractIdentityProviderSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listIdentityProviders(client)
    const byKey = new Map<string, LiveIdentityProvider>(
      live.filter((p) => p.name).map((p) => [idpKey(p.name as string), p]),
    )

    for (const spec of specs) {
      const before = diffs.length
      const found = byKey.get(idpKey(spec.name))
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }
      if ((found.type ?? '') !== spec.type) {
        diffs.push({
          field: `${spec.name}.type`,
          expected: spec.type,
          actual: found.type ?? 'not set',
          severity: 'warning',
        })
      }
      // Attribute every diff this provider produced to the last human change (once).
      await attachDriftActor(client, diffs.slice(before), { targetId: found.id, targetName: spec.name, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({
      field: 'cloudflare',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

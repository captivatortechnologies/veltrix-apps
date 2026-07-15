import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { listVpnCredentials } from './deploy'
import { credentialIdentity, extractVpnCredentialSpecs, liveCredentialIdentity } from './validate'

/**
 * Detect drift between the deployed VPN credential configuration and the live
 * tenant. Re-finds each declared credential by identity (fqdn/ip_address) and
 * diffs ONLY the managed `comments`; a missing credential is critical drift.
 *
 * ⚠ THE PRE-SHARED KEY IS NEVER DIFFED — READ THIS BEFORE ADDING A FIELD:
 * `preSharedKey` is WRITE-ONLY. ZIA NEVER returns it on GET, so there is nothing
 * to compare against — any "diff" of it would compare the canvas value to
 * `undefined` and always report false drift. It is therefore DELIBERATELY
 * excluded from every comparison below. The credential type and identity are the
 * reconciliation key (immutable in ZIA), so only `comments` is diffable.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractVpnCredentialSpecs(ctx.deployedConfig).filter((s) => s.type && credentialIdentity(s))
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listVpnCredentials(client)
    const byIdentity = new Map<string, (typeof live)[number]>()
    for (const cred of live) {
      const id = liveCredentialIdentity(cred)
      if (id) byIdentity.set(id.toLowerCase(), cred)
    }

    for (const spec of specs) {
      const identity = credentialIdentity(spec)
      const found = byIdentity.get(identity.toLowerCase())
      if (!found) {
        diffs.push({ field: identity, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // Only `comments` is diffable. The PSK is write-only (never returned) and
      // is intentionally excluded (see the file header).
      const liveComments = (typeof found.comments === 'string' ? found.comments : '').trim()
      if ((spec.comments ?? '') !== liveComments) {
        diffs.push({
          field: `${identity}.comments`,
          expected: spec.comments ?? 'not set',
          actual: liveComments || 'not set',
          severity: 'info',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'zia',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
import { attachDriftActor, veltrixActorLogins } from '../lib/cloudflareAudit'
import { listCertificates } from './deploy'
import { extractMtlsCertificateSpecs, mtlsCertificateKey, type LiveMtlsCertificate } from './validate'

/** Normalize a hostname list for comparison — trimmed, lower-cased, order-independent. */
function normalizeHostnames(hostnames: string[] | undefined): string {
  return (hostnames ?? [])
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0)
    .sort()
    .join(',')
}

/**
 * Detect drift between the deployed mTLS certificate configuration and the
 * live account. Re-finds each declared certificate by name and diffs its
 * associated hostnames; a missing certificate is critical drift.
 *
 * The certificate's PEM content is never diffed — Cloudflare's GET does not
 * return it (only fingerprint/expires_on/created_at/updated_at), so there is
 * nothing to compare it against. Presence + associated_hostnames is everything
 * observable about this object.
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

  const specs = extractMtlsCertificateSpecs(ctx.deployedConfig).filter((s) => s.name && s.associatedHostnames.length > 0)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listCertificates(client)
    const byKey = new Map<string, LiveMtlsCertificate>(
      live.filter((c) => c.name).map((c) => [mtlsCertificateKey(c.name as string), c]),
    )

    for (const spec of specs) {
      const before = diffs.length
      const found = byKey.get(mtlsCertificateKey(spec.name))
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }
      if (normalizeHostnames(found.associated_hostnames) !== normalizeHostnames(spec.associatedHostnames)) {
        diffs.push({
          field: `${spec.name}.associated_hostnames`,
          expected: spec.associatedHostnames.join(', '),
          actual: (found.associated_hostnames ?? []).join(', ') || 'not set',
          severity: 'warning',
        })
      }
      // Attribute every diff this certificate produced to the last human change (once).
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

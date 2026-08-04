import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings, type DnsResolverDomainOverride } from '../../lib/pfsenseApi'
import { domainOverrideKey, extractSpecs, snapshotDomainOverride, toDomainOverrideBody } from './_shared'

export interface RollbackEntry {
  domain: string
  id: number | string | null
  prior: Omit<DnsResolverDomainOverride, 'id'> | null
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { previous?: RollbackEntry[] } | undefined
    return Array.isArray(data?.previous) ? data!.previous : []
  } catch {
    return []
  }
}

/**
 * Deploy DNS Resolver domain overrides:
 *   list:    GET  /api/v2/services/dns_resolver/domain_overrides
 *   create:  POST /api/v2/services/dns_resolver/domain_override
 *   update:  PATCH /api/v2/services/dns_resolver/domain_override
 *   delete (an override this app created but no longer declares):
 *            DELETE /api/v2/services/dns_resolver/domain_override
 *   apply (once, after every write above): POST /api/v2/services/dns_resolver/apply
 *     — its own dedicated endpoint (see lib/pfsenseApi.ts's module doc).
 *
 * IDENTITY: `domain` (case-insensitive) — same upsert/cleanup posture as
 * firewall-aliases' name-keyed pattern (only removes overrides this app
 * created).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readPfsenseSettings(ctx.settings)
  const built = buildPfsenseClient(component, connectivity, credential, settings, connectivityProvider)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const auth = await client.authenticate()
  if (auth.error) return { success: false, message: auth.error }

  const specs = extractSpecs(items).filter((s) => s.domain && s.ip)
  const previous: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await client.listDnsResolverDomainOverrides()
    const liveByDomain = new Map(live.filter((o) => o.domain).map((o) => [domainOverrideKey(o.domain), o]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const match = liveByDomain.get(domainOverrideKey(spec.domain)) ?? null
      const body = toDomainOverrideBody(spec)

      if (match && match.id !== undefined) {
        await client.updateDnsResolverDomainOverride(match.id, body)
        previous.push({ domain: spec.domain, id: match.id, prior: snapshotDomainOverride(match) })
        updated++
      } else {
        const createdOverride = await client.createDnsResolverDomainOverride(body)
        previous.push({ domain: spec.domain, id: createdOverride.id ?? null, prior: null })
        created++
      }
    }

    const declaredDomains = new Set(specs.map((s) => domainOverrideKey(s.domain)))
    for (const p of prior) {
      if (p.prior !== null || declaredDomains.has(domainOverrideKey(p.domain)) || p.id === null) continue
      await client.deleteDnsResolverDomainOverride(p.id)
      deleted++
    }

    if (created > 0 || updated > 0 || deleted > 0) {
      await client.applyDnsResolverChanges()
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} pfSense DNS Resolver domain override(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed.`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Deploy failed after ${created} created, ${updated} updated, ${deleted} removed: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { previous },
    }
  }
}

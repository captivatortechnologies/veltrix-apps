import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings, type DnsResolverHostOverride } from '../../lib/pfsenseApi'
import { extractSpecs, hostOverrideKey, snapshotHostOverride, toHostOverrideBody } from './_shared'

export interface RollbackEntry {
  key: string
  id: number | string | null
  prior: Omit<DnsResolverHostOverride, 'id'> | null
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
 * Deploy DNS Resolver host overrides:
 *   list:    GET  /api/v2/services/dns_resolver/host_overrides
 *   create:  POST /api/v2/services/dns_resolver/host_override
 *   update:  PATCH /api/v2/services/dns_resolver/host_override
 *   delete (an override this app created but no longer declares):
 *            DELETE /api/v2/services/dns_resolver/host_override
 *   apply (once, after every write above): POST /api/v2/services/dns_resolver/apply
 *
 * IDENTITY: composite `host`+`domain` (see _shared.ts's module doc) — same
 * upsert/cleanup posture as firewall-aliases' name-keyed pattern (only
 * removes overrides this app created). `aliases` is always sent as an empty
 * array — see _shared.ts's module doc for the dropped-nested-list scope note.
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

  const specs = extractSpecs(items).filter((s) => s.domain && s.ip.length > 0)
  const previous: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await client.listDnsResolverHostOverrides()
    const liveByKey = new Map(live.filter((o) => o.domain !== undefined).map((o) => [hostOverrideKey(o.host ?? '', o.domain), o]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const key = hostOverrideKey(spec.host, spec.domain)
      const match = liveByKey.get(key) ?? null
      const body = toHostOverrideBody(spec)

      if (match && match.id !== undefined) {
        await client.updateDnsResolverHostOverride(match.id, body)
        previous.push({ key, id: match.id, prior: snapshotHostOverride(match) })
        updated++
      } else {
        const createdOverride = await client.createDnsResolverHostOverride(body)
        previous.push({ key, id: createdOverride.id ?? null, prior: null })
        created++
      }
    }

    const declaredKeys = new Set(specs.map((s) => hostOverrideKey(s.host, s.domain)))
    for (const p of prior) {
      if (p.prior !== null || declaredKeys.has(p.key) || p.id === null) continue
      await client.deleteDnsResolverHostOverride(p.id)
      deleted++
    }

    if (created > 0 || updated > 0 || deleted > 0) {
      await client.applyDnsResolverChanges()
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} pfSense DNS Resolver host override(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed.`,
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

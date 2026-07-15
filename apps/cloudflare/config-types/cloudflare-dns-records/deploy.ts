import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCloudflareClient,
  cloudflareErrorMessage,
  cloudflareResult,
  type CloudflareClient,
} from '../../lib/cloudflare'
import { dnsRecordKey, extractDnsRecordSpecs, type DnsRecordSpec, type LiveDnsRecord } from './validate'

export interface DnsRecordRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveDnsRecord
}

/**
 * Deploy Cloudflare DNS records via the API (zone-scoped).
 *
 * Identity is the (type, name, content) natural key: list /dns_records, match on
 * the key, then PATCH an existing record by id or POST a new one. Cloudflare
 * assigns the server id; we key on the natural tuple so re-runs update rather
 * than duplicate.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  const specs = extractDnsRecordSpecs(ctx.canvas).filter((s) => s.type && s.name && s.content)
  const rollbackState: DnsRecordRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listDnsRecords(client)
    const byKey = new Map(
      existing
        .filter((r) => r.type && r.name && r.content)
        .map((r) => [dnsRecordKey({ type: r.type as string, name: r.name as string, content: r.content as string }), r]),
    )

    for (const spec of specs) {
      const label = `${spec.type} ${spec.name}`
      const key = dnsRecordKey(spec)
      const live = byKey.get(key)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.zone('PATCH', `/dns_records/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) throw new Error(`Failed to update DNS record "${label}": ${cloudflareErrorMessage(res)}`)
      } else {
        const res = await client.zone('POST', '/dns_records', { body: buildPayload(spec) })
        if (!res.ok) throw new Error(`Failed to create DNS record "${label}": ${cloudflareErrorMessage(res)}`)
        const created = cloudflareResult<LiveDnsRecord>(res)
        if (!created?.id) throw new Error(`DNS record "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} DNS record(s) to zone "${domain}": ${deployed.join(', ')}`,
      artifacts: { domain, deployedRecords: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `DNS record deployment failed after ${deployed.length} of ${specs.length} record(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedRecords: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all DNS records in the zone; throws on a non-OK response. */
export async function listDnsRecords(client: CloudflareClient): Promise<LiveDnsRecord[]> {
  const res = await client.zoneGetAll<LiveDnsRecord>('/dns_records')
  if (!res.ok) {
    throw new Error(`Failed to list DNS records: ${cloudflareErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

function buildPayload(spec: DnsRecordSpec): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: spec.type,
    name: spec.name,
    content: spec.content,
    ttl: spec.ttl,
  }
  // proxied is only meaningful for A/AAAA/CNAME; Cloudflare rejects it elsewhere.
  if (spec.type === 'A' || spec.type === 'AAAA' || spec.type === 'CNAME') payload.proxied = spec.proxied
  if ((spec.type === 'MX' || spec.type === 'SRV') && spec.priority !== undefined) payload.priority = spec.priority
  return payload
}

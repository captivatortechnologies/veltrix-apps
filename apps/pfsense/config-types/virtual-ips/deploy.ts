import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings, type VirtualIP } from '../../lib/pfsenseApi'
import { extractSpecs, snapshotVirtualIp, toVirtualIpBody, vipKey } from './_shared'

export interface RollbackEntry {
  subnet: string
  id: number | string | null
  /** Prior managed body, captured before an update — null when THIS deploy created the virtual IP. */
  prior: Omit<VirtualIP, 'id' | 'subnet'> | null
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
 * Deploy virtual IPs over the pfSense REST API package:
 *   list:    GET  /api/v2/firewall/virtual_ips
 *   create:  POST /api/v2/firewall/virtual_ip
 *   update:  PATCH /api/v2/firewall/virtual_ip
 *   delete (a VIP this app created but no longer declares):
 *            DELETE /api/v2/firewall/virtual_ip
 *   apply (once, after every write above): POST /api/v2/firewall/virtual_ip/apply
 *     — SEPARATE endpoint from aliases/rules/port-forwards' shared
 *     /api/v2/firewall/apply (verified — VirtualIP is NOT in
 *     FirewallApply::FIREWALL_SUBSYSTEMS; see lib/pfsenseApi.ts's module doc).
 *
 * IDENTITY: the `subnet` address (unique per pfSense's own model) is the
 * stable identity used to upsert — same pattern as firewall-aliases' `name`.
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

  const specs = extractSpecs(items).filter((s) => s.mode && s.subnet)
  const previous: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await client.listVirtualIps()
    const liveBySubnet = new Map(live.filter((v) => v.subnet).map((v) => [vipKey(v.subnet), v]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const match = liveBySubnet.get(vipKey(spec.subnet)) ?? null
      const body = toVirtualIpBody(spec)

      if (match && match.id !== undefined) {
        await client.updateVirtualIp(match.id, body)
        previous.push({ subnet: spec.subnet, id: match.id, prior: snapshotVirtualIp(match) })
        updated++
      } else {
        const createdVip = await client.createVirtualIp(body)
        previous.push({ subnet: spec.subnet, id: createdVip.id ?? null, prior: null })
        created++
      }
    }

    const declaredSubnets = new Set(specs.map((s) => vipKey(s.subnet)))
    for (const p of prior) {
      if (p.prior !== null || declaredSubnets.has(vipKey(p.subnet)) || p.id === null) continue
      await client.deleteVirtualIp(p.id)
      deleted++
    }

    if (created > 0 || updated > 0 || deleted > 0) {
      await client.applyVirtualIpChanges()
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} pfSense virtual IP(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed.`,
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

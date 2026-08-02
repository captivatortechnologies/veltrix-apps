import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMerakiClient, createVlan, getVlansEnabled, listVlans, updateVlan } from '../../lib/merakiApi'
import { buildVlanBody, extractVlanSpecs, parseJsonObject, type MerakiVlan } from './_shared'

export interface VlanRollbackEntry {
  networkId: string
  id: string
  existed: boolean
  prior?: MerakiVlan
}

/**
 * Deploy Cisco Meraki appliance VLANs over the Dashboard API, reconciled by
 * the caller-chosen VLAN `id` within each network:
 *   list:    GET  /networks/{networkId}/appliance/vlans            → find by id
 *   update:  PUT  /networks/{networkId}/appliance/vlans/{id}        when found
 *   create:  POST /networks/{networkId}/appliance/vlans             when not found
 *
 * PRECONDITION: VLANs must already be ENABLED on the network (an MX ships in
 * single-LAN mode). This app CHECKS that (GET .../vlans/settings) and fails
 * fast with an actionable message rather than letting Meraki's own 400
 * surface — but it deliberately does NOT flip the switch for you: enabling
 * VLANs is a disruptive, one-way-in-practice change to the network's
 * addressing mode that an operator should make deliberately, not as a side
 * effect of a firewall/VLAN deploy.
 *
 * The live list (and the enabled check) is read once per distinct network and
 * reused across every item that targets it. rollbackData records, per item,
 * whether the VLAN existed and its prior full body.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractVlanSpecs(ctx.canvas).filter((s) => s.networkId && s.id)
  const previous: VlanRollbackEntry[] = []
  const deployed: string[] = []
  const enabledByNetwork = new Map<string, boolean>()
  const liveByNetwork = new Map<string, MerakiVlan[]>()

  try {
    for (const spec of specs) {
      const label = `${spec.networkId}/${spec.id}`

      if (!enabledByNetwork.has(spec.networkId)) {
        enabledByNetwork.set(spec.networkId, await getVlansEnabled(client, spec.networkId))
      }
      if (!enabledByNetwork.get(spec.networkId)) {
        throw new Error(
          `VLANs are not enabled on network "${spec.networkId}" — enable them first in the Meraki dashboard ` +
            '(Security & SD-WAN > Addressing & VLANs > "VLANs enabled") before deploying VLAN configuration. ' +
            'This app does not enable VLANs automatically.',
        )
      }

      const { value: advanced, error } = parseJsonObject(spec.advancedRaw, 'advanced')
      if (error || !advanced) throw new Error(`VLAN "${label}": ${error ?? 'invalid advanced settings'}`)

      if (!liveByNetwork.has(spec.networkId)) {
        liveByNetwork.set(spec.networkId, await listVlans(client, spec.networkId))
      }
      const live = liveByNetwork.get(spec.networkId)!
      const match = live.find((v) => String(v.id ?? '').trim() === spec.id)

      if (match) {
        previous.push({ networkId: spec.networkId, id: spec.id, existed: true, prior: match })
        await updateVlan(client, spec.networkId, spec.id, buildVlanBody(spec, advanced, false))
      } else {
        const created = await createVlan(client, spec.networkId, buildVlanBody(spec, advanced, true))
        previous.push({ networkId: spec.networkId, id: spec.id, existed: false })
        live.push(created)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} VLAN(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `VLAN deploy failed after ${deployed.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  }
}

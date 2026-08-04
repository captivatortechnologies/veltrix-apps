import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { extractText } from '../../lib/jamfClassicXml'
import { listComputerGroups, type ComputerGroupRef } from '../smart-computer-groups/deploy'
import { groupKey, indexGroupsByName } from '../smart-computer-groups/validate'
import { buildStaticGroupXml, extractStaticGroupSpecs, parseComputerLookupXml, type StaticGroupMember } from './validate'

const COMPUTER_GROUPS_PATH = '/computergroups'
const COMPUTERS_PATH = '/computers'

export interface StaticGroupRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  /** Full prior `<computer_group>` XML (from a Classic GET before the update), restored byte-for-byte on rollback. */
  priorXml?: string
}

/**
 * Deploy Jamf Pro static computer groups via the Classic API (XML) — see
 * validate.ts header. Identity is the group `name`, matched only against
 * EXISTING STATIC groups (`is_smart === false`) so a same-named smart group
 * is never mistaken for a match. Each declared serial number is resolved to
 * a live computer id via `GET /computers/serialnumber/{sn}` — a serial that
 * does not resolve fails that group's deploy with a clear error.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const specs = extractStaticGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: StaticGroupRollbackEntry[] = []
  const createdIds: string[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const allGroups = await listComputerGroups(client)
    const staticGroups: ComputerGroupRef[] = allGroups.filter((g) => !g.isSmart)
    const byName = indexGroupsByName(staticGroups)

    for (const spec of specs) {
      const label = spec.name
      const key = groupKey(spec.name)
      const live = byName.get(key)

      const members: StaticGroupMember[] = []
      for (const serial of spec.memberSerialNumbers) {
        const res = await client.classicRequest('GET', `${COMPUTERS_PATH}/serialnumber/${encodeURIComponent(serial)}`)
        if (res.error) throw new Error(`Failed to resolve computer with serial number "${serial}": ${res.error}`)
        const resolved = parseComputerLookupXml(res.body)
        if (!resolved.id) throw new Error(`No computer found in Jamf Pro with serial number "${serial}"`)
        members.push({ id: resolved.id, name: resolved.name || serial, serialNumber: resolved.serialNumber || serial })
      }
      const bodyXml = buildStaticGroupXml(spec, members)

      if (live) {
        const priorRes = await client.classicRequest('GET', `${COMPUTER_GROUPS_PATH}/id/${encodeURIComponent(live.id)}`)
        if (priorRes.error) throw new Error(`Failed to read static group "${label}" before updating it: ${priorRes.error}`)
        rollbackState.push({ key, label, existed: true, id: live.id, priorXml: priorRes.body })

        const res = await client.classicRequest('PUT', `${COMPUTER_GROUPS_PATH}/id/${encodeURIComponent(live.id)}`, bodyXml)
        if (res.error) throw new Error(`Failed to update static group "${label}": ${res.error}`)
        updated.push(label)
      } else {
        const res = await client.classicRequest('POST', `${COMPUTER_GROUPS_PATH}/id/0`, bodyXml)
        if (res.error) throw new Error(`Failed to create static group "${label}": ${res.error}`)
        const id = extractText(res.body, 'id')
        if (!id) throw new Error(`Static group "${label}" was created but Jamf Pro returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
        created.push(label)
      }
    }

    return {
      success: true,
      message:
        `Reconciled ${specs.length} Jamf Pro static computer group(s) on ${client.classicBaseUrl}: ` +
        `${created.length} created, ${updated.length} updated.`,
      artifacts: { classicBase: client.classicBaseUrl, createdGroups: created, updatedGroups: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Static computer group deployment failed after ${created.length + updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { classicBase: client.classicBaseUrl, createdGroups: created, updatedGroups: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

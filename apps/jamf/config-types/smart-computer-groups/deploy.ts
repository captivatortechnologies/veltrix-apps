import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient, type JamfClient } from '../../lib/jamfApi'
import { extractAll, extractText } from '../../lib/jamfClassicXml'
import { buildComputerGroupXml, extractSmartGroupSpecs, groupKey, indexGroupsByName } from './validate'

const COMPUTER_GROUPS_PATH = '/computergroups'

/** A computer-group list-item as returned by `GET /JSSResource/computergroups` (Classic API — id/name/is_smart only, no criteria). */
export interface ComputerGroupRef {
  id: string
  name: string
  isSmart: boolean
}

export interface SmartGroupRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  /** Full prior `<computer_group>` XML (from a Classic GET before the update), restored byte-for-byte on rollback. */
  priorXml?: string
}

/**
 * Deploy Jamf Pro smart computer groups via the Classic API (XML) —
 * https://developer.jamf.com/jamf-pro/reference/findcomputergroups,
 * .../findcomputergroupsbyid, .../createcomputergroupbyid,
 * .../updatecomputergroupbyid, .../deletecomputergroupbyid — using the same
 * Bearer-token client as the modern-API config types (`classicRequest`, see
 * lib/jamfApi.ts).
 *
 * Identity is the group `name`: list every computer group, match on the
 * name, and either update the existing group (capturing its full prior XML
 * for rollback) or create a new smart group (`is_smart` is always sent as
 * `true` — this config type only manages smart groups). Created ids are
 * captured for rollback (delete on revert).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const specs = extractSmartGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: SmartGroupRollbackEntry[] = []
  const createdIds: string[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listComputerGroups(client)
    const byName = indexGroupsByName(existing)

    for (const spec of specs) {
      const label = spec.name
      const key = groupKey(spec.name)
      const live = byName.get(key)
      const bodyXml = buildComputerGroupXml(spec)

      if (live) {
        const priorRes = await client.classicRequest('GET', `${COMPUTER_GROUPS_PATH}/id/${encodeURIComponent(live.id)}`)
        if (priorRes.error) throw new Error(`Failed to read smart group "${label}" before updating it: ${priorRes.error}`)
        rollbackState.push({ key, label, existed: true, id: live.id, priorXml: priorRes.body })

        const res = await client.classicRequest('PUT', `${COMPUTER_GROUPS_PATH}/id/${encodeURIComponent(live.id)}`, bodyXml)
        if (res.error) throw new Error(`Failed to update smart group "${label}": ${res.error}`)
        updated.push(label)
      } else {
        const res = await client.classicRequest('POST', `${COMPUTER_GROUPS_PATH}/id/0`, bodyXml)
        if (res.error) throw new Error(`Failed to create smart group "${label}": ${res.error}`)
        const id = extractText(res.body, 'id')
        if (!id) throw new Error(`Smart group "${label}" was created but Jamf Pro returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
        created.push(label)
      }
    }

    return {
      success: true,
      message:
        `Reconciled ${specs.length} Jamf Pro smart computer group(s) on ${client.classicBaseUrl}: ` +
        `${created.length} created, ${updated.length} updated.`,
      artifacts: { classicBase: client.classicBaseUrl, createdGroups: created, updatedGroups: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Smart computer group deployment failed after ${created.length + updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { classicBase: client.classicBaseUrl, createdGroups: created, updatedGroups: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers -----------------------------------------------------------------

/** List every computer group (Classic API — id/name/is_smart only); throws on error. */
export async function listComputerGroups(client: JamfClient): Promise<ComputerGroupRef[]> {
  const res = await client.classicRequest('GET', COMPUTER_GROUPS_PATH)
  if (res.error) throw new Error(`Failed to list Jamf Pro computer groups: ${res.error}`)
  return extractAll(res.body, 'computer_group')
    .map((el) => ({
      id: extractText(el, 'id'),
      name: extractText(el, 'name'),
      isSmart: extractText(el, 'is_smart').toLowerCase() === 'true',
    }))
    .filter((g) => g.id && g.name)
}

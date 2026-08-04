import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient, type JamfClient } from '../../lib/jamfApi'
import {
  classicRefKey,
  extractElement,
  indexRefsByName,
  parseIdNameList,
  refXml,
  replaceTopLevelElement,
  setLeaf,
  tag,
  type ClassicRef,
} from '../../lib/jamfClassicXml'
import { extractProfileSpecs, indexProfilesByName, profileKey, type ProfileSpec } from './validate'

const PROFILES_PATH = '/osxconfigurationprofiles'
const COMPUTER_GROUPS_PATH = '/computergroups'

export interface ProfileRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  /** Full prior `<os_x_configuration_profile>` XML (from a Classic GET before the merge), restored byte-for-byte on rollback. */
  priorXml?: string
}

/**
 * Deploy Jamf Pro macOS configuration profiles via the Classic API (XML) —
 * see validate.ts header for the exact managed field set and the OPAQUE
 * `payloads` passthrough. Uses the same merge-not-replace strategy as
 * Policies/Restricted Software: an update fetches the profile's current full
 * XML and merges only general's managed leaves + a fresh scope into it,
 * leaving `self_service`, `category`, `site`, `uuid`, `redeploy_on_update`
 * and every other section untouched. A create builds a fresh minimal
 * document.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const specs = extractProfileSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ProfileRollbackEntry[] = []
  const createdIds: string[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const [existing, groupByName] = await Promise.all([listProfiles(client), loadGroupRefs(client)])
    const byName = indexProfilesByName(existing)

    for (const spec of specs) {
      const label = spec.name
      const key = profileKey(spec.name)
      const live = byName.get(key)

      if (live) {
        const priorRes = await client.classicRequest('GET', `${PROFILES_PATH}/id/${encodeURIComponent(live.id)}`)
        if (priorRes.error) throw new Error(`Failed to read profile "${label}" before updating it: ${priorRes.error}`)
        rollbackState.push({ key, label, existed: true, id: live.id, priorXml: priorRes.body })

        const mergedXml = mergeProfileXml(priorRes.body, spec, groupByName)
        const res = await client.classicRequest('PUT', `${PROFILES_PATH}/id/${encodeURIComponent(live.id)}`, mergedXml)
        if (res.error) throw new Error(`Failed to update profile "${label}": ${res.error}`)
        updated.push(label)
      } else {
        const createXml = buildProfileCreateXml(spec, groupByName)
        const res = await client.classicRequest('POST', `${PROFILES_PATH}/id/0`, createXml)
        if (res.error) throw new Error(`Failed to create profile "${label}": ${res.error}`)
        const id = extractIdFrom(res.body)
        if (!id) throw new Error(`Profile "${label}" was created but Jamf Pro returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
        created.push(label)
      }
    }

    return {
      success: true,
      message:
        `Reconciled ${specs.length} Jamf Pro macOS configuration profile(s) on ${client.classicBaseUrl}: ` +
        `${created.length} created, ${updated.length} updated.`,
      artifacts: { classicBase: client.classicBaseUrl, createdProfiles: created, updatedProfiles: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Profile deployment failed after ${created.length + updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { classicBase: client.classicBaseUrl, createdProfiles: created, updatedProfiles: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers -----------------------------------------------------------------

/** List every macOS configuration profile (list item tag matches the detail root: `os_x_configuration_profile`). */
export async function listProfiles(client: JamfClient): Promise<ClassicRef[]> {
  const res = await client.classicRequest('GET', PROFILES_PATH)
  if (res.error) throw new Error(`Failed to list Jamf Pro macOS configuration profiles: ${res.error}`)
  return parseIdNameList(res.body, 'os_x_configuration_profile')
}

async function loadGroupRefs(client: JamfClient): Promise<Map<string, ClassicRef>> {
  const res = await client.classicRequest('GET', COMPUTER_GROUPS_PATH)
  if (res.error) throw new Error(`Failed to list Jamf Pro computer groups: ${res.error}`)
  return indexRefsByName(parseIdNameList(res.body, 'computer_group'))
}

function resolveGroup(name: string, byName: Map<string, ClassicRef>): ClassicRef {
  const ref = byName.get(classicRefKey(name))
  if (!ref) throw new Error(`Referenced computer group "${name}" was not found in Jamf Pro`)
  return ref
}

function extractIdFrom(xml: string): string {
  const match = /<id>([^<]+)<\/id>/.exec(xml)
  return match ? match[1].trim() : ''
}

function buildGeneralXml(spec: ProfileSpec): string {
  return (
    '<general>' +
    tag('name', spec.name) +
    tag('description', spec.description) +
    tag('distribution_method', spec.distributionMethod) +
    tag('user_removable', spec.userRemovable) +
    tag('level', spec.level) +
    tag('payloads', spec.payloads) +
    '</general>'
  )
}

function buildScopeXml(spec: ProfileSpec, groupByName: Map<string, ClassicRef>): string {
  const groups = spec.computerGroupNames.map((n) => resolveGroup(n, groupByName))
  const exclGroups = spec.exclusionComputerGroupNames.map((n) => resolveGroup(n, groupByName))
  return (
    '<scope>' +
    tag('all_computers', spec.allComputers) +
    `<computer_groups>${groups.map((g) => refXml('computer_group', g)).join('')}</computer_groups>` +
    `<exclusions><computer_groups>${exclGroups.map((g) => refXml('computer_group', g)).join('')}</computer_groups></exclusions>` +
    '</scope>'
  )
}

/** Fresh minimal `<os_x_configuration_profile>` document for CREATE — only the managed sections. */
export function buildProfileCreateXml(spec: ProfileSpec, groupByName: Map<string, ClassicRef>): string {
  return `<os_x_configuration_profile>${buildGeneralXml(spec)}${buildScopeXml(spec, groupByName)}</os_x_configuration_profile>`
}

/** Merge the managed sections into a profile's existing full XML for UPDATE — self_service, category, site, uuid, etc. are untouched. */
export function mergeProfileXml(priorXml: string, spec: ProfileSpec, groupByName: Map<string, ClassicRef>): string {
  let general = extractElement(priorXml, 'general') ?? '<general></general>'
  general = setLeaf(general, 'name', spec.name, '</general>')
  general = setLeaf(general, 'description', spec.description, '</general>')
  general = setLeaf(general, 'distribution_method', spec.distributionMethod, '</general>')
  general = setLeaf(general, 'user_removable', spec.userRemovable, '</general>')
  general = setLeaf(general, 'level', spec.level, '</general>')
  general = setLeaf(general, 'payloads', spec.payloads, '</general>')

  let merged = replaceTopLevelElement(priorXml, 'general', general, '</os_x_configuration_profile>')
  merged = replaceTopLevelElement(merged, 'scope', buildScopeXml(spec, groupByName), '</os_x_configuration_profile>')
  return merged
}

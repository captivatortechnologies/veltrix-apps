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
import { extractRestrictedSoftwareSpecs, restrictedSoftwareKey, indexRestrictedSoftwareByName, type RestrictedSoftwareSpec } from './validate'

const RESTRICTED_SOFTWARE_PATH = '/restrictedsoftware'
const COMPUTER_GROUPS_PATH = '/computergroups'

export interface RestrictedSoftwareRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  /** Full prior `<restricted_software>` XML (from a Classic GET before the merge), restored byte-for-byte on rollback. */
  priorXml?: string
}

/**
 * Deploy Jamf Pro restricted software records via the Classic API (XML) —
 * see validate.ts header. Manages general (name/process_name/
 * match_exact_process_name/send_notification/kill_process/delete_executable/
 * display_message) and scope (all_computers + computer-group scoping by
 * name), mirroring the merge-not-replace strategy `policies` uses: an update
 * fetches the record's current full XML and merges only these managed
 * sections into it, so nothing else on the record (e.g. its Site) is
 * silently wiped. A create builds a fresh minimal document.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const specs = extractRestrictedSoftwareSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: RestrictedSoftwareRollbackEntry[] = []
  const createdIds: string[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const [existing, groupByName] = await Promise.all([listRestrictedSoftware(client), loadGroupRefs(client)])
    const byName = indexRestrictedSoftwareByName(existing)

    for (const spec of specs) {
      const label = spec.name
      const key = restrictedSoftwareKey(spec.name)
      const live = byName.get(key)

      if (live) {
        const priorRes = await client.classicRequest('GET', `${RESTRICTED_SOFTWARE_PATH}/id/${encodeURIComponent(live.id)}`)
        if (priorRes.error) throw new Error(`Failed to read restricted software "${label}" before updating it: ${priorRes.error}`)
        rollbackState.push({ key, label, existed: true, id: live.id, priorXml: priorRes.body })

        const mergedXml = mergeRestrictedSoftwareXml(priorRes.body, spec, groupByName)
        const res = await client.classicRequest('PUT', `${RESTRICTED_SOFTWARE_PATH}/id/${encodeURIComponent(live.id)}`, mergedXml)
        if (res.error) throw new Error(`Failed to update restricted software "${label}": ${res.error}`)
        updated.push(label)
      } else {
        const createXml = buildRestrictedSoftwareCreateXml(spec, groupByName)
        const res = await client.classicRequest('POST', `${RESTRICTED_SOFTWARE_PATH}/id/0`, createXml)
        if (res.error) throw new Error(`Failed to create restricted software "${label}": ${res.error}`)
        const id = extractIdFrom(res.body)
        if (!id) throw new Error(`Restricted software "${label}" was created but Jamf Pro returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
        created.push(label)
      }
    }

    return {
      success: true,
      message:
        `Reconciled ${specs.length} Jamf Pro restricted software record(s) on ${client.classicBaseUrl}: ` +
        `${created.length} created, ${updated.length} updated.`,
      artifacts: { classicBase: client.classicBaseUrl, createdRestrictedSoftware: created, updatedRestrictedSoftware: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Restricted software deployment failed after ${created.length + updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { classicBase: client.classicBaseUrl, createdRestrictedSoftware: created, updatedRestrictedSoftware: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers -----------------------------------------------------------------

/** List every restricted software record (list items are `<restricted_software_title>`, not `<restricted_software>` — see validate.ts). */
export async function listRestrictedSoftware(client: JamfClient): Promise<ClassicRef[]> {
  const res = await client.classicRequest('GET', RESTRICTED_SOFTWARE_PATH)
  if (res.error) throw new Error(`Failed to list Jamf Pro restricted software: ${res.error}`)
  return parseIdNameList(res.body, 'restricted_software_title')
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

function buildGeneralXml(spec: RestrictedSoftwareSpec): string {
  return (
    '<general>' +
    tag('name', spec.name) +
    tag('process_name', spec.processName) +
    tag('match_exact_process_name', spec.matchExactProcessName) +
    tag('send_notification', spec.sendNotification) +
    tag('kill_process', spec.killProcess) +
    tag('delete_executable', spec.deleteExecutable) +
    tag('display_message', spec.displayMessage) +
    '</general>'
  )
}

function buildScopeXml(spec: RestrictedSoftwareSpec, groupByName: Map<string, ClassicRef>): string {
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

/** Fresh minimal `<restricted_software>` document for CREATE — only the managed sections. */
export function buildRestrictedSoftwareCreateXml(spec: RestrictedSoftwareSpec, groupByName: Map<string, ClassicRef>): string {
  return `<restricted_software>${buildGeneralXml(spec)}${buildScopeXml(spec, groupByName)}</restricted_software>`
}

/** Merge the managed sections into a record's existing full XML for UPDATE — every other section/leaf is untouched. */
export function mergeRestrictedSoftwareXml(priorXml: string, spec: RestrictedSoftwareSpec, groupByName: Map<string, ClassicRef>): string {
  let general = extractElement(priorXml, 'general') ?? '<general></general>'
  general = setLeaf(general, 'name', spec.name, '</general>')
  general = setLeaf(general, 'process_name', spec.processName, '</general>')
  general = setLeaf(general, 'match_exact_process_name', spec.matchExactProcessName, '</general>')
  general = setLeaf(general, 'send_notification', spec.sendNotification, '</general>')
  general = setLeaf(general, 'kill_process', spec.killProcess, '</general>')
  general = setLeaf(general, 'delete_executable', spec.deleteExecutable, '</general>')
  general = setLeaf(general, 'display_message', spec.displayMessage, '</general>')

  let merged = replaceTopLevelElement(priorXml, 'general', general, '</restricted_software>')
  merged = replaceTopLevelElement(merged, 'scope', buildScopeXml(spec, groupByName), '</restricted_software>')
  return merged
}

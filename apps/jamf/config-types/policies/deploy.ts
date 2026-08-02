import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient, type JamfClient } from '../../lib/jamfApi'
import {
  classicRefKey,
  extractElement,
  extractText,
  indexRefsByName,
  parseIdNameList,
  refXml,
  replaceTopLevelElement,
  setLeaf,
  tag,
  type ClassicRef,
} from '../../lib/jamfClassicXml'
import { indexScriptsByName } from '../scripts/validate'
import { listScripts } from '../scripts/deploy'
import {
  extractPolicySpecs,
  policyKey,
  indexPoliciesByName,
  TRIGGER_KEYS,
  type PolicyPackageRef,
  type PolicyScriptRef,
  type PolicySpec,
} from './validate'

const POLICIES_PATH = '/policies'
const COMPUTER_GROUPS_PATH = '/computergroups'
const PACKAGES_PATH = '/packages'

export interface PolicyRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  /** Full prior `<policy>` XML (from a Classic GET before the merge), restored byte-for-byte on rollback. */
  priorXml?: string
}

/** The three name→id lookups a policy's scope/scripts/packages resolve against. */
interface PolicyRefs {
  groupByName: Map<string, ClassicRef>
  scriptByName: Map<string, { id: string; name: string }>
  packageByName: Map<string, ClassicRef>
}

/**
 * Deploy Jamf Pro policies via the Classic API (XML) —
 * https://developer.jamf.com/jamf-pro/reference/findpolicies,
 * .../findpoliciesbyid, .../createpolicybyid, .../updatepolicybyid,
 * .../deletepolicybyid.
 *
 * Manages ONLY general.name/enabled/triggers/frequency, scope, scripts and
 * packages (see validate.ts header). A NEW policy gets a fresh minimal
 * document containing just those sections (Jamf Pro defaults everything
 * else). An EXISTING policy is updated by MERGING those sections into its
 * current full XML (fetched first) — every other section (self_service,
 * maintenance, disk_encryption, …) passes through untouched. The prior full
 * XML is captured for rollback either way.
 *
 * Scope computer groups, scripts and packages are all referenced BY NAME and
 * resolved to live ids here (each must already exist — computer groups via
 * this app's own smart-computer-groups config type or created directly in
 * Jamf Pro; scripts via this app's scripts config type; packages are
 * uploaded binaries this app does not manage). A referenced name that does
 * not resolve fails that policy's deploy with a clear error — never silently
 * dropped.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: PolicyRollbackEntry[] = []
  const createdIds: string[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const [existingPolicies, refs] = await Promise.all([listPolicies(client), loadRefs(client, ctx.settings)])
    const byName = indexPoliciesByName(existingPolicies)

    for (const spec of specs) {
      const label = spec.name
      const key = policyKey(spec.name)
      const live = byName.get(key)

      if (live) {
        const priorRes = await client.classicRequest('GET', `${POLICIES_PATH}/id/${encodeURIComponent(live.id)}`)
        if (priorRes.error) throw new Error(`Failed to read policy "${label}" before updating it: ${priorRes.error}`)
        rollbackState.push({ key, label, existed: true, id: live.id, priorXml: priorRes.body })

        const mergedXml = mergePolicyXml(priorRes.body, spec, refs)
        const res = await client.classicRequest('PUT', `${POLICIES_PATH}/id/${encodeURIComponent(live.id)}`, mergedXml)
        if (res.error) throw new Error(`Failed to update policy "${label}": ${res.error}`)
        updated.push(label)
      } else {
        const createXml = buildPolicyCreateXml(spec, refs)
        const res = await client.classicRequest('POST', `${POLICIES_PATH}/id/0`, createXml)
        if (res.error) throw new Error(`Failed to create policy "${label}": ${res.error}`)
        const id = extractText(res.body, 'id')
        if (!id) throw new Error(`Policy "${label}" was created but Jamf Pro returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
        created.push(label)
      }
    }

    return {
      success: true,
      message:
        `Reconciled ${specs.length} Jamf Pro polic${specs.length === 1 ? 'y' : 'ies'} on ${client.classicBaseUrl}: ` +
        `${created.length} created, ${updated.length} updated.`,
      artifacts: { classicBase: client.classicBaseUrl, createdPolicies: created, updatedPolicies: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Policy deployment failed after ${created.length + updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { classicBase: client.classicBaseUrl, createdPolicies: created, updatedPolicies: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Live listing / name resolution -------------------------------------------

/** List every policy (Classic API — id/name only); throws on error. */
export async function listPolicies(client: JamfClient): Promise<ClassicRef[]> {
  const res = await client.classicRequest('GET', POLICIES_PATH)
  if (res.error) throw new Error(`Failed to list Jamf Pro policies: ${res.error}`)
  return parseIdNameList(res.body, 'policy')
}

/** Load the three name→id lookups a policy's scope/scripts/packages resolve against. */
async function loadRefs(client: JamfClient, settings: Record<string, unknown>): Promise<PolicyRefs> {
  const [groupsRes, packagesRes, scripts] = await Promise.all([
    client.classicRequest('GET', COMPUTER_GROUPS_PATH),
    client.classicRequest('GET', PACKAGES_PATH),
    listScripts(client, settings),
  ])
  if (groupsRes.error) throw new Error(`Failed to list Jamf Pro computer groups: ${groupsRes.error}`)
  if (packagesRes.error) throw new Error(`Failed to list Jamf Pro packages: ${packagesRes.error}`)

  const groupByName = indexRefsByName(parseIdNameList(groupsRes.body, 'computer_group'))
  const packageByName = indexRefsByName(parseIdNameList(packagesRes.body, 'package'))
  const scriptByName = new Map<string, { id: string; name: string }>()
  for (const [key, script] of indexScriptsByName(scripts)) {
    if (script.id && script.name) scriptByName.set(key, { id: script.id, name: script.name })
  }
  return { groupByName, packageByName, scriptByName }
}

/** Resolve a declared name against a ref map; throws with a clear, actionable message when missing. */
function resolveRef<T extends { id: string; name: string }>(kind: string, name: string, byName: Map<string, T>): T {
  const ref = byName.get(classicRefKey(name))
  if (!ref) throw new Error(`Referenced ${kind} "${name}" was not found in Jamf Pro`)
  return ref
}

// --- XML builders --------------------------------------------------------------

function buildGeneralXml(spec: PolicySpec): string {
  const triggerXml = TRIGGER_KEYS.map((k) => tag(k, spec[k])).join('')
  return `<general>${tag('name', spec.name)}${tag('enabled', spec.enabled)}${triggerXml}${tag('frequency', spec.frequency)}</general>`
}

function buildScopeXml(spec: PolicySpec, refs: PolicyRefs): string {
  const groups = spec.computerGroupNames.map((n) => resolveRef('computer group', n, refs.groupByName))
  const exclGroups = spec.exclusionComputerGroupNames.map((n) => resolveRef('computer group', n, refs.groupByName))
  return (
    '<scope>' +
    tag('all_computers', spec.allComputers) +
    `<computer_groups>${groups.map((g) => refXml('computer_group', g)).join('')}</computer_groups>` +
    `<exclusions><computer_groups>${exclGroups.map((g) => refXml('computer_group', g)).join('')}</computer_groups></exclusions>` +
    '</scope>'
  )
}

function buildScriptXml(s: PolicyScriptRef, refs: PolicyRefs): string {
  const ref = resolveRef('script', s.name, refs.scriptByName)
  return `<script>${tag('id', ref.id)}${tag('name', ref.name)}${tag('priority', s.priority)}</script>`
}

function buildScriptsXml(scripts: PolicyScriptRef[], refs: PolicyRefs): string {
  return `<scripts>${scripts.map((s) => buildScriptXml(s, refs)).join('')}</scripts>`
}

function buildPackageXml(p: PolicyPackageRef, refs: PolicyRefs): string {
  const ref = resolveRef('package', p.name, refs.packageByName)
  return `<package>${tag('id', ref.id)}${tag('name', ref.name)}${tag('action', p.action)}</package>`
}

function buildPackageConfigXml(packages: PolicyPackageRef[], refs: PolicyRefs): string {
  return `<package_configuration><packages>${packages.map((p) => buildPackageXml(p, refs)).join('')}</packages></package_configuration>`
}

/** Fresh minimal `<policy>` document for CREATE — only the managed sections. */
export function buildPolicyCreateXml(spec: PolicySpec, refs: PolicyRefs): string {
  return (
    '<policy>' +
    buildGeneralXml(spec) +
    buildScopeXml(spec, refs) +
    buildScriptsXml(spec.scripts, refs) +
    buildPackageConfigXml(spec.packages, refs) +
    '</policy>'
  )
}

/**
 * Merge the managed sections into a policy's existing full XML for UPDATE.
 * `general`'s unmanaged leaves (id, category, trigger_other, …) are preserved
 * by patching only the managed leaves in place; `scope`/`scripts`/
 * `package_configuration` are fully replaced (entirely managed); every other
 * top-level section is untouched because it is never targeted.
 */
export function mergePolicyXml(priorXml: string, spec: PolicySpec, refs: PolicyRefs): string {
  let general = extractElement(priorXml, 'general') ?? '<general></general>'
  general = setLeaf(general, 'name', spec.name, '</general>')
  general = setLeaf(general, 'enabled', spec.enabled, '</general>')
  for (const k of TRIGGER_KEYS) general = setLeaf(general, k, spec[k], '</general>')
  general = setLeaf(general, 'frequency', spec.frequency, '</general>')

  let merged = replaceTopLevelElement(priorXml, 'general', general, '</policy>')
  merged = replaceTopLevelElement(merged, 'scope', buildScopeXml(spec, refs), '</policy>')
  merged = replaceTopLevelElement(merged, 'scripts', buildScriptsXml(spec.scripts, refs), '</policy>')
  merged = replaceTopLevelElement(merged, 'package_configuration', buildPackageConfigXml(spec.packages, refs), '</policy>')
  return merged
}

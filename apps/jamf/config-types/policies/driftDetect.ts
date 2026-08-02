import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { extractElement } from '../../lib/jamfClassicXml'
import { listPolicies } from './deploy'
import {
  extractPolicySpecs,
  indexPoliciesByName,
  parsePolicyGeneralXml,
  parsePolicyPackagesXml,
  parsePolicyScopeXml,
  parsePolicyScriptsXml,
  policyKey,
  TRIGGER_KEYS,
  type PolicyPackageRef,
  type PolicyScriptRef,
} from './validate'

const POLICIES_PATH = '/policies'

/**
 * Detect drift between the deployed policy configuration and the live Jamf
 * Pro tenant, for ONLY the fields this config type manages (general.name/
 * enabled/triggers/frequency, scope, scripts, packages — see validate.ts). A
 * missing policy is critical drift; a changed managed field is a warning.
 * Every OTHER policy section is out of scope and never compared.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listPolicies(client)
    const byName = indexPoliciesByName(live)

    for (const spec of specs) {
      const label = spec.name
      const found = byName.get(policyKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const detailRes = await client.classicRequest('GET', `${POLICIES_PATH}/id/${encodeURIComponent(found.id)}`)
      if (detailRes.error) {
        diffs.push({ field: `${label}`, expected: 'readable', actual: `unreadable: ${detailRes.error}`, severity: 'warning' })
        continue
      }
      const xml = detailRes.body

      const generalXml = extractElement(xml, 'general') ?? ''
      const general = parsePolicyGeneralXml(generalXml)
      if (general.enabled !== spec.enabled) {
        diffs.push({ field: `${label}.enabled`, expected: spec.enabled, actual: general.enabled, severity: 'warning' })
      }
      if (general.frequency !== spec.frequency) {
        diffs.push({ field: `${label}.frequency`, expected: spec.frequency, actual: general.frequency, severity: 'warning' })
      }
      for (const k of TRIGGER_KEYS) {
        if (general[k] !== spec[k]) {
          diffs.push({ field: `${label}.${k}`, expected: spec[k], actual: general[k], severity: 'warning' })
        }
      }

      const scopeXml = extractElement(xml, 'scope') ?? ''
      const scope = parsePolicyScopeXml(scopeXml)
      if (scope.allComputers !== spec.allComputers) {
        diffs.push({ field: `${label}.all_computers`, expected: spec.allComputers, actual: scope.allComputers, severity: 'warning' })
      }
      if (!sameNameSet(scope.groupNames, spec.computerGroupNames)) {
        diffs.push({
          field: `${label}.computer_group_names`,
          expected: spec.computerGroupNames.join(', ') || '(none)',
          actual: scope.groupNames.join(', ') || '(none)',
          severity: 'warning',
        })
      }
      if (!sameNameSet(scope.exclusionGroupNames, spec.exclusionComputerGroupNames)) {
        diffs.push({
          field: `${label}.exclusion_computer_group_names`,
          expected: spec.exclusionComputerGroupNames.join(', ') || '(none)',
          actual: scope.exclusionGroupNames.join(', ') || '(none)',
          severity: 'warning',
        })
      }

      const scriptsXml = extractElement(xml, 'scripts') ?? ''
      const liveScripts = parsePolicyScriptsXml(scriptsXml)
      if (!sameScripts(liveScripts, spec.scripts)) {
        diffs.push({
          field: `${label}.scripts`,
          expected: describeScripts(spec.scripts),
          actual: describeScripts(liveScripts),
          severity: 'warning',
        })
      }

      const packageConfigXml = extractElement(xml, 'package_configuration') ?? ''
      const livePackages = parsePolicyPackagesXml(packageConfigXml)
      if (!samePackages(livePackages, spec.packages)) {
        diffs.push({
          field: `${label}.packages`,
          expected: describePackages(spec.packages),
          actual: describePackages(livePackages),
          severity: 'warning',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'jamf',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Case-insensitive, order-independent set equality for computer group name lists. */
function sameNameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a.map((s) => s.toLowerCase()))
  return b.every((s) => setA.has(s.toLowerCase()))
}

function describeScripts(scripts: PolicyScriptRef[]): string {
  if (scripts.length === 0) return '(none)'
  return scripts.map((s) => `${s.name} (${s.priority})`).join(', ')
}

/** Order-independent equality by name+priority. */
function sameScripts(a: PolicyScriptRef[], b: PolicyScriptRef[]): boolean {
  if (a.length !== b.length) return false
  const key = (s: PolicyScriptRef) => `${s.name.toLowerCase()}|${s.priority}`
  const setA = new Set(a.map(key))
  return b.every((s) => setA.has(key(s)))
}

function describePackages(packages: PolicyPackageRef[]): string {
  if (packages.length === 0) return '(none)'
  return packages.map((p) => `${p.name} (${p.action})`).join(', ')
}

/** Order-independent equality by name+action. */
function samePackages(a: PolicyPackageRef[], b: PolicyPackageRef[]): boolean {
  if (a.length !== b.length) return false
  const key = (p: PolicyPackageRef) => `${p.name.toLowerCase()}|${p.action}`
  const setA = new Set(a.map(key))
  return b.every((p) => setA.has(key(p)))
}

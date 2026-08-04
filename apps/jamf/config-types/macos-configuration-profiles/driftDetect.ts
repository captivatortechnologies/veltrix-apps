import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { extractElement } from '../../lib/jamfClassicXml'
import { listProfiles } from './deploy'
import { extractProfileSpecs, indexProfilesByName, parseProfileGeneralXml, parseProfileScopeXml, profileKey } from './validate'

const PROFILES_PATH = '/osxconfigurationprofiles'

/**
 * Detect drift between the deployed profile configuration and the live Jamf
 * Pro tenant, for ONLY the managed fields (general subset + scope — see
 * validate.ts header). A missing profile or a changed `payloads` (the actual
 * plist content) is critical drift; any other changed managed field is a
 * warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractProfileSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listProfiles(client)
    const byName = indexProfilesByName(live)

    for (const spec of specs) {
      const label = spec.name
      const found = byName.get(profileKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const detailRes = await client.classicRequest('GET', `${PROFILES_PATH}/id/${encodeURIComponent(found.id)}`)
      if (detailRes.error) {
        diffs.push({ field: label, expected: 'readable', actual: `unreadable: ${detailRes.error}`, severity: 'warning' })
        continue
      }
      const xml = detailRes.body

      const general = parseProfileGeneralXml(extractElement(xml, 'general') ?? '')
      if (general.payloads !== spec.payloads) {
        diffs.push({ field: `${label}.payloads`, expected: '(declared plist)', actual: '(live plist differs)', severity: 'critical' })
      }
      diffField(diffs, label, 'description', spec.description, general.description)
      diffField(diffs, label, 'distribution_method', spec.distributionMethod, general.distributionMethod)
      diffBool(diffs, label, 'user_removable', spec.userRemovable, general.userRemovable)
      diffField(diffs, label, 'level', spec.level, general.level)

      const scope = parseProfileScopeXml(extractElement(xml, 'scope') ?? '')
      diffBool(diffs, label, 'all_computers', spec.allComputers, scope.allComputers)
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

function diffField(diffs: DriftDiff[], label: string, field: string, expected: string, actual: string): void {
  if (expected === actual) return
  diffs.push({ field: `${label}.${field}`, expected: expected || '(empty)', actual: actual || '(empty)', severity: 'warning' })
}

function diffBool(diffs: DriftDiff[], label: string, field: string, expected: boolean, actual: boolean): void {
  if (expected === actual) return
  diffs.push({ field: `${label}.${field}`, expected, actual, severity: 'warning' })
}

function sameNameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a.map((s) => s.toLowerCase()))
  return b.every((s) => setA.has(s.toLowerCase()))
}

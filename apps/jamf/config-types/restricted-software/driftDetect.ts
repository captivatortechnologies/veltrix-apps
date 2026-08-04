import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { extractElement } from '../../lib/jamfClassicXml'
import { listRestrictedSoftware } from './deploy'
import {
  extractRestrictedSoftwareSpecs,
  indexRestrictedSoftwareByName,
  parseRestrictedSoftwareGeneralXml,
  parseRestrictedSoftwareScopeXml,
  restrictedSoftwareKey,
} from './validate'

const RESTRICTED_SOFTWARE_PATH = '/restrictedsoftware'

/**
 * Detect drift between the deployed restricted-software configuration and
 * the live Jamf Pro tenant, for ONLY the managed fields (general + scope —
 * see validate.ts header). A missing record is critical drift; a changed
 * managed field is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractRestrictedSoftwareSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listRestrictedSoftware(client)
    const byName = indexRestrictedSoftwareByName(live)

    for (const spec of specs) {
      const label = spec.name
      const found = byName.get(restrictedSoftwareKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const detailRes = await client.classicRequest('GET', `${RESTRICTED_SOFTWARE_PATH}/id/${encodeURIComponent(found.id)}`)
      if (detailRes.error) {
        diffs.push({ field: label, expected: 'readable', actual: `unreadable: ${detailRes.error}`, severity: 'warning' })
        continue
      }
      const xml = detailRes.body

      const general = parseRestrictedSoftwareGeneralXml(extractElement(xml, 'general') ?? '')
      diffField(diffs, label, 'process_name', spec.processName, general.processName)
      diffBool(diffs, label, 'match_exact_process_name', spec.matchExactProcessName, general.matchExactProcessName)
      diffBool(diffs, label, 'send_notification', spec.sendNotification, general.sendNotification)
      diffBool(diffs, label, 'kill_process', spec.killProcess, general.killProcess)
      diffBool(diffs, label, 'delete_executable', spec.deleteExecutable, general.deleteExecutable)
      diffField(diffs, label, 'display_message', spec.displayMessage, general.displayMessage)

      const scope = parseRestrictedSoftwareScopeXml(extractElement(xml, 'scope') ?? '')
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

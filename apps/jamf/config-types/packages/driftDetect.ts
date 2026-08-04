import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { listCategories } from '../categories/deploy'
import { categoryKey } from '../categories/validate'
import { listPackages } from './deploy'
import { extractPackageSpecs, indexPackagesByName, packageKey } from './validate'

const BOOLEAN_FIELDS = [
  'fillUserTemplate',
  'fillExistingUsers',
  'rebootRequired',
  'osInstall',
  'suppressUpdates',
  'suppressFromDock',
  'suppressEula',
  'suppressRegistration',
  'ignoreConflicts',
] as const

/**
 * Detect drift between the deployed package metadata and the live Jamf Pro
 * tenant. A missing package is critical drift; a changed metadata field
 * (including the resolved category, compared by NAME) is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractPackageSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const [live, categories] = await Promise.all([listPackages(client, ctx.settings), listCategories(client, ctx.settings)])
    const byName = indexPackagesByName(live)
    const categoryNameById = new Map(categories.filter((c) => c.id && c.name).map((c) => [c.id as string, c.name as string]))

    for (const spec of specs) {
      const label = spec.name
      const found = byName.get(packageKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveCategoryName = (found.categoryId && categoryNameById.get(found.categoryId)) || found.categoryId || ''
      if (categoryKey(liveCategoryName) !== categoryKey(spec.categoryName)) {
        diffs.push({ field: `${label}.category_name`, expected: spec.categoryName, actual: liveCategoryName || '(none)', severity: 'warning' })
      }

      diffField(diffs, label, 'fileName', spec.fileName, found.fileName ?? '')
      diffField(diffs, label, 'priority', String(spec.priority), String(found.priority ?? ''))
      diffField(diffs, label, 'info', spec.info, found.info ?? '')
      diffField(diffs, label, 'notes', spec.notes, found.notes ?? '')
      diffField(diffs, label, 'osRequirements', spec.osRequirements, found.osRequirements ?? '')
      diffField(diffs, label, 'installLanguage', spec.installLanguage, found.installLanguage ?? '')

      for (const key of BOOLEAN_FIELDS) {
        const expected = spec[key]
        const actual = found[key] ?? false
        if (expected !== actual) {
          diffs.push({ field: `${label}.${key}`, expected, actual, severity: 'warning' })
        }
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

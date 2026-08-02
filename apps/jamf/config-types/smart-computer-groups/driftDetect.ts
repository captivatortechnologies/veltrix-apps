import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { listComputerGroups } from './deploy'
import { extractSmartGroupSpecs, groupKey, indexGroupsByName, parseComputerGroupXml, type Criterion } from './validate'

const COMPUTER_GROUPS_PATH = '/computergroups'

/**
 * Detect drift between the deployed smart-group configuration and the live
 * Jamf Pro tenant. Re-finds each declared group by name; a missing group is
 * critical drift. For a found group, fetches its full detail (the list
 * endpoint has no criteria) and diffs the criteria set as a whole — any
 * change is a warning, since a single reordered/edited criterion changes the
 * group's entire matching logic rather than one independent field.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractSmartGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listComputerGroups(client)
    const byName = indexGroupsByName(live)

    for (const spec of specs) {
      const label = spec.name
      const found = byName.get(groupKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const detailRes = await client.classicRequest('GET', `${COMPUTER_GROUPS_PATH}/id/${encodeURIComponent(found.id)}`)
      if (detailRes.error) {
        diffs.push({
          field: `${label}.criteria`,
          expected: 'readable',
          actual: `unreadable: ${detailRes.error}`,
          severity: 'warning',
        })
        continue
      }
      const liveGroup = parseComputerGroupXml(detailRes.body)
      if (!sameCriteria(spec.criteria, liveGroup.criteria)) {
        diffs.push({
          field: `${label}.criteria`,
          expected: describeCriteria(spec.criteria),
          actual: describeCriteria(liveGroup.criteria),
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

function describeCriteria(criteria: Criterion[]): string {
  if (criteria.length === 0) return '(none)'
  return criteria
    .map((c) => `${c.andOr} ${c.name} ${c.searchType} "${c.value}"${c.openingParen ? ' (' : ''}${c.closingParen ? ' )' : ''}`)
    .join(' | ')
}

/** Order-sensitive equality (criteria order changes evaluation, since `and_or`/parens are positional). */
function sameCriteria(a: Criterion[], b: Criterion[]): boolean {
  if (a.length !== b.length) return false
  return a.every((c, i) => {
    const o = b[i]
    return (
      c.name === o.name &&
      c.andOr === o.andOr &&
      c.searchType === o.searchType &&
      c.value === o.value &&
      c.openingParen === o.openingParen &&
      c.closingParen === o.closingParen
    )
  })
}

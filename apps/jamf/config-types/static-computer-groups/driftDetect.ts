import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { extractAll, extractElement, extractText } from '../../lib/jamfClassicXml'
import { listComputerGroups } from '../smart-computer-groups/deploy'
import { groupKey, indexGroupsByName } from '../smart-computer-groups/validate'
import { extractStaticGroupSpecs } from './validate'

const COMPUTER_GROUPS_PATH = '/computergroups'

/**
 * Detect drift between the deployed static-group configuration and the live
 * Jamf Pro tenant. Re-finds each declared group by name among STATIC groups
 * only; a missing group is critical drift. For a found group, fetches its
 * full detail (the list endpoint has no membership) and diffs the member
 * serial-number set — order-independent, since Classic membership order
 * carries no semantic meaning (unlike a smart group's ordered criteria).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractStaticGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const allGroups = await listComputerGroups(client)
    const byName = indexGroupsByName(allGroups.filter((g) => !g.isSmart))

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
          field: `${label}.members`,
          expected: 'readable',
          actual: `unreadable: ${detailRes.error}`,
          severity: 'warning',
        })
        continue
      }
      const computersBlock = extractElement(detailRes.body, 'computers')
      const liveSerials = computersBlock
        ? extractAll(computersBlock, 'computer').map((el) => extractText(el, 'serial_number')).filter(Boolean)
        : []
      if (!sameStringSet(liveSerials, spec.memberSerialNumbers)) {
        diffs.push({
          field: `${label}.member_serial_numbers`,
          expected: spec.memberSerialNumbers.join(', ') || '(none)',
          actual: liveSerials.join(', ') || '(none)',
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

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a.map((s) => s.toLowerCase()))
  return b.every((s) => setA.has(s.toLowerCase()))
}

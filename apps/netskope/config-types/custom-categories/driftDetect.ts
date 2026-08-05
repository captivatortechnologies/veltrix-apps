import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildNetskopeClient, readNetskopeSettings, resolveNetskopeCredential } from '../../lib/netskope'
import { extractCustomCategorySpecs, type LiveCustomCategory } from './validate'

const BASE = '/profiles/customcategories'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractCustomCategorySpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveCustomCategory>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((c) => c.name).map((c) => [c.name!.toLowerCase(), c]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.description ?? '') !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: live.description ?? '', severity: 'warning' })
    }
    const pairs: Array<[string, string[], string[] | undefined]> = [
      ['included_predefined_categories', spec.includedPredefinedCategories, live.included_predefined_categories],
      ['included_url_lists', spec.includedUrlLists, live.included_url_lists],
      ['excluded_url_lists', spec.excludedUrlLists, live.excluded_url_lists],
      ['included_destination_profiles', spec.includedDestinationProfiles, live.included_destination_profiles],
      ['excluded_destination_profiles', spec.excludedDestinationProfiles, live.excluded_destination_profiles],
    ]
    // Declared entries are resolved names; live entries are ids — a full
    // value comparison would always mismatch. Compare COUNTS only, which
    // still surfaces additions/removals without false positives on names.
    for (const [field, declared, liveArr] of pairs) {
      const liveCount = (liveArr ?? []).length
      if (declared.length !== liveCount) {
        diffs.push({ field: `${spec.name}.${field}`, expected: String(declared.length), actual: String(liveCount), severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

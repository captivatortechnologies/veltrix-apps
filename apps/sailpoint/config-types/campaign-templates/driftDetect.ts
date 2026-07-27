import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import { extractCampaignTemplateSpecs, type LiveCampaignTemplate } from './validate'

const BASE = '/v3/campaign-templates'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractCampaignTemplateSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveCampaignTemplate>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((t) => t.name).map((t) => [t.name!.toLowerCase(), t]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (((live.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: live.description ?? '', severity: 'warning' })
    }
    if (spec.deadlineDuration && ((live.deadlineDuration ?? '') as string) !== spec.deadlineDuration) {
      diffs.push({ field: `${spec.name}.deadlineDuration`, expected: spec.deadlineDuration, actual: live.deadlineDuration ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

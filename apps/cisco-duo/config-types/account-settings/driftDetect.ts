import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDuoClient, readDuoSettings, resolveDuoCredential } from '../../lib/duo'
import { extractAccountSettingsSpecs, serializeLiveSetting, serializeSetting, SETTING_FIELDS } from './validate'
import { readSettings } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildDuoClient(cred, settings)

  const specs = extractAccountSettingsSpecs(ctx.deployedConfig)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }
  const spec = specs[0]

  let live: Record<string, unknown>
  try {
    live = await readSettings(client)
  } catch {
    return { hasDrift: false, diffs: [] }
  }

  const diffs: Diffs = []
  for (const def of SETTING_FIELDS) {
    const raw = spec.values[def.key]
    if (raw === undefined) continue
    const expected = serializeSetting(def, raw)
    const actual = serializeLiveSetting(def, live[def.key])
    if (expected !== actual) {
      diffs.push({ field: `settings.${def.key}`, expected, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

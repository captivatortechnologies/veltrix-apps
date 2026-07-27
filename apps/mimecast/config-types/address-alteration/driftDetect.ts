import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMimecastClient, readMimecastSettings, resolveMimecastCredential } from '../../lib/mimecast'
import { extractAddressAlterationSpecs, type LivePolicy } from './validate'
import { definitionEquals } from './deploy'

const GET_ALL = '/api/policy/address-alteration/get-policy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readMimecastSettings(ctx.settings)
  const cred = resolveMimecastCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildMimecastClient(cred, settings)

  const specs = extractAddressAlterationSpecs(ctx.deployedConfig).filter((s) => s.description)
  const listed = await client.request(GET_ALL, {})
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByDesc = new Map<string, LivePolicy>()
  for (const p of listed.data as LivePolicy[]) {
    const d = p.policy?.description
    if (d) liveByDesc.set(d.toLowerCase(), p)
  }

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByDesc.get(spec.description.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.description, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!definitionEquals(live, spec)) {
      if ((live.addressAlterationSetId ?? '') !== spec.addressAlterationSetId) {
        diffs.push({ field: `${spec.description}.addressAlterationSetId`, expected: spec.addressAlterationSetId, actual: live.addressAlterationSetId ?? '', severity: 'warning' })
      } else if ((live.policy?.fromPart ?? 'envelope_from') !== spec.fromPart) {
        diffs.push({ field: `${spec.description}.fromPart`, expected: spec.fromPart, actual: live.policy?.fromPart ?? '', severity: 'warning' })
      } else if ((live.policy?.enabled ?? true) !== spec.enabled) {
        diffs.push({ field: `${spec.description}.enabled`, expected: String(spec.enabled), actual: String(live.policy?.enabled ?? true), severity: 'warning' })
      } else {
        diffs.push({ field: `${spec.description}.from/to`, expected: `${spec.fromType}/${spec.toType}`, actual: `${live.policy?.from?.type ?? ''}/${live.policy?.to?.type ?? ''}`, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

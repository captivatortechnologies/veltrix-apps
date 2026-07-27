import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMimecastClient, readMimecastSettings, resolveMimecastCredential } from '../../lib/mimecast'
import { extractAntiSpoofingBypassSpecs, type LivePolicy } from './validate'
import { definitionEquals, normDomains } from './deploy'

const GET_ALL = '/api/policy/antispoofing-bypass/get-policy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readMimecastSettings(ctx.settings)
  const cred = resolveMimecastCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildMimecastClient(cred, settings)

  const specs = extractAntiSpoofingBypassSpecs(ctx.deployedConfig).filter((s) => s.description)
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
      if ((live.option ?? '') !== spec.option) {
        diffs.push({ field: `${spec.description}.option`, expected: spec.option, actual: live.option ?? '', severity: 'warning' })
      } else if (normDomains(live.conditions?.spfDomains) !== normDomains(spec.spfDomains)) {
        diffs.push({ field: `${spec.description}.spfDomains`, expected: spec.spfDomains.join(', ') || '(none)', actual: (live.conditions?.spfDomains ?? []).join(', ') || '(none)', severity: 'warning' })
      } else {
        diffs.push({ field: `${spec.description}.from/to`, expected: `${spec.fromType}/${spec.toType}`, actual: `${live.policy?.from?.type ?? ''}/${live.policy?.to?.type ?? ''}`, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

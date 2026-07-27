import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import { extractVerifiedFromAddressSpecs, type LiveVerifiedFromAddress } from './validate'

const BASE = '/beta/verified-from-addresses'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractVerifiedFromAddressSpecs(ctx.deployedConfig).filter((s) => s.email)
  const listed = await client.getAll<LiveVerifiedFromAddress>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByEmail = new Map(listed.items.filter((a) => a.email).map((a) => [a.email!.toLowerCase(), a]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByEmail.get(spec.email.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.email, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const verified = live.verified ?? live.isVerified ?? false
    if (!verified) {
      diffs.push({ field: `${spec.email}.verified`, expected: 'verified', actual: 'pending', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

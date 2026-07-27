import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildNetskopeClient, readNetskopeSettings, resolveNetskopeCredential } from '../../lib/netskope'
import { extractLocalBrokerSpecs, type LiveLocalBroker } from './validate'

const BASE = '/infrastructure/lbrokers'
const LIST_KEY = 'lbrokers'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractLocalBrokerSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAllNpa<LiveLocalBroker>(BASE, LIST_KEY)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((b) => b.local_broker_name).map((b) => [b.local_broker_name!.toLowerCase(), b]))

  // Registration/dns_host state is runtime read-only and is not diffed.
  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.access_via_public_ip ?? 'NONE') !== spec.accessViaPublicIp) {
      diffs.push({ field: `${spec.name}.access_via_public_ip`, expected: spec.accessViaPublicIp, actual: live.access_via_public_ip ?? 'NONE', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

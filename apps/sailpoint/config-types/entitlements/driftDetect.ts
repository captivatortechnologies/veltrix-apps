import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, parseJson, readIscSettings, resolveIscCredential } from '../../lib/isc'
import type { LiveSource } from '../sources/validate'
import { buildEntitlementFilter } from './deploy'
import { extractEntitlementSpecs, type LiveEntitlement } from './validate'

const SOURCES = '/v3/sources'
const ENTITLEMENTS = '/beta/entitlements'

type Diffs = DriftResult['diffs']

function idSet(ids: string[]): string {
  return [...ids].sort().join(',')
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractEntitlementSpecs(ctx.deployedConfig).filter((s) => s.sourceName && s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const sourcesRes = await client.getAll<LiveSource>(SOURCES)
  if (!sourcesRes.ok) return { hasDrift: false, diffs: [] }
  const sourceByName = new Map(sourcesRes.items.filter((s) => s.name && s.id).map((s) => [s.name!.toLowerCase(), s]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const label = `${spec.sourceName}/${spec.name}`
    const source = sourceByName.get(spec.sourceName.toLowerCase())
    if (!source?.id) {
      diffs.push({ field: label, expected: 'present', actual: 'source absent', severity: 'critical' })
      continue
    }

    const filter = buildEntitlementFilter(source.id, spec.name, spec.attribute)
    const resp = await client.get(`${ENTITLEMENTS}?filters=${encodeURIComponent(filter)}&limit=2`)
    if (!resp.ok) {
      diffs.push({ field: label, expected: 'reachable', actual: 'unreadable', severity: 'warning' })
      continue
    }
    const matches = parseJson<LiveEntitlement[]>(resp.body) ?? []
    if (matches.length !== 1) {
      diffs.push({ field: label, expected: 'present', actual: matches.length === 0 ? 'absent' : 'ambiguous', severity: 'critical' })
      continue
    }
    const live = matches[0]

    if (((live.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${label}.description`, expected: spec.description, actual: live.description ?? '', severity: 'warning' })
    }
    if ((live.requestable ?? false) !== spec.requestable) {
      diffs.push({ field: `${label}.requestable`, expected: String(spec.requestable), actual: String(live.requestable ?? false), severity: 'warning' })
    }
    if ((live.privileged ?? false) !== spec.privileged) {
      diffs.push({ field: `${label}.privileged`, expected: String(spec.privileged), actual: String(live.privileged ?? false), severity: 'warning' })
    }
    if (spec.ownerId && (live.owner?.id ?? '') !== spec.ownerId) {
      diffs.push({ field: `${label}.owner`, expected: spec.ownerId, actual: live.owner?.id ?? '', severity: 'warning' })
    }
    const liveSegments = idSet(live.segments ?? [])
    if (liveSegments !== idSet(spec.segments)) {
      diffs.push({ field: `${label}.segments`, expected: idSet(spec.segments), actual: liveSegments, severity: 'warning' })
    }
    if ((live.manuallyUpdatedFields?.DISPLAY_NAME ?? false) !== spec.lockDisplayName) {
      diffs.push({ field: `${label}.lockDisplayName`, expected: String(spec.lockDisplayName), actual: String(live.manuallyUpdatedFields?.DISPLAY_NAME ?? false), severity: 'info' })
    }
    if ((live.manuallyUpdatedFields?.DESCRIPTION ?? false) !== spec.lockDescription) {
      diffs.push({ field: `${label}.lockDescription`, expected: String(spec.lockDescription), actual: String(live.manuallyUpdatedFields?.DESCRIPTION ?? false), severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

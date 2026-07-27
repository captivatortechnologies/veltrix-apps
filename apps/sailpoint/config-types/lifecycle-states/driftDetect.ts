import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import type { LiveIdentityProfile } from '../identity-profiles/validate'
import { extractLifecycleStateSpecs, type LiveLifecycleState } from './validate'

const PROFILES = '/v3/identity-profiles'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractLifecycleStateSpecs(ctx.deployedConfig).filter((s) => s.name && s.profileName && s.technicalName)
  const profilesRes = await client.getAll<LiveIdentityProfile>(PROFILES)
  if (!profilesRes.ok) return { hasDrift: false, diffs: [] }
  const profileByName = new Map(profilesRes.items.filter((p) => p.name && p.id).map((p) => [p.name!.toLowerCase(), p]))

  const childCache = new Map<string, Map<string, LiveLifecycleState>>()
  const diffs: Diffs = []
  for (const spec of specs) {
    const profile = profileByName.get(spec.profileName.toLowerCase())
    if (!profile?.id) {
      diffs.push({ field: `${spec.profileName}/${spec.technicalName}`, expected: 'present', actual: 'profile absent', severity: 'critical' })
      continue
    }
    let children = childCache.get(profile.id)
    if (!children) {
      const listed = await client.getAll<LiveLifecycleState>(`${PROFILES}/${profile.id}/lifecycle-states`)
      children = new Map(listed.items.filter((s) => s.technicalName).map((s) => [s.technicalName!.toLowerCase(), s]))
      childCache.set(profile.id, children)
    }
    const live = children.get(spec.technicalName.toLowerCase())
    if (!live) {
      diffs.push({ field: `${spec.profileName}/${spec.technicalName}`, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.enabled ?? false) !== spec.enabled) {
      diffs.push({ field: `${spec.profileName}/${spec.technicalName}.enabled`, expected: String(spec.enabled), actual: String(live.enabled ?? false), severity: 'warning' })
    }
    if (((live.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.profileName}/${spec.technicalName}.description`, expected: spec.description, actual: live.description ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

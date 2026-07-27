import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMimecastClient, readMimecastSettings, resolveMimecastCredential } from '../../lib/mimecast'
import { extractAddressAlterationSetSpecs } from './validate'
import { extractSets } from './deploy'

const GET_ALL = '/api/policy/address-alteration/get-address-alteration-set'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readMimecastSettings(ctx.settings)
  const cred = resolveMimecastCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildMimecastClient(cred, settings)

  const specs = extractAddressAlterationSetSpecs(ctx.deployedConfig).filter((s) => s.description)
  const listed = await client.request(GET_ALL, {})
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const live = extractSets(listed.data)

  const diffs: Diffs = []
  for (const spec of specs) {
    const desc = spec.description.toLowerCase()
    const found = spec.parentId
      ? live.some((s) => (s.description ?? '').toLowerCase() === desc && s.parentId === spec.parentId)
      : live.some((s) => (s.description ?? '').toLowerCase() === desc)
    if (!found) {
      diffs.push({ field: spec.description, expected: 'present', actual: 'absent', severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

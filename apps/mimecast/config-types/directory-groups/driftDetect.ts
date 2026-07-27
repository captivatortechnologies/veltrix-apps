import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMimecastClient, readMimecastSettings, resolveMimecastCredential } from '../../lib/mimecast'
import { extractDirectoryGroupSpecs, liveMemberIdentity, memberIdentity, type LiveGroup } from './validate'
import { extractGroups, extractMembers } from './deploy'

const FIND = '/api/directory/find-groups'
const GET_MEMBERS = '/api/directory/get-group-members'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readMimecastSettings(ctx.settings)
  const cred = resolveMimecastCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildMimecastClient(cred, settings)

  const specs = extractDirectoryGroupSpecs(ctx.deployedConfig).filter((s) => s.description)

  const diffs: Diffs = []
  for (const spec of specs) {
    const resp = await client.request(FIND, { query: spec.description })
    const desc = spec.description.toLowerCase()
    const groups = resp.ok ? extractGroups(resp.data) : []
    const found: LiveGroup | undefined = spec.parentId
      ? groups.find((g) => (g.description ?? '').toLowerCase() === desc && g.parentId === spec.parentId)
      : groups.find((g) => (g.description ?? '').toLowerCase() === desc)

    if (!found?.id) {
      diffs.push({ field: spec.description, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    const membersResp = await client.request(GET_MEMBERS, { id: found.id })
    const live = new Set(membersResp.ok ? extractMembers(membersResp.data).map(liveMemberIdentity) : [])
    const desired = spec.members.map(memberIdentity)
    const missing = desired.filter((id) => !live.has(id))
    if (missing.length) {
      diffs.push({ field: `${spec.description}.members`, expected: desired.join(', '), actual: [...live].join(', '), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

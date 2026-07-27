import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildMimecastClient,
  mimecastErrorMessage,
  readMimecastSettings,
  resolveMimecastCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/mimecast'
import { liveMemberIdentity } from './validate'
import { extractMembers, type RollbackEntry } from './deploy'

const DELETE_GROUP = '/api/directory/delete-group'
const GET_MEMBERS = '/api/directory/get-group-members'
const REMOVE_MEMBER = '/api/directory/remove-group-member'

function memberBody(groupId: string, identity: string): Record<string, unknown> {
  const idx = identity.indexOf(':')
  const kind = identity.slice(0, idx)
  const value = identity.slice(idx + 1)
  return kind === 'email' ? { id: groupId, emailAddress: value } : { id: groupId, domain: value }
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readMimecastSettings(ctx.settings)
  const cred = resolveMimecastCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildMimecastClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let deleted = 0
  let restored = 0

  for (const e of entries) {
    if (!e.id) continue
    if (!e.existed) {
      // App-created group — empty its members, then delete it.
      const membersResp = await client.request(GET_MEMBERS, { id: e.id })
      if (membersResp.ok) {
        for (const m of extractMembers(membersResp.data)) {
          await client.request(REMOVE_MEMBER, memberBody(e.id, liveMemberIdentity(m)))
        }
      }
      const del = await client.request(DELETE_GROUP, { id: e.id })
      if (!del.ok) failures.push(`delete ${e.name}: ${mimecastErrorMessage(del)}`)
      else deleted++
    } else {
      // Adopted group — remove only the members this app added.
      for (const id of e.addedMembers ?? []) {
        const resp = await client.request(REMOVE_MEMBER, memberBody(e.id, id))
        if (!resp.ok) failures.push(`restore ${e.name}: ${mimecastErrorMessage(resp)}`)
        else restored++
      }
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back directory groups: ${deleted} deleted, ${restored} member(s) removed` }
}

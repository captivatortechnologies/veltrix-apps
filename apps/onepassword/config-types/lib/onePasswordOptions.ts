import type { OptionItem, OptionsProvider } from '@veltrixsecops/app-sdk'
import { buildOnePasswordClient, scimErrorMessage } from '../../lib/onePassword'
import type { LiveUser } from '../users/validate'

/**
 * Live options provider for the onepassword app. Powers the Groups config
 * type's `members` remote-multiselect field via GET /api/apps/onepassword/
 * config-options. The platform resolves the connection and runs this
 * in-process, so it can call the SCIM Bridge directly with the decrypted
 * bearer token.
 *
 * Source "users": every user on the bridge (GET /Users), mapped to
 * `{ value: userName, label: userName [+ display name] }` - Groups declare
 * members by email (SCIM userName), which config-types/groups/deploy.ts
 * resolves to the bridge's internal user id at deploy time (ids are opaque
 * and would be meaningless if hand-edited via the canvas JSON; email is the
 * stable, human-legible identity used everywhere else in this app).
 */
const onePasswordOptions: OptionsProvider = async (ctx): Promise<OptionItem[]> => {
  if (ctx.source !== 'users') return []

  const built = buildOnePasswordClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) throw new Error(built.error)
  const { client } = built

  const res = await client.listAll<LiveUser>('/Users')
  if (!res.ok) {
    throw new Error(`Failed to list 1Password users: ${scimErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }

  const options = res.items
    .filter((u): u is LiveUser & { userName: string } => typeof u.userName === 'string' && u.userName.length > 0)
    .map((u) => {
      const display = [u.name?.givenName, u.name?.familyName].filter(Boolean).join(' ')
      return {
        value: u.userName,
        label: display ? `${u.userName} (${display})` : u.userName,
        description: u.active === false ? 'suspended' : undefined,
      }
    })

  const query = (ctx.query ?? '').trim().toLowerCase()
  return query ? options.filter((o) => o.label.toLowerCase().includes(query)) : options
}

export default onePasswordOptions

import { checkAuth } from '../lib/api.mjs'
import { getProfile } from '../lib/config.mjs'

export async function whoamiCommand(options) {
  const profile = getProfile(options.profile)
  if (!profile) {
    console.error('✖ Not logged in. Run `veltrix login` first.')
    process.exit(1)
  }

  try {
    const identity = await checkAuth(profile)
    // The API key's access is governed by its RBAC role; `permissions` lists the
    // grants that role confers (what the key can actually do). Fall back to the
    // raw `scopes` for older servers that don't return permissions.
    const grants = identity.permissions?.length ? identity.permissions : identity.scopes
    console.log(`url:      ${profile.url}`)
    console.log(`customer: ${identity.customerId}`)
    console.log(`type:     ${identity.type ?? 'api-key'}`)
    console.log(`role:     ${identity.role ?? '(none)'}`)
    console.log(`scopes:   ${grants?.join(', ') || '(none)'}`)
  } catch (e) {
    console.error(`✖ ${e.message}`)
    process.exit(1)
  }
}

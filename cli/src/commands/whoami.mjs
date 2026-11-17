import { checkAuth, describeExpiry, getOrganization } from '../lib/api.mjs'
import { getProfile } from '../lib/config.mjs'

export async function whoamiCommand(options) {
  const profile = getProfile(options.profile)
  if (!profile) {
    console.error('✖ Not logged in. Run `veltrix login` first.')
    process.exit(1)
  }

  try {
    // The platform reports only whether the key is valid and when it expires.
    // What the key may do is decided by its bound RBAC role, which is managed
    // in the portal (Settings → Keys & Tokens) and not listed over the API.
    const keyStatus = await checkAuth(profile)
    const organization = await getOrganization(profile)
    console.log(`url:      ${profile.url}`)
    console.log(`tenant:   ${organization ? `${organization.name} (${organization.id})` : '(not readable with this key)'}`)
    console.log(`key:      ${keyStatus.valid ? 'valid' : 'invalid'}`)
    console.log(`expires:  ${describeExpiry(keyStatus.expiresAt)}`)
  } catch (e) {
    console.error(`✖ ${e.message}`)
    process.exit(1)
  }
}

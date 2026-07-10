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
    console.log(`url:      ${profile.url}`)
    console.log(`customer: ${identity.customerId}`)
    console.log(`type:     ${identity.type ?? 'api-key'}`)
    console.log(`scopes:   ${identity.scopes?.join(', ') || '(none)'}`)
  } catch (e) {
    console.error(`✖ ${e.message}`)
    process.exit(1)
  }
}

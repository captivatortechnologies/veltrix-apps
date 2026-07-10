import { deleteProfile } from '../lib/config.mjs'

export async function logoutCommand(options) {
  if (deleteProfile(options.profile)) {
    console.log(`✔ Logged out (profile "${options.profile}" removed)`)
  } else {
    console.log(`Nothing to do — no stored profile "${options.profile}"`)
  }
}

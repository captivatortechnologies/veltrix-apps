import readline from 'node:readline'
import { checkAuth } from '../lib/api.mjs'
import { setProfile, configPath } from '../lib/config.mjs'

/** Prompt for a secret without echoing it. */
function promptSecret(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const write = rl._writeToOutput.bind(rl)
    rl._writeToOutput = (s) => {
      // Echo the prompt itself, mask everything typed after it
      if (s.includes(question)) write(s)
      else write('*')
    }
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

export async function loginCommand(options) {
  const url = options.url.replace(/\/+$/, '')
  const apiKey =
    options.apiKey ||
    process.env.VELTRIX_API_KEY ||
    (await promptSecret(`API key for ${url} (create one in Settings → Keys & Tokens): `))

  if (!apiKey) {
    console.error('✖ No API key provided')
    process.exit(1)
  }

  const profile = { url, apiKey }
  let identity
  try {
    identity = await checkAuth(profile)
  } catch (e) {
    console.error(`✖ Authentication failed: ${e.message}`)
    process.exit(1)
  }

  setProfile(options.profile, profile)
  console.log(`✔ Logged in to ${url}`)
  console.log(`  customer: ${identity.customerId}`)
  console.log(`  scopes:   ${identity.scopes?.join(', ') || '(none)'}`)
  console.log(`  saved to: ${configPath()} (profile "${options.profile}")`)
}

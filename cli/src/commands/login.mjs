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
      // Release stdin. readline resumes the stdin stream, and on Windows a
      // still-closing libuv handle plus an abrupt process.exit() aborts with:
      //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), win/async.c
      // Pausing (and unref'ing) lets the handle finish closing and lets the
      // event loop drain on its own.
      process.stdin.pause()
      process.stdin.unref?.()
      process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

/** Actionable next step for a failed auth attempt, based on the HTTP status. */
function authFailureHint(error, url) {
  // status 0 = the platform could not be reached at all (DNS/TLS/refused).
  if (error.status === 0 || error.status >= 500) {
    return [
      `  The platform at ${url} is not responding (the request never reached the API).`,
      '  If you meant to target a local dev server, retry with:',
      '    veltrix login --url http://localhost:5000',
    ].join('\n')
  }
  if (error.status === 401 || error.status === 403) {
    return '  The API key is invalid, revoked, or missing the required scopes — create a new one in Settings → Keys & Tokens.'
  }
  if (error.status === 404) {
    return `  ${url} does not expose the Veltrix API (no /api/auth/api-key/check). Check the --url value.`
  }
  return null
}

export async function loginCommand(options) {
  const url = options.url.replace(/\/+$/, '')
  const apiKey =
    options.apiKey ||
    process.env.VELTRIX_API_KEY ||
    (await promptSecret(`API key for ${url} (create one in Settings → Keys & Tokens): `))

  if (!apiKey) {
    console.error('✖ No API key provided')
    // Set the exit code rather than calling process.exit(): an abrupt exit while
    // the stdin handle from promptSecret is still closing aborts the process on
    // Windows (UV_HANDLE_CLOSING assertion).
    process.exitCode = 1
    return
  }

  const profile = { url, apiKey }
  let identity
  try {
    identity = await checkAuth(profile)
  } catch (e) {
    console.error(`✖ Authentication failed: ${e.message}`)
    const hint = authFailureHint(e, url)
    if (hint) console.error(hint)
    process.exitCode = 1
    return
  }

  setProfile(options.profile, profile)
  console.log(`✔ Logged in to ${url}`)
  console.log(`  customer: ${identity.customerId}`)
  console.log(`  scopes:   ${identity.scopes?.join(', ') || '(none)'}`)
  console.log(`  saved to: ${configPath()} (profile "${options.profile}")`)
}

// ============================================================================
// `veltrix sandbox` — create / list / delete / run.
//
// Sandboxes are addressed by NAME on the command line (unique per tenant);
// commands resolve name → id through the list endpoint.
// ============================================================================

import readline from 'node:readline'
import { getProfile } from '../lib/config.mjs'
import {
  createSandbox,
  listSandboxes,
  deleteSandbox,
  runHandler,
  resolveSandboxByName,
  improveSandboxError,
} from '../lib/sandbox-api.mjs'
import { ApiError } from '../lib/api.mjs'
import {
  c,
  paintStatus,
  formatBytes,
  formatRelative,
  renderTable,
  printRunResult,
} from '../lib/output.mjs'

export function requireProfile(options) {
  const profile = getProfile(options.profile)
  if (!profile) {
    console.error('✖ Not logged in. Run `veltrix login` first.')
    process.exit(1)
  }
  return profile
}

export function failWith(error) {
  improveSandboxError(error)
  console.error(`✖ ${error.message}`)
  if (error.hint) console.error(c.dim(`  ${error.hint}`))
  process.exit(1)
}

async function mustResolveSandbox(profile, name) {
  const sandbox = await resolveSandboxByName(profile, name)
  if (!sandbox) {
    console.error(`✖ No sandbox named "${name}" — see \`veltrix sandbox list\``)
    process.exit(1)
  }
  return sandbox
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(/^y(es)?$/i.test(answer.trim()))
    })
  })
}

// ---------------------------------------------------------------------------
// veltrix sandbox create <name> --app <app-id>
// ---------------------------------------------------------------------------

export async function sandboxCreateCommand(name, options) {
  const profile = requireProfile(options)
  try {
    const sandbox = await createSandbox(profile, name, options.app)
    console.log(`${c.green('✔')} Sandbox ${c.bold(sandbox.name)} created for app ${c.bold(sandbox.appId)}`)
    console.log(c.dim(`  id:      ${sandbox.id}`))
    console.log(c.dim(`  expires: ${formatRelative(sandbox.expiresAt)} (renewed on every sync)`))
    console.log(`\nStart the dev loop with:`)
    console.log(`  ${c.cyan(`veltrix dev ./${sandbox.appId} --sandbox ${sandbox.name}`)}`)
  } catch (error) {
    failWith(error)
  }
}

// ---------------------------------------------------------------------------
// veltrix sandbox list
// ---------------------------------------------------------------------------

export async function sandboxListCommand(options) {
  const profile = requireProfile(options)
  try {
    const sandboxes = await listSandboxes(profile)
    if (sandboxes.length === 0) {
      console.log('No sandboxes yet. Create one with `veltrix sandbox create <name> --app <app-id>`.')
      return
    }
    renderTable(
      ['NAME', 'APP', 'STATUS', 'FILES', 'SIZE', 'LAST SYNC', 'EXPIRES'],
      sandboxes.map((sandbox) => [
        sandbox.name,
        sandbox.appId,
        { text: sandbox.status, paint: paintStatus(sandbox.status) },
        String(sandbox.fileCount ?? 0),
        formatBytes(sandbox.sizeBytes ?? 0),
        formatRelative(sandbox.lastSyncAt),
        formatRelative(sandbox.expiresAt),
      ]),
    )
  } catch (error) {
    failWith(error)
  }
}

// ---------------------------------------------------------------------------
// veltrix sandbox delete <name> [--yes]
// ---------------------------------------------------------------------------

export async function sandboxDeleteCommand(name, options) {
  const profile = requireProfile(options)
  try {
    const sandbox = await mustResolveSandbox(profile, name)

    if (!options.yes) {
      if (!process.stdin.isTTY) {
        console.error('✖ Refusing to delete without confirmation — pass --yes in non-interactive contexts')
        process.exit(1)
      }
      const ok = await confirm(
        `Delete sandbox "${sandbox.name}" (app ${sandbox.appId}, ${sandbox.fileCount ?? 0} files)? [y/N] `,
      )
      if (!ok) {
        console.log('Aborted.')
        return
      }
    }

    await deleteSandbox(profile, sandbox.id)
    console.log(`${c.green('✔')} Sandbox ${c.bold(sandbox.name)} deleted`)
  } catch (error) {
    failWith(error)
  }
}

// ---------------------------------------------------------------------------
// veltrix sandbox run <name> <config-type-id> <handler>
// ---------------------------------------------------------------------------

export async function sandboxRunCommand(name, configTypeId, handler, options) {
  const profile = requireProfile(options)
  try {
    const sandbox = await mustResolveSandbox(profile, name)
    console.log(c.dim(`Running ${configTypeId}:${handler} in sandbox ${sandbox.name}…`))
    const result = await runHandler(profile, sandbox.id, configTypeId, handler)
    printRunResult(result, { configTypeId, handler })
    // exitCode (not process.exit) — exiting with live keep-alive sockets
    // trips a libuv assertion on Windows.
    if (result && result.ok === false) process.exitCode = 1
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      // The sandbox resolved a moment ago, so a 404 here means the /run
      // route itself is absent: this platform predates the sandbox runner.
      console.error('✖ This platform does not support remote sandbox runs yet')
      console.error(c.dim('  Handler execution ships with the platform\'s sandbox runner — until your tenant is upgraded, use `veltrix dev` to sync and validate.'))
      process.exitCode = 1
      return
    }
    failWith(error)
  }
}

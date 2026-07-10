// ============================================================================
// `veltrix dev [dir] --sandbox <name>` — the live development loop.
//
//   startup:  local validate → resolve (or --create) the sandbox → full sync
//   watch:    chokidar → 300 ms debounce → local validate → manifest POST
//             (server answers {upload, delete}) → tar.gz delta PUT → print
//             the server's validation summary
//   extras:   --run <configTypeId>:<handler> invokes the handler after each
//             successful sync; --logs streams sandbox events over Socket.IO
//             when the platform accepts the connection (falls back silently)
//
// Resilience: connection errors, 409s and transient 5xxs trigger one
// automatic full resync (the protocol is stateless client-side — POSTing
// the full manifest again IS the resync). A deleted sandbox is recreated
// when --create was passed; an expired sandbox (410) ends the session.
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import chokidar from 'chokidar'
import { validateApp } from '../lib/validator.mjs'
import { ApiError } from '../lib/api.mjs'
import {
  createSandbox,
  postManifest,
  putFiles,
  runHandler,
  resolveSandboxByName,
  improveSandboxError,
  isSandboxMissingError,
} from '../lib/sandbox-api.mjs'
import {
  loadIgnoreRules,
  buildManifest,
  selectUploadEntries,
  createTarball,
  isDefaultExcluded,
  isIgnored,
  toPosix,
} from '../lib/sync.mjs'
import { connectLiveLogs } from '../lib/live-logs.mjs'
import { c, printRunResult, formatLogEntry } from '../lib/output.mjs'
import { requireProfile, failWith } from './sandbox.mjs'

const DEBOUNCE_MS = 300
const RESYNC_BACKOFF_MS = 1000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRunSpec(spec) {
  const separator = spec.indexOf(':')
  const configTypeId = separator === -1 ? '' : spec.slice(0, separator).trim()
  const handler = separator === -1 ? '' : spec.slice(separator + 1).trim()
  if (!configTypeId || !handler) {
    console.error(`✖ Invalid --run value "${spec}" — expected <configTypeId>:<handler>, e.g. indexes:validate`)
    process.exit(1)
  }
  return { configTypeId, handler }
}

function readManifestAppId(appDir) {
  try {
    const manifest = yaml.load(fs.readFileSync(path.join(appDir, 'manifest.yaml'), 'utf8'))
    return typeof manifest?.id === 'string' ? manifest.id : null
  } catch {
    return null
  }
}

/** Run the local validator; print findings compactly. Returns true when clean. */
function runLocalValidation(appDir) {
  const { errors, warnings } = validateApp(appDir)
  for (const warning of warnings) console.log(`  ${c.yellow('⚠')} ${warning}`)
  if (errors.length > 0) {
    for (const error of errors) console.error(`  ${c.red('✖')} ${error}`)
    console.error(
      `${c.red('✖')} local validation failed (${errors.length} error${errors.length === 1 ? '' : 's'}) — fix and save to retry`,
    )
    return false
  }
  return true
}

function timestamp() {
  return c.dim(new Date().toLocaleTimeString())
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Sync cycle
// ---------------------------------------------------------------------------

/**
 * One manifest → diff → delta-upload pass. The client always POSTs its full
 * manifest, so every pass doubles as a full resync. If the server requests
 * a file that vanished locally mid-walk, rebuild the manifest once.
 */
async function syncOnce(profile, sandbox, appDir) {
  const startedAt = Date.now()

  const build = async () => {
    const rules = loadIgnoreRules(appDir)
    const entries = buildManifest(appDir, rules)
    const diff = await postManifest(profile, sandbox.id, entries)
    return { entries, diff, ...selectUploadEntries(entries, diff.upload) }
  }

  let pass = await build()
  if (pass.missing.length > 0) {
    pass = await build() // files changed between walk and diff — one retry
    if (pass.missing.length > 0) {
      throw new ApiError(0, `files disappeared during sync: ${pass.missing.join(', ')}`)
    }
  }

  let response = null
  if (pass.selected.length > 0) {
    const tarball = await createTarball(appDir, pass.selected.map((entry) => entry.path))
    response = await putFiles(profile, sandbox.id, tarball)
  }

  return {
    uploaded: pass.selected.length,
    deleted: pass.diff.delete.length,
    totalFiles: pass.entries.length,
    response,
    durationMs: Date.now() - startedAt,
  }
}

function printSyncOutcome(outcome) {
  const parts = []
  if (outcome.uploaded > 0) parts.push(`↑ ${outcome.uploaded} file${outcome.uploaded === 1 ? '' : 's'}`)
  if (outcome.deleted > 0) parts.push(`✕ ${outcome.deleted} deleted`)
  if (parts.length === 0) parts.push('already in sync')
  const summary = `${parts.join(', ')} in ${outcome.durationMs}ms`

  const validation = outcome.response?.validation
  if (!validation) {
    console.log(`${timestamp()} ${c.green('✔')} ${summary}`)
    return
  }

  if (validation.valid) {
    const warnings =
      validation.warnings.length > 0
        ? `, ${validation.warnings.length} warning${validation.warnings.length === 1 ? '' : 's'}`
        : ''
    const transpiled = validation.transpiledCount > 0 ? `, ${validation.transpiledCount} transpiled` : ''
    console.log(`${timestamp()} ${c.green('✔')} ${summary} — server validation passed${warnings}${transpiled}`)
  } else {
    console.log(`${timestamp()} ${c.red('✖')} ${summary} — server validation FAILED`)
  }
  for (const warning of validation.warnings) console.log(`    ${c.yellow('⚠')} ${warning}`)
  for (const error of validation.errors) console.log(`    ${c.red('✖')} ${error}`)
}

/** Errors where an immediate full resync is worth one automatic attempt. */
function isRecoverable(error) {
  if (!(error instanceof ApiError)) return false
  if (error.status === 0) return true // connection error
  if (error.status === 409) return true // state mismatch
  if (error.status >= 500) return true // transient server failure
  return false
}

/**
 * Sync with automatic recovery. Mutates ctx.sandbox when a deleted sandbox
 * is recreated (--create). Throws only errors the caller must handle
 * (fatal 410, unrecoverable failures).
 */
async function syncWithRecovery(ctx) {
  const { profile, appDir, options } = ctx
  try {
    return await syncOnce(profile, ctx.sandbox, appDir)
  } catch (error) {
    if (error instanceof ApiError && error.status === 410) throw error // expired: fatal

    if (isSandboxMissingError(error)) {
      if (!options.create) throw error
      console.log(c.yellow(`⚠ Sandbox "${options.sandbox}" is gone — recreating (--create)`))
      ctx.sandbox = await createSandbox(profile, options.sandbox, ctx.appId)
      return syncOnce(profile, ctx.sandbox, appDir)
    }

    if (isRecoverable(error)) {
      console.log(c.dim(`  sync interrupted (${error.message}) — full resync in ${RESYNC_BACKOFF_MS / 1000}s`))
      await sleep(RESYNC_BACKOFF_MS)
      return syncOnce(profile, ctx.sandbox, appDir)
    }

    throw error
  }
}

// ---------------------------------------------------------------------------
// --run
// ---------------------------------------------------------------------------

async function invokeRun(ctx) {
  const { profile, runSpec, state } = ctx
  if (!runSpec || state.runUnsupported) return
  try {
    const result = await runHandler(profile, ctx.sandbox.id, runSpec.configTypeId, runSpec.handler)
    printRunResult(result, runSpec)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && !isSandboxMissingError(error)) {
      state.runUnsupported = true
      console.log(
        c.yellow('⚠ This platform does not support remote sandbox runs yet — skipping --run for this session'),
      )
      return
    }
    improveSandboxError(error)
    console.error(`${c.red('✖')} run ${runSpec.configTypeId}:${runSpec.handler} failed: ${error.message}`)
    if (error.hint) console.error(c.dim(`  ${error.hint}`))
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function devCommand(dir, options) {
  const profile = requireProfile(options)
  const appDir = path.resolve(dir)
  const runSpec = options.run ? parseRunSpec(options.run) : null

  console.log(c.bold(`veltrix dev`))
  console.log(c.dim(`  app:     ${appDir}`))
  console.log(c.dim(`  sandbox: ${options.sandbox} @ ${profile.url}`))

  // 1. The app must be locally valid before anything touches the network.
  if (!runLocalValidation(appDir)) process.exit(1)

  const appId = readManifestAppId(appDir)
  if (!appId) {
    console.error('✖ Could not read manifest.yaml — is this an app directory?')
    process.exit(1)
  }

  // 2. Resolve (or create) the sandbox.
  let sandbox
  try {
    sandbox = await resolveSandboxByName(profile, options.sandbox)
    if (!sandbox && options.create) {
      sandbox = await createSandbox(profile, options.sandbox, appId)
      console.log(`${c.green('✔')} Created sandbox ${c.bold(sandbox.name)} for app ${sandbox.appId}`)
    }
  } catch (error) {
    failWith(error)
  }
  if (!sandbox) {
    console.error(`✖ No sandbox named "${options.sandbox}"`)
    console.error(
      c.dim(`  Create it with \`veltrix sandbox create ${options.sandbox} --app ${appId}\` or rerun with --create`),
    )
    process.exit(1)
  }
  if (sandbox.appId !== appId) {
    console.log(
      c.yellow(`⚠ Sandbox "${sandbox.name}" was created for app "${sandbox.appId}" but this directory is "${appId}"`),
    )
  }

  const ctx = { profile, appDir, appId, options, runSpec, sandbox, state: { runUnsupported: false } }

  // 3. Initial full sync.
  console.log(c.dim('Performing initial sync…'))
  try {
    const outcome = await syncWithRecovery(ctx)
    printSyncOutcome(outcome)
    if (outcome.response?.validation?.valid !== false) await invokeRun(ctx)
  } catch (error) {
    failWith(error)
  }

  // 4. Optional live event stream (degrades to sync-response output).
  let liveLogs = null
  if (options.logs) {
    liveLogs = connectLiveLogs(profile, {
      sandboxId: ctx.sandbox.id,
      onConnected: () => console.log(c.dim('⇢ live log stream connected')),
      onUnavailable: (reason) =>
        console.log(c.dim(`⇢ live logs unavailable (${reason}) — showing sync results only`)),
      onEvent: (eventName, payload) => {
        if (eventName === 'sandbox:log') {
          console.log(`  ${c.dim('⇢')} ${formatLogEntry(payload.entry ?? payload)}`)
        } else if (eventName === 'sandbox:status' && payload.status === 'ERROR') {
          console.log(`  ${c.dim('⇢')} ${c.red('sandbox ERROR')}${payload.message ? ` — ${payload.message}` : ''}`)
        }
        // sandbox:synced mirrors the sync HTTP response we already print.
      },
    })
  }

  // 5. Watch → debounce → validate → sync.
  const watchRules = loadIgnoreRules(appDir)
  const watcher = chokidar.watch(appDir, {
    ignoreInitial: true,
    ignored: (watchedPath, stats) => {
      const rel = path.relative(appDir, watchedPath)
      if (!rel || rel.startsWith('..')) return false
      const posix = toPosix(rel)
      if (posix.split('/').some(isDefaultExcluded)) return true
      return isIgnored(posix, watchRules, stats?.isDirectory() ?? false)
    },
  })

  let debounceTimer = null
  let syncing = false
  let rerunAfter = false

  const scheduleSync = () => {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      void runCycle()
    }, DEBOUNCE_MS)
  }

  const runCycle = async () => {
    if (syncing) {
      rerunAfter = true
      return
    }
    syncing = true
    try {
      if (!runLocalValidation(appDir)) return // keep watching
      const outcome = await syncWithRecovery(ctx)
      printSyncOutcome(outcome)
      if (outcome.response?.validation?.valid !== false) await invokeRun(ctx)
    } catch (error) {
      improveSandboxError(error)
      if (error instanceof ApiError && (error.status === 410 || isSandboxMissingError(error))) {
        // Nothing a retry can fix: the sandbox itself is gone.
        console.error(`${c.red('✖')} ${error.message}`)
        console.error(c.dim(`  ${error.hint || 'Recreate it with `veltrix sandbox create` (or rerun `veltrix dev --create`).'}`))
        await shutdown(1)
        return
      }
      console.error(`${c.red('✖')} sync failed: ${error.message} — still watching`)
      if (error.hint) console.error(c.dim(`  ${error.hint}`))
    } finally {
      syncing = false
      if (rerunAfter) {
        rerunAfter = false
        scheduleSync()
      }
    }
  }

  watcher.on('all', (event) => {
    if (['add', 'change', 'unlink', 'addDir', 'unlinkDir'].includes(event)) scheduleSync()
  })
  watcher.on('error', (error) => {
    console.error(`${c.red('✖')} watcher error: ${error.message}`)
  })
  watcher.on('ready', () => {
    console.log(c.dim('Watching for changes… (Ctrl+C to stop)'))
    // Edits made while chokidar was still scanning are folded into the
    // (suppressed) initial add events — one reconciling sync closes that gap.
    scheduleSync()
  })

  // 6. Clean shutdown.
  const shutdown = async (code = 0) => {
    clearTimeout(debounceTimer)
    liveLogs?.close()
    try {
      await watcher.close()
    } catch {
      // closing is best-effort
    }
    process.exit(code)
  }
  process.on('SIGINT', () => {
    console.log(`\n${c.dim('Stopping veltrix dev…')}`)
    void shutdown(0)
  })
  process.on('SIGTERM', () => void shutdown(0))
}

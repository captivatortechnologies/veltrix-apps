// Configuration drift from the CLI: list a config's drift, run an on-demand
// check (async — polls to completion), and read/set the scheduled-check
// frequency (tenant default + per-app overrides).

import { getProfile } from '../lib/config.mjs'
import {
  getCanvasDrift,
  checkCanvasDrift,
  getDriftSchedule,
  setDriftSchedule,
  clearDriftSchedule,
} from '../lib/deploy-api.mjs'
import { c } from '../lib/output.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function requireProfile(options) {
  const profile = getProfile(options.profile)
  if (!profile) {
    console.error('✖ Not logged in. Run `veltrix login` first.')
    process.exit(1)
  }
  return profile
}

function fail(message, hint) {
  console.error(`✖ ${message}`)
  if (hint) console.error(c.dim(`  ${hint}`))
  process.exit(1)
}

function paintSeverity(sev) {
  if (sev === 'critical') return c.red(sev)
  if (sev === 'warning') return c.yellow(sev)
  return c.dim(sev ?? 'info')
}

function printDrift(body) {
  const records = body.data ?? []
  if (records.length === 0) {
    console.log(c.green('✔ No drift.'))
    return
  }
  const open = records.filter((r) => !r.resolvedAt && r.status !== 'resolved' && r.status !== 'acknowledged')
  console.log(`${records.length} drift record(s)${open.length ? `, ${c.yellow(`${open.length} unresolved`)}` : ''}:`)
  for (const r of records) {
    const sev = r.severity ?? r.diffs?.[0]?.severity
    const where = r.component?.hostname ?? r.componentId ?? '?'
    console.log(`  ${paintSeverity(sev)}  ${where}  ${r.status ?? 'unresolved'}  ${c.dim(r.detectedAt ?? '')}`)
  }
}

/** veltrix drift list <canvasId> — drift records + the async check state for one config. */
export async function driftListCommand(id, options) {
  const profile = requireProfile(options)
  const body = await getCanvasDrift(profile, id)
  console.log(`Check state: ${body.checkState ?? 'IDLE'}${body.lastDriftCheckAt ? c.dim(`  (last: ${body.lastDriftCheckAt})`) : ''}`)
  printDrift(body)
}

/** veltrix drift check <canvasId> — queue an on-demand check, poll to completion, print results. */
export async function driftCheckCommand(id, options) {
  const profile = requireProfile(options)
  const res = await checkCanvasDrift(profile, id)
  if (res.queued) {
    process.stdout.write('Checking drift')
    const deadline = Date.now() + 120_000
    let body = await getCanvasDrift(profile, id)
    while (body.checkState === 'CHECKING' && Date.now() < deadline) {
      process.stdout.write('.')
      await sleep(2_000)
      body = await getCanvasDrift(profile, id)
    }
    process.stdout.write('\n')
    if (body.checkState === 'CHECKING') console.log(c.yellow('Still running — results will appear shortly.'))
    printDrift(body)
  } else {
    printDrift({ data: res.data ?? [] })
  }
}

/**
 * veltrix drift schedule — show, or with --set/--clear change, the drift-check
 * frequency. --app scopes to a per-app override (else the tenant default).
 */
export async function driftScheduleCommand(options) {
  const profile = requireProfile(options)
  if (options.clear) {
    if (!options.app) fail('--clear needs --app <appId> (only a per-app override can be cleared).')
    await clearDriftSchedule(profile, options.app)
    console.log(`✔ Cleared the per-app override for ${options.app} — it now inherits the tenant default.`)
    return
  }
  if (options.set) {
    await setDriftSchedule(profile, options.set, options.app)
    console.log(`✔ Drift schedule ${options.app ? `for ${options.app}` : '(tenant default)'} = ${c.bold(options.set)}.`)
    return
  }
  const s = await getDriftSchedule(profile)
  console.log(`Tenant default: ${c.bold(s.tenantDefault)}`)
  const perApp = Object.entries(s.perApp ?? {})
  if (perApp.length) {
    console.log('Per-app overrides:')
    for (const [app, freq] of perApp) console.log(`  ${app}: ${freq}`)
  } else {
    console.log(c.dim('No per-app overrides.'))
  }
  console.log(c.dim(`Options: ${(s.options ?? ['off', 'hourly', 'daily', 'weekly']).join(' | ')}`))
}

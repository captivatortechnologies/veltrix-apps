// ============================================================================
// Read-only inspection commands over the Veltrix API — the discovery half of
// `veltrix deploy`. They let you find valid deploy inputs (which apps/config
// types exist, which environments, which existing canvases and their status)
// without leaving the terminal. All authenticate with the stored API key.
// ============================================================================

import { getProfile } from '../lib/config.mjs'
import { listApps, listEnvironments, listCanvases, getCanvas } from '../lib/deploy-api.mjs'
import { c, renderTable, paintStatus } from '../lib/output.mjs'

function requireProfile(options) {
  const profile = getProfile(options.profile)
  if (!profile) {
    console.error('✖ Not logged in. Run `veltrix login` first.')
    process.exit(1)
  }
  return profile
}

function fail(error) {
  console.error(`✖ ${error.message}`)
  process.exit(1)
}

/** `veltrix apps` — installed + enabled apps (valid deploy `app`/toolType values). */
export async function appsCommand(options) {
  const profile = requireProfile(options)
  try {
    const apps = await listApps(profile)
    if (!apps.length) {
      console.log('No enabled apps.')
      return
    }
    renderTable(
      ['APP ID', 'NAME', 'VERSION'],
      apps.map((a) => [a.appId ?? a.id ?? '?', a.name ?? '', a.version ?? '']),
    )
  } catch (error) {
    fail(error)
  }
}

/** `veltrix env` — environments (valid deploy `environment` names + Tag ids). */
export async function envCommand(options) {
  const profile = requireProfile(options)
  try {
    const envs = await listEnvironments(profile)
    if (!envs.length) {
      console.log('No environments.')
      return
    }
    renderTable(
      ['NAME', 'TAG ID'],
      envs.map((e) => [e.name ?? '', e.id ?? '']),
    )
  } catch (error) {
    fail(error)
  }
}

/** `veltrix config list` — configuration canvases and their status. */
export async function configListCommand(options) {
  const profile = requireProfile(options)
  try {
    const canvases = await listCanvases(profile)
    if (!canvases.length) {
      console.log('No configuration canvases yet. Create one with `veltrix deploy <spec>`.')
      return
    }
    renderTable(
      ['ID', 'NAME', 'APP', 'TYPE', 'STATUS', 'VER'],
      canvases.map((cv) => [
        cv.id ?? '',
        cv.name ?? '',
        cv.toolType ?? '',
        cv.entityType ?? '',
        { text: cv.status ?? '', paint: paintStatus(cv.status) },
        String(cv.version ?? ''),
      ]),
    )
  } catch (error) {
    fail(error)
  }
}

/** `veltrix config get <id>` — one canvas, with its sections/fields summarized. */
export async function configGetCommand(id, options) {
  const profile = requireProfile(options)
  try {
    const cv = await getCanvas(profile, id)
    console.log(`${c.bold(cv.name ?? '(unnamed)')}  ${c.dim(cv.id ?? id)}`)
    console.log(`  app:     ${cv.toolType ?? '?'} / ${cv.entityType ?? '?'}`)
    console.log(`  status:  ${cv.status ?? '?'}  (v${cv.version ?? '?'})`)
    if (cv.lastDeployError) console.log(`  ${c.red('last deploy error:')} ${cv.lastDeployError}`)
    const sections = Array.isArray(cv.sections) ? cv.sections : []
    console.log(`  ${c.dim(`sections (${sections.length}):`)}`)
    for (const section of sections) {
      console.log(`   • ${section.name ?? '(section)'}`)
      const fields = Array.isArray(section.fields) ? section.fields : []
      for (const f of fields) {
        const value = f.value == null || f.value === '' ? c.dim('—') : Array.isArray(f.value) ? f.value.join(', ') : String(f.value)
        console.log(`       ${f.key ?? f.label ?? '?'}: ${value}`)
      }
    }
  } catch (error) {
    fail(error)
  }
}

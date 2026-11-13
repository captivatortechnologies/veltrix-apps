import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader, splunkRequest, postForm } from '../../lib/splunkApi'
import { APP_BASE_PATH, resolveShclusterTargetUri } from './deploy'

interface AppRollbackData {
  previousState?: Array<Record<string, unknown>>
  installedApps?: string[]
  stagingPlaced?: Array<{ appId: string; role: string; dir: string; existed?: boolean }>
}

/** Which bundle push to re-run after removing a staged app, per role. */
const ROLE_BUNDLE: Record<string, 'applyClusterBundle' | 'reloadDeployServer' | 'applyShclusterBundle'> = {
  'cluster-manager': 'applyClusterBundle',
  'deployment-server': 'reloadDeployServer',
  deployer: 'applyShclusterBundle',
}

/** Settings restored from the deploy-time snapshot. */
const RESTORE_KEYS = ['label', 'version', 'description'] as const

/**
 * Rollback Splunk app configuration:
 *  - restores previous metadata + enabled state of apps that already existed
 *  - removes apps that did not exist before this deploy (existed === false)
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, rollbackData } = ctx

  if (!credential) {
    return { success: false, message: 'Missing credential for rollback' }
  }

  const data = (rollbackData as AppRollbackData) || {}
  const previousState = data.previousState ?? []
  const packageNotRestored = (data.installedApps ?? []).filter(name => previousState.some(state => state.name === name && state.existed !== false))

  if (previousState.length === 0) {
    return { success: false, message: 'No previous state available for Splunk app rollback' }
  }

  const baseUrl = buildSplunkUrl(component, connectivity, connectivityProvider, ctx.settings)
  const auth = buildAuthHeader(credential)

  const restored: string[] = []
  const removed: string[] = []

  try {
    for (const appState of previousState) {
      const name = appState.name as string
      if (!name) continue
      const appPath = `${APP_BASE_PATH}/${encodeURIComponent(name)}`

      // Apps created by this deploy are removed on rollback.
      if (appState.existed === false) {
        await splunkRequest(`${baseUrl}${appPath}`, { method: 'DELETE', headers: auth })
        removed.push(name)
        continue
      }

      // Restore previous metadata.
      const payload: Record<string, string> = {}
      for (const key of RESTORE_KEYS) {
        if (key === 'version' && packageNotRestored.includes(name)) continue // The previous package bytes were not captured.
        const value = appState[key]
        if (value === undefined || value === null) continue
        payload[key] = String(value)
      }
      if (Object.keys(payload).length > 0) {
        await postForm(baseUrl, auth, appPath, payload)
      }

      // Restore previous enabled/disabled state.
      if (appState.disabled !== undefined) {
        const wasDisabled = appState.disabled === true || appState.disabled === '1' || appState.disabled === 1
        await splunkRequest(`${baseUrl}${appPath}/${wasDisabled ? 'disable' : 'enable'}`, {
          method: 'POST',
          headers: auth,
        })
      }
      restored.push(name)
    }

    // Remove only staging directories confirmed new by this deployment. Legacy
    // snapshots with unknown provenance must preserve potentially existing files.
    const stagingPlaced = data.stagingPlaced ?? []
    const stagingActions: string[] = []
    let stagingIncomplete = packageNotRestored.length > 0
    if (packageNotRestored.length) stagingActions.push(`Previous package bytes for ${packageNotRestored.join(', ')} were not captured; restore the original package from backup`)
    if (stagingPlaced.length > 0) {
      if (!ctx.remote) {
        stagingIncomplete = true
        stagingActions.push(`${stagingPlaced.length} staging placement(s) NOT rolled back (target not reachable via managed ZTNA — manual cleanup may be needed)`)
      } else {
        const rolesToRepush = new Set<string>()
        for (const s of stagingPlaced) {
          if (s.existed !== false) {
            stagingIncomplete = true
            stagingActions.push(`Kept staged app ${s.appId}: its prior files were not captured; restore the staging backup and re-apply its bundle`)
            continue
          }
          const removed = await ctx.remote.run({ action: 'removePath', path: `${ctx.remote.homeDir}/${s.dir}/${s.appId}` })
          if (!removed.ok) throw new Error(`Could not remove staged app ${s.appId} (${removed.code})`)
          rolesToRepush.add(s.role)
        }
        for (const role of rolesToRepush) {
          const bundle = ROLE_BUNDLE[role]
          if (!bundle) continue
          // shcluster-bundle needs a member -target; cluster-bundle / deploy-server do not.
          const intent =
            bundle === 'applyShclusterBundle'
              ? { action: 'applyShclusterBundle' as const, targetUri: await resolveShclusterTargetUri(ctx.platform, component.id) }
              : { action: bundle }
          const pushed = await ctx.remote.run(intent)
          if (!pushed.ok) throw new Error(`Rollback bundle push ${bundle} failed (${pushed.code})`)
        }
        if (rolesToRepush.size) stagingActions.push(`Removed newly staged apps and re-applied ${rolesToRepush.size} bundle(s)`)
      }
    }

    const actions: string[] = []
    if (restored.length > 0) actions.push(`restored ${restored.length} app(s)`)
    if (removed.length > 0) actions.push(`removed ${removed.length} newly installed app(s)`)
    actions.push(...stagingActions)
    return { success: !stagingIncomplete, message: `Rollback ${stagingIncomplete ? 'incomplete' : 'complete'}: ${actions.join(', ') || 'no changes'}` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader, getEntityContent, postForm, splunkRequest } from '../../lib/splunkApi'
import { extractAppSpec, buildAppPackage, buildInstallUpload, resolveAppId } from '../../lib/splunkPackage'

/**
 * Deploy Splunk app / add-on configuration via the REST API.
 *   install/upgrade:  POST /services/apps/appinstall   (name=<splunkbaseId> | filename=<url|path>, update)
 *   metadata:         POST /services/apps/local/<app>   (label, version, description)
 *   sharing (ACL):    POST /services/apps/local/<app>/acl   (sharing=app|global, owner=nobody)
 *   state:            POST /services/apps/local/<app>/enable | /disable
 *
 * Canvas → Splunk mapping:
 *   source + sourceRef  → appinstall (Splunkbase id, package URL, or local path)
 *   version             → app 'version'
 *   label / description → app metadata
 *   visibility          → ACL 'sharing' (app | global)
 *   state               → enable / disable sub-endpoints
 *   upgradePolicy       → auto re-installs latest on every deploy; manual only installs when absent
 *
 * When `source = 'inline'` the app/TA is BUILT from the authored `appFiles` into
 * a real .spl (see lib/splunkPackage) and that package is uploaded to
 * /services/apps/local. The REST configs API can write .conf stanzas and nothing
 * else, so a packaged install is the only way to ship a bin/ script, metadata/
 * permissions, a lookup or a modular input's README spec — and it puts the config
 * in default/ rather than the user-owned local/, which shadows default/ and
 * survives every upgrade.
 */

export const APP_BASE_PATH = '/services/apps/local'
export const APP_INSTALL_PATH = '/services/apps/appinstall'

/** App settings snapshotted for rollback. */
const ROLLBACK_KEYS = ['label', 'version', 'description', 'disabled'] as const

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx

  if (!credential || !connectivity) {
    return { success: false, message: 'Missing credential or connectivity for Splunk app deployment' }
  }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)
  const rollbackSnapshot: Record<string, unknown>[] = []
  const installedApps: string[] = []
  const deployedApps: string[] = []
  const installedPackages: Record<string, unknown>[] = []

  try {
    for (const section of canvas.sections) {
      const fields = section.fields
      // The app IS the configuration: an unnamed item ships under the
      // configuration's own name, so authoring .conf files never means
      // inventing an app id as well.
      const appId = resolveAppId(fields, canvas.name)
      if (!appId) continue

      const appPath = `${APP_BASE_PATH}/${encodeURIComponent(appId)}`

      // Capture current state for rollback.
      const existing = await getEntityContent(baseUrl, auth, appPath)
      if (existing) {
        const snapshot: Record<string, unknown> = { name: appId, existed: true }
        for (const key of ROLLBACK_KEYS) {
          if (existing[key] !== undefined) snapshot[key] = existing[key]
        }
        rollbackSnapshot.push(snapshot)
      } else {
        rollbackSnapshot.push({ name: appId, existed: false })
      }

      const source = (fields.source as string | undefined) ?? 'splunkbase'
      const sourceRef = typeof fields.sourceRef === 'string' ? fields.sourceRef.trim() : ''
      const upgradePolicy = (fields.upgradePolicy as string | undefined) ?? 'manual'

      if (source === 'inline') {
        // Build the real .spl and install THAT, rather than writing stanzas over
        // the REST configs API. The configs API can write .conf files and nothing
        // else, so a packaged install is the only way to ship a bin/ script, the
        // metadata/ permissions, a lookup, or a modular input's README spec — and
        // it lands the config in default/, not the user-owned local/ (which
        // shadows default/ and survives every upgrade).
        const { spec } = extractAppSpec(fields, { build: canvas.version, configName: canvas.name })
        const pkg = buildAppPackage(spec)
        const upload = buildInstallUpload(pkg, { update: Boolean(existing) })

        await splunkRequest(`${baseUrl}${APP_BASE_PATH}`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': upload.contentType },
          body: upload.body,
        })

        installedApps.push(appId)
        installedPackages.push({
          appId,
          fileName: pkg.fileName,
          sha256: pkg.sha256,
          sizeBytes: pkg.sizeBytes,
          files: pkg.entries.filter((e) => e.type === 'file').map((e) => e.path),
        })
      } else {
        // Install / upgrade from the declared source. Manual policy only installs
        // when the app is absent; auto re-installs the latest package every deploy.
        const shouldInstall = Boolean(sourceRef) && (upgradePolicy === 'auto' || !existing)
        if (shouldInstall) {
          const installParams: Record<string, string> =
            source === 'splunkbase'
              ? { name: sourceRef, update: existing ? '1' : '0' }
              : { filename: sourceRef, update: existing ? '1' : '0' }
          await postForm(baseUrl, auth, APP_INSTALL_PATH, installParams)
          installedApps.push(appId)
        }
      }

      // App metadata (only send provided values).
      const metaPayload = {
        label: typeof fields.label === 'string' && fields.label ? fields.label : undefined,
        description: typeof fields.description === 'string' && fields.description ? fields.description : undefined,
        version: typeof fields.version === 'string' && fields.version ? fields.version : undefined,
      }
      if (Object.values(metaPayload).some((v) => v !== undefined)) {
        await postForm(baseUrl, auth, appPath, metaPayload)
      }

      // ACL sharing scope (visibility).
      const sharing = fields.visibility === 'global' ? 'global' : 'app'
      await postForm(baseUrl, auth, `${appPath}/acl`, { sharing, owner: 'nobody' })

      // Enabled / disabled state via dedicated sub-endpoints.
      const enabled = ((fields.state as string | undefined) ?? 'enabled') !== 'disabled'
      await splunkRequest(`${baseUrl}${appPath}/${enabled ? 'enable' : 'disable'}`, {
        method: 'POST',
        headers: auth,
      })

      deployedApps.push(appId)
    }

    let message = `Deployed ${deployedApps.length} Splunk app(s): ${deployedApps.join(', ')}`
    for (const pkg of installedPackages) {
      const files = (pkg.files as string[]) ?? []
      message += `. Packaged ${pkg.appId} as ${pkg.fileName} (${files.length} file(s), sha256 ${String(pkg.sha256).slice(0, 12)})`
    }

    return {
      success: true,
      message,
      artifacts: { deployedApps, installedApps, installedPackages },
      rollbackData: { previousState: rollbackSnapshot, installedApps },
    }
  } catch (error) {
    return {
      success: false,
      message: `Splunk app deployment failed after ${deployedApps.length} app(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { deployedApps, installedApps, installedPackages, failedAt: canvas.sections[deployedApps.length]?.fields?.name },
      rollbackData: { previousState: rollbackSnapshot, installedApps },
    }
  }
}


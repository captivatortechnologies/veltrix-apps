import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader, getEntityContent, postForm, splunkRequest } from '../../lib/splunkApi'
import { extractAppSpec, buildAppPackage, buildInstallUpload, resolveAppId } from '../../lib/splunkPackage'

/**
 * Deploy Splunk app / add-on configuration via the REST API.
 *   install/upgrade (URL/local): POST /services/apps/local   (name=<url|path>, filename=1, update, explicit_appname)
 *   install/upgrade (Splunkbase): POST /services/apps/appinstall (name=<splunkbaseId>, update) — legacy path
 *   metadata:         POST /services/apps/local/<app>   (label, version, description)
 *   sharing (ACL):    POST /services/apps/local/<app>/acl   (sharing=app|global, owner=nobody)
 *   state:            POST /services/apps/local/<app>/enable | /disable
 *
 * NOTE (Splunk 10.4 REST reference): apps/appinstall is deprecated as of 6.6.0
 * ("To create an app... see apps/local"). URL/local installs use apps/local;
 * Splunkbase-id installs keep appinstall because apps/local has no server-side
 * Splunkbase-catalog resolution.
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

/** A bundle push for a staging role, or null when the role only receives a placement. */
type StagingBundle = 'applyClusterBundle' | 'reloadDeployServer' | 'applyShclusterBundle' | null

/**
 * Splunk roles that place an app into a non-etc/apps dir, and how to activate it.
 * The push-roles run a bundle command after placement; the Indexer only receives a
 * bundle location (etc/peer-apps is normally managed by the Cluster Manager), so it
 * gets a placement with no push.
 */
const ROLE_STAGING: Record<string, { field: string; bundle: StagingBundle; label: string }> = {
  'cluster-manager': { field: 'cmInstallDirs', bundle: 'applyClusterBundle', label: 'Cluster Manager' },
  'deployment-server': { field: 'dsInstallDirs', bundle: 'reloadDeployServer', label: 'Deployment Server' },
  deployer: { field: 'deployerInstallDirs', bundle: 'applyShclusterBundle', label: 'Deployer' },
  indexer: { field: 'indexerInstallDirs', bundle: null, label: 'Indexer' },
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean)
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

/** Which staging placements this component's role(s) call for (etc/apps excluded — REST handles it). */
export function plannedStagingPlacements(
  componentRoles: string[],
  targetTypes: string[],
  fields: Record<string, unknown>,
): Array<{ role: string; label: string; bundle: StagingBundle; dirs: string[] }> {
  const out: Array<{ role: string; label: string; bundle: StagingBundle; dirs: string[] }> = []
  for (const [role, cfg] of Object.entries(ROLE_STAGING)) {
    if (!componentRoles.includes(role)) continue
    if (targetTypes.length > 0 && !targetTypes.includes(role)) continue
    const dirs = toStringArray(fields[cfg.field]).filter((d) => d !== 'etc/apps')
    if (dirs.length > 0) out.push({ role, label: cfg.label, bundle: cfg.bundle, dirs })
  }
  return out
}

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
  // Managed-ZTNA staging-dir placements (for the message + rollback).
  const stagingPlaced: Array<{ appId: string; role: string; dir: string }> = []
  const stagingNotes: string[] = []

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

        // Managed-ZTNA staging-dir placement: for a Cluster Manager / Deployment
        // Server / Deployer target, drop the built .spl into the selected staging
        // dir over the tailnet and run the role's bundle push. REST already put it
        // in etc/apps; this is the distribute-to-peers/clients/members half.
        const placements = plannedStagingPlacements(
          component.type ?? [],
          toStringArray(fields.targetTypes),
          fields,
        )
        for (const p of placements) {
          if (!ctx.remote) {
            stagingNotes.push(`${p.label}: staging dir(s) ${p.dirs.join(', ')} selected but this server isn't reachable via managed ZTNA — installed to etc/apps only`)
            continue
          }
          for (const dir of p.dirs) {
            await ctx.remote.extractArchive(pkg.bytes, `${ctx.remote.homeDir}/${dir}`)
            stagingPlaced.push({ appId, role: p.role, dir })
          }
          if (p.bundle) {
            const push = await ctx.remote.run({ action: p.bundle })
            if (!push.ok) {
              throw new Error(`${p.label} bundle push (${p.bundle}) failed: ${push.stderr.slice(0, 200) || `exit ${push.code}`}`)
            }
            stagingNotes.push(`${p.label}: placed ${appId} in ${p.dirs.join(', ')} and ran ${p.bundle}`)
          } else {
            stagingNotes.push(`${p.label}: placed ${appId} in ${p.dirs.join(', ')} (no bundle push for this role)`)
          }
        }
      } else {
        // Install / upgrade from the declared source. Manual policy only installs
        // when the app is absent; auto re-installs the latest package every deploy.
        const shouldInstall = Boolean(sourceRef) && (upgradePolicy === 'auto' || !existing)
        if (shouldInstall) {
          if (source === 'splunkbase') {
            // Splunkbase-id resolution has no apps/local equivalent, so this keeps
            // apps/appinstall (deprecated as of 6.6.0 but the only server-side path
            // that resolves a Splunkbase id). Prefer a URL source where possible.
            await postForm(baseUrl, auth, APP_INSTALL_PATH, {
              name: sourceRef,
              update: existing ? '1' : '0',
            })
          } else {
            // URL / local package — install via the modern apps/local endpoint
            // (apps/appinstall is deprecated): `name` is the package path/URL,
            // `filename=1` marks it as a package to fetch, and `explicit_appname`
            // pins the installed folder to the configuration's app id.
            await postForm(baseUrl, auth, APP_BASE_PATH, {
              name: sourceRef,
              filename: '1',
              update: existing ? '1' : '0',
              explicit_appname: appId,
            })
          }
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
    for (const note of stagingNotes) message += `. ${note}`

    return {
      success: true,
      message,
      artifacts: { deployedApps, installedApps, installedPackages, stagingPlaced },
      rollbackData: { previousState: rollbackSnapshot, installedApps, stagingPlaced },
    }
  } catch (error) {
    return {
      success: false,
      message: `Splunk app deployment failed after ${deployedApps.length} app(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { deployedApps, installedApps, installedPackages, stagingPlaced, failedAt: canvas.sections[deployedApps.length]?.fields?.name },
      rollbackData: { previousState: rollbackSnapshot, installedApps, stagingPlaced },
    }
  }
}


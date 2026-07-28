import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient } from '../../lib/sentinel'
import { attachDriftActor, veltrixActorLogins } from '../../lib/sentinelActivityLog'
import { indexByDisplayName, listSourceControls, type LiveSourceControl } from './healthCheck'
import { extractSourceControlSpecs, sourceControlKey } from './validate'

/** Order-independent, case-preserving comparison of two content-type arrays. */
function contentTypesKey(values: string[]): string {
  return [...values].map((v) => String(v)).sort().join(',')
}

/**
 * Detect drift between the deployed source controls and the live workspace. A
 * declared connection that no longer exists is critical drift; a differing repo
 * type, content-type set, repository url/branch, or version is warning drift.
 *
 * ⚠ The repositoryAccess credential is WRITE-ONLY and never returned on GET, so it
 * is NEVER part of drift comparison — only non-secret config is compared.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractSourceControlSpecs(ctx.deployedConfig).filter((s) => s.displayName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Veltrix's own deploys authenticate as the app registration — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listSourceControls(client)
    const byName = indexByDisplayName(live)

    for (const spec of specs) {
      const before = diffs.length
      const liveSc: LiveSourceControl | undefined = byName.get(sourceControlKey(spec.displayName))
      if (!liveSc || !liveSc.name) {
        diffs.push({ field: `source_control:${spec.displayName}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        // No server GUID to correlate against, so attribution is best-effort skipped.
        continue
      }

      const resourceId = client.sentinelPath(`/sourcecontrols/${liveSc.name}`)
      const props = liveSc.properties ?? {}

      if (spec.repoType !== (props.repoType ?? '')) {
        diffs.push({ field: `${spec.displayName}.repoType`, expected: spec.repoType, actual: props.repoType ?? '', severity: 'warning' })
      }

      const wantTypes = contentTypesKey(spec.contentTypes)
      const haveTypes = contentTypesKey(Array.isArray(props.contentTypes) ? props.contentTypes.map((v) => String(v)) : [])
      if (wantTypes !== haveTypes) {
        diffs.push({ field: `${spec.displayName}.contentTypes`, expected: wantTypes, actual: haveTypes, severity: 'warning' })
      }

      const repo = props.repository ?? {}
      if (spec.repoUrl !== (repo.url ?? '')) {
        diffs.push({ field: `${spec.displayName}.repository.url`, expected: spec.repoUrl, actual: repo.url ?? '', severity: 'warning' })
      }
      if (spec.repoBranch !== (repo.branch ?? '')) {
        diffs.push({ field: `${spec.displayName}.repository.branch`, expected: spec.repoBranch, actual: repo.branch ?? '', severity: 'warning' })
      }

      if (spec.version !== (props.version ?? '')) {
        diffs.push({ field: `${spec.displayName}.version`, expected: spec.version, actual: props.version ?? '', severity: 'warning' })
      }

      // Attribute every diff this connection produced to the last human change.
      await attachDriftActor(client, diffs.slice(before), { resourceId, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({ field: 'sentinel', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

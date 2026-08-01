import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSemgrepClient, projectFromResponse } from '../../lib/semgrepApi'
import { diffTags, extractProjectSpecs } from './_shared'

/**
 * Drift for project settings: compare the primary branch and (when managed) the
 * tag set we declare against the live project in Semgrep (GET .../projects/{name}).
 * Best-effort — a project that can't be read (transient error / not yet scanned)
 * is skipped rather than raising false drift. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { credential, settings, canvas } = ctx
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildSemgrepClient(credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built
  if (!client.hasSlug) return { hasDrift: false, diffs }

  const specs = extractProjectSpecs(canvas).filter((s) => s.projectName)

  for (const spec of specs) {
    let res
    try {
      res = await client.getProject(spec.projectName)
    } catch {
      continue // best-effort: can't read, no drift asserted
    }
    if (!res.ok) continue

    const live = projectFromResponse(res)
    const livePrimaryBranch = String(live?.primary_branch ?? '').trim()
    const liveTags = Array.isArray(live?.tags) ? (live!.tags as string[]) : []

    if (spec.primaryBranch && spec.primaryBranch !== livePrimaryBranch) {
      diffs.push({
        field: `${spec.projectName}.primaryBranch`,
        expected: spec.primaryBranch,
        actual: livePrimaryBranch || 'unset',
        severity: 'warning',
      })
    }

    if (spec.manageTags) {
      const { toAdd, toRemove } = diffTags(spec.tags, liveTags)
      if (toAdd.length > 0 || toRemove.length > 0) {
        diffs.push({
          field: `${spec.projectName}.tags`,
          expected: spec.tags.join(', ') || '(none)',
          actual: liveTags.join(', ') || '(none)',
          severity: 'warning',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

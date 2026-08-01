import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSemgrepClient,
  projectFromResponse,
  semgrepErrorMessage,
  semgrepWriteError,
  type SemgrepClient,
} from '../../lib/semgrepApi'
import { diffTags, extractProjectSpecs, type ProjectSpec } from './_shared'

/** One project's settings captured before this deploy, for rollback. */
export interface ProjectRollbackEntry {
  projectName: string
  /** The project's primary branch before this deploy ("" when unset/unknown). */
  priorPrimaryBranch: string
  /** The project's tag set before this deploy. */
  priorTags: string[]
  /** Whether this deploy reconciled the project's tags (mirrors the spec flag). */
  manageTags: boolean
}

/**
 * Deploy Semgrep project settings over the public REST API v1.
 *
 * The project must ALREADY exist in Semgrep — this config type UPDATES an
 * existing project in place and never creates or deletes one (Semgrep has no
 * create-project endpoint; projects are created by connecting a repo + scanning).
 * Identity is the project name. Per project:
 *   1. GET .../projects/{name}                 → snapshot prior settings (rollback)
 *   2. PATCH .../projects/{name}               → set primary_branch (when declared)
 *   3. PUT / DELETE .../projects/{name}/tags   → reconcile the tag set (when managed)
 * rollbackData records each project's prior primary branch + tag set so rollback
 * can restore them. A project that does not exist fails the deploy with a clear
 * message rather than silently doing nothing.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { credential, settings, canvas } = ctx

  if (!credential) {
    return { success: false, message: 'Missing credential for Semgrep project deployment' }
  }

  const built = buildSemgrepClient(credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasSlug) {
    return { success: false, message: 'No Semgrep deployment slug set — configure the "Deployment Slug" app setting.' }
  }

  const specs = extractProjectSpecs(canvas).filter((s) => s.projectName)
  const previous: ProjectRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const spec of specs) {
      const getRes = await client.getProject(spec.projectName)
      if (!getRes.ok) {
        const detail =
          getRes.status === 404
            ? `project "${spec.projectName}" does not exist in Semgrep. Projects are created by connecting the repository and running a scan — this app only updates existing projects.`
            : semgrepErrorMessage(getRes)
        return {
          success: false,
          message: `Project deploy failed: ${detail}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }

      const live = projectFromResponse(getRes)
      const priorPrimaryBranch = String(live?.primary_branch ?? '').trim()
      const priorTags = Array.isArray(live?.tags) ? (live!.tags as string[]) : []
      previous.push({ projectName: spec.projectName, priorPrimaryBranch, priorTags, manageTags: spec.manageTags })

      const branchError = await applyPrimaryBranch(client, spec, priorPrimaryBranch)
      if (branchError) {
        return { success: false, message: `Project deploy failed: ${branchError}`, artifacts: { applied }, rollbackData: { previous } }
      }

      const tagError = await reconcileTags(client, spec.projectName, spec.manageTags ? spec.tags : null, priorTags)
      if (tagError) {
        return { success: false, message: `Project deploy failed: ${tagError}`, artifacts: { applied }, rollbackData: { previous } }
      }

      applied.push(spec.projectName)
    }

    if (applied.length === 0) {
      return { success: true, message: 'No projects to apply.', artifacts: { applied: [] }, rollbackData: { previous: [] } }
    }

    return {
      success: true,
      message: `Applied settings to ${applied.length} project(s): ${applied.join(', ')}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Project deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}

/** PATCH the primary branch when the spec declares one that differs from live. Returns an error string or null. */
async function applyPrimaryBranch(client: SemgrepClient, spec: ProjectSpec, priorPrimaryBranch: string): Promise<string | null> {
  if (!spec.primaryBranch || spec.primaryBranch === priorPrimaryBranch) return null
  const res = await client.updateProject(spec.projectName, { primary_branch: spec.primaryBranch })
  return semgrepWriteError(res)
}

/**
 * Reconcile a project's tags to `desired` (null = leave tags untouched). Adds the
 * missing tags and removes the extra ones using the dedicated tag endpoints.
 * Returns an error string or null.
 */
export async function reconcileTags(
  client: SemgrepClient,
  projectName: string,
  desired: string[] | null,
  liveTags: string[],
): Promise<string | null> {
  if (desired === null) return null
  const { toAdd, toRemove } = diffTags(desired, liveTags)

  if (toAdd.length > 0) {
    const res = await client.addProjectTags(projectName, toAdd)
    const err = semgrepWriteError(res)
    if (err) return `could not add tags to "${projectName}": ${err}`
  }
  if (toRemove.length > 0) {
    const res = await client.removeProjectTags(projectName, toRemove)
    const err = semgrepWriteError(res)
    if (err) return `could not remove tags from "${projectName}": ${err}`
  }
  return null
}

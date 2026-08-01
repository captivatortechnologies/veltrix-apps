import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSemgrepClient,
  managedScanFromProject,
  projectFromResponse,
  semgrepErrorMessage,
  semgrepWriteError,
} from '../../lib/semgrepApi'
import { extractManagedScanSpecs, managedScanBody } from './_shared'

/** One project's Managed Scans state captured before this deploy, for rollback. */
export interface ManagedScanRollbackEntry {
  projectName: string
  priorFullScan: boolean
  priorDiffScan: boolean
}

/**
 * Deploy Semgrep Managed Scans settings over the public REST API v1.
 *
 * The project must ALREADY exist AND be onboarded to Managed Scans — this type
 * UPDATES an existing project's Managed Scans config in place. Identity is the
 * project name. Per project:
 *   1. GET .../projects/{name}                 → snapshot prior managed_scan_config
 *   2. PATCH .../projects/{name}/managed-scan  → set full_scan + diff_scan enabled
 * rollbackData records each project's prior flags so rollback can restore them.
 *
 * FLAGGED: Managed Scans is a [Beta] surface; a project that is not onboarded to
 * Managed Scans (or a deployment without Managed Scanning) fails with a clear
 * message rather than silently doing nothing.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { credential, settings, canvas } = ctx

  if (!credential) {
    return { success: false, message: 'Missing credential for Semgrep Managed Scan deployment' }
  }

  const built = buildSemgrepClient(credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasSlug) {
    return { success: false, message: 'No Semgrep deployment slug set — configure the "Deployment Slug" app setting.' }
  }

  const specs = extractManagedScanSpecs(canvas).filter((s) => s.projectName)
  const previous: ManagedScanRollbackEntry[] = []
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
          message: `Managed Scan deploy failed: ${detail}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }

      const prior = managedScanFromProject(projectFromResponse(getRes))
      previous.push({ projectName: spec.projectName, priorFullScan: prior.fullScan, priorDiffScan: prior.diffScan })

      const res = await client.updateManagedScan(spec.projectName, managedScanBody(spec))
      const err = semgrepWriteError(res)
      if (err) {
        const hint =
          res.status === 404 || res.status === 400
            ? ` (the project may not be onboarded to Semgrep Managed Scans — this is a [Beta] surface)`
            : ''
        return {
          success: false,
          message: `Managed Scan deploy failed for "${spec.projectName}": ${err}${hint}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }

      applied.push(spec.projectName)
    }

    if (applied.length === 0) {
      return { success: true, message: 'No projects to apply.', artifacts: { applied: [] }, rollbackData: { previous: [] } }
    }

    return {
      success: true,
      message: `Applied Managed Scan settings to ${applied.length} project(s): ${applied.join(', ')}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Managed Scan deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}

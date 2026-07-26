import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, parseJson, snykErrorMessage, type SnykClient } from '../../lib/snyk'
import {
  extractProjectSettingsSpecs,
  type ProjectSettings,
  type ProjectSettingsSpec,
} from './validate'

/** One project's settings captured before this deploy, for rollback. */
export interface ProjectSettingsRollbackEntry {
  projectId: string
  /** The project's settings prior to this deploy (empty object when none were set). */
  prior: ProjectSettings
  /** True when the project had no explicit settings before this deploy. */
  wasEmpty: boolean
}

/**
 * Deploy Snyk project settings via the v1 API.
 *
 * Projects must already exist in Snyk — this config type UPDATES an existing
 * project's PR-test / auto-upgrade settings; it never creates or deletes one.
 * Identity is the project id: read each project's current settings (captured for
 * rollback), then PUT the managed keys. The v1 project-settings PUT is a partial
 * update, so only the managed keys are sent — Snyk leaves unmanaged settings
 * (pull-request assignment, auto-remediation) untouched. Declarative: the three
 * managed booleans are always sent; the numeric limits only when the user set them.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, host } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — configure the "Organization ID" app setting.' }
  }

  const specs = extractProjectSettingsSpecs(ctx.canvas).filter((s) => s.projectId)
  const rollbackState: ProjectSettingsRollbackEntry[] = []
  const updated: string[] = []

  try {
    for (const spec of specs) {
      const prior = await readProjectSettings(client, spec.projectId)
      rollbackState.push({ projectId: spec.projectId, prior, wasEmpty: Object.keys(prior).length === 0 })

      const res = await client.v1('PUT', `${client.v1OrgPath()}/project/${spec.projectId}/settings`, {
        body: managedBody(spec),
      })
      if (!res.ok) {
        throw new Error(`Failed to update project "${spec.projectId}": ${snykErrorMessage(res)}`)
      }
      updated.push(spec.projectId)
    }

    return {
      success: true,
      message: `Snyk project settings deployed to ${host}: ${updated.length} updated`,
      artifacts: { host, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Project settings deployment failed after ${updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/**
 * The managed-keys body sent on PUT. Declarative: the three booleans are always
 * present; each numeric limit only when the user provided it.
 */
export function managedBody(spec: ProjectSettingsSpec): ProjectSettings {
  return {
    pullRequestTestEnabled: spec.prTestEnabled,
    pullRequestFailOnAnyVulns: spec.prFailOnAny,
    pullRequestFailOnlyForHighSeverity: spec.prFailOnlyHigh,
    autoDepUpgradeEnabled: spec.autoDepUpgradeEnabled,
    ...(spec.autoDepUpgradeLimit !== undefined ? { autoDepUpgradeLimit: spec.autoDepUpgradeLimit } : {}),
    ...(spec.autoDepUpgradeMinAge !== undefined ? { autoDepUpgradeMinAge: spec.autoDepUpgradeMinAge } : {}),
  }
}

/** GET a project's current settings; throws on a non-OK response. Empty object when none set. */
export async function readProjectSettings(client: SnykClient, projectId: string): Promise<ProjectSettings> {
  const res = await client.v1('GET', `${client.v1OrgPath()}/project/${projectId}/settings`)
  if (!res.ok) {
    throw new Error(`Failed to read project settings for "${projectId}": ${snykErrorMessage(res)}`)
  }
  return parseJson<ProjectSettings>(res.body) ?? {}
}

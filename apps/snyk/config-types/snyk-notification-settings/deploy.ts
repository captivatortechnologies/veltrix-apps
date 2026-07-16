import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, parseJson, snykErrorMessage, type SnykClient } from '../../lib/snyk'
import { extractNotificationSpec, type LiveNotificationSettings } from './validate'

export interface NotificationRollbackData {
  prior: LiveNotificationSettings | null
}

/**
 * Deploy Snyk notification settings for the org via the v1 API.
 *
 * Notification settings are a singleton: PUT REPLACES the whole object, so this
 * read-merge-PUTs — GET the current settings (captured for rollback), overlay
 * the four managed keys onto a spread of the prior object, and PUT the result.
 * Notification types this config type does not manage (e.g. test-limit) are
 * preserved untouched. v1 write bodies are plain JSON.
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

  const spec = extractNotificationSpec(ctx.canvas)

  try {
    const prior = await readNotificationSettings(client)

    const body: Record<string, unknown> = {
      ...(prior ?? {}),
      'new-issues-remediations': {
        ...(prior?.['new-issues-remediations'] ?? {}),
        enabled: spec.newIssuesEnabled,
        issueSeverity: spec.newIssuesSeverity,
      },
      'weekly-report': { enabled: spec.weeklyReportEnabled },
      'project-imported': { enabled: spec.projectImportedEnabled },
    }

    const res = await client.v1('PUT', `${client.v1OrgPath()}/notification-settings`, { body })
    if (!res.ok) {
      return {
        success: false,
        message: `Failed to update Snyk notification settings: ${snykErrorMessage(res)}`,
        rollbackData: { prior } satisfies NotificationRollbackData,
      }
    }

    return {
      success: true,
      message: `Snyk notification settings updated on ${host}`,
      artifacts: {
        host,
        newIssuesEnabled: spec.newIssuesEnabled,
        newIssuesSeverity: spec.newIssuesSeverity,
        weeklyReportEnabled: spec.weeklyReportEnabled,
        projectImportedEnabled: spec.projectImportedEnabled,
      },
      rollbackData: { prior } satisfies NotificationRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Notification settings deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

/** GET the current notification-settings object; throws on a non-OK response. */
export async function readNotificationSettings(client: SnykClient): Promise<LiveNotificationSettings | null> {
  const res = await client.v1('GET', `${client.v1OrgPath()}/notification-settings`)
  if (!res.ok) {
    throw new Error(`Failed to read notification settings: ${snykErrorMessage(res)}`)
  }
  return parseJson<LiveNotificationSettings>(res.body)
}

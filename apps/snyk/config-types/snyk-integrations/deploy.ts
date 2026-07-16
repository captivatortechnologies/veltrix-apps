import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, parseJson, snykErrorMessage, type SnykClient } from '../../lib/snyk'
import {
  extractIntegrationSpecs,
  integrationKey,
  type IntegrationSettings,
  type IntegrationSpec,
} from './validate'

/** One integration's settings captured before this deploy, for rollback. */
export interface IntegrationRollbackEntry {
  integrationType: string
  integrationId: string
  /** The integration's settings prior to this deploy. */
  prior: IntegrationSettings
}

/**
 * Deploy Snyk integration settings via the v1 API.
 *
 * Integrations must already be connected in Snyk — this config type UPDATES an
 * existing integration's PR-test / auto-upgrade settings; it never creates or
 * deletes one. Identity is the integration type: resolve each declared type to
 * its integration id from the org's integrations map (throwing if the type is
 * not connected), capture its current settings for rollback, then PUT the merged
 * settings. Declarative — the four managed boolean keys are always sent; the
 * numeric limit only when the user provided one.
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

  const specs = extractIntegrationSpecs(ctx.canvas).filter((s) => s.integrationType)
  const rollbackState: IntegrationRollbackEntry[] = []
  const updated: string[] = []

  try {
    const integrations = await listIntegrations(client)

    for (const spec of specs) {
      const integrationId = integrations[integrationKey(spec.integrationType)]
      if (!integrationId) {
        throw new Error(
          `Integration "${spec.integrationType}" is not configured in this org (connect it in Snyk first)`,
        )
      }

      const prior = await readIntegrationSettings(client, integrationId)
      rollbackState.push({ integrationType: spec.integrationType, integrationId, prior })

      const res = await client.v1('PUT', `${client.v1OrgPath()}/integrations/${integrationId}/settings`, {
        body: mergeSettings(prior, spec),
      })
      if (!res.ok) {
        throw new Error(`Failed to update integration "${spec.integrationType}": ${snykErrorMessage(res)}`)
      }
      updated.push(spec.integrationType)
    }

    return {
      success: true,
      message: `Snyk integration settings deployed to ${host}: ${updated.length} updated`,
      artifacts: { host, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Integration settings deployment failed after ${updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/**
 * Merge the managed keys over the integration's prior settings. Declarative: the
 * four booleans are always overlaid; the numeric limit only when the user set it.
 */
export function mergeSettings(prior: IntegrationSettings, spec: IntegrationSpec): IntegrationSettings {
  return {
    ...prior,
    pullRequestTestEnabled: spec.prTestEnabled,
    pullRequestFailOnAnyVulns: spec.prFailOnAny,
    pullRequestFailOnlyForHighSeverity: spec.prFailOnlyHigh,
    autoDepUpgradeEnabled: spec.autoDepUpgradeEnabled,
    ...(spec.autoDepUpgradeLimit !== undefined ? { autoDepUpgradeLimit: spec.autoDepUpgradeLimit } : {}),
  }
}

/** GET the org's integrations map ({ type: integrationId }); throws on a non-OK response. */
export async function listIntegrations(client: SnykClient): Promise<Record<string, string>> {
  const res = await client.v1('GET', `${client.v1OrgPath()}/integrations`)
  if (!res.ok) {
    throw new Error(`Failed to list integrations: ${snykErrorMessage(res)}`)
  }
  return parseJson<Record<string, string>>(res.body) ?? {}
}

/** GET an integration's current settings; throws on a non-OK response. */
export async function readIntegrationSettings(
  client: SnykClient,
  integrationId: string,
): Promise<IntegrationSettings> {
  const res = await client.v1('GET', `${client.v1OrgPath()}/integrations/${integrationId}/settings`)
  if (!res.ok) {
    throw new Error(`Failed to read integration settings: ${snykErrorMessage(res)}`)
  }
  return parseJson<IntegrationSettings>(res.body) ?? {}
}

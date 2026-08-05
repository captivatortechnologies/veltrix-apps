import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, restResult, snykErrorMessage, type SnykClient } from '../../lib/snyk'
import { extractSecretsSettings, type LiveSecretsSettings } from './validate'

export interface SecretsRollbackData {
  prior: LiveSecretsSettings | null
}

/**
 * Deploy Snyk Secrets (secrets-in-code detection) settings for the org.
 *
 * Secrets settings are a singleton: GET the current settings (captured for
 * rollback), then PATCH /orgs/{org_id}/settings/secrets with the declared
 * secrets_enabled flag. This endpoint is Early Access (beta) in Snyk's REST API
 * — the shape may change in a future dated version.
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

  const spec = extractSecretsSettings(ctx.canvas)

  try {
    const prior = await readSecretsSettings(client)

    const res = await client.rest('PATCH', `${client.restOrgPath()}/settings/secrets`, {
      body: { data: { type: 'secrets_settings', attributes: { secrets_enabled: spec.secretsEnabled } } },
    })
    if (!res.ok) {
      return {
        success: false,
        message: `Failed to update Snyk Secrets settings: ${snykErrorMessage(res)}`,
        rollbackData: { prior } satisfies SecretsRollbackData,
      }
    }

    return {
      success: true,
      message: `Snyk Secrets scanning ${spec.secretsEnabled ? 'enabled' : 'disabled'} for the organization on ${host}`,
      artifacts: { host, secretsEnabled: spec.secretsEnabled },
      rollbackData: { prior } satisfies SecretsRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Secrets settings deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

/** GET the current Secrets settings attributes; throws on a non-OK response. */
export async function readSecretsSettings(client: SnykClient): Promise<LiveSecretsSettings | null> {
  const res = await client.rest('GET', `${client.restOrgPath()}/settings/secrets`)
  if (!res.ok) {
    throw new Error(`Failed to read Secrets settings: ${snykErrorMessage(res)}`)
  }
  return restResult<LiveSecretsSettings>(res)
}

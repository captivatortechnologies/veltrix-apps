import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, restResult, snykErrorMessage, type SnykClient } from '../../lib/snyk'
import { extractSastSettings, type LiveSastSettings } from './validate'

export interface SastRollbackData {
  prior: LiveSastSettings | null
}

/**
 * Deploy Snyk SAST (Snyk Code) settings for the org.
 *
 * SAST settings are a singleton: GET the current settings (captured for
 * rollback), then PATCH /orgs/{org_id}/settings/sast with the declared
 * sast_enabled flag. JSON:API write body is { data: { type, attributes } }.
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

  const spec = extractSastSettings(ctx.canvas)

  try {
    const prior = await readSastSettings(client)

    const res = await client.rest('PATCH', `${client.restOrgPath()}/settings/sast`, {
      body: { data: { type: 'sast_settings', attributes: { sast_enabled: spec.sastEnabled } } },
    })
    if (!res.ok) {
      return {
        success: false,
        message: `Failed to update Snyk Code (SAST) settings: ${snykErrorMessage(res)}`,
        rollbackData: { prior } satisfies SastRollbackData,
      }
    }

    return {
      success: true,
      message: `Snyk Code (SAST) ${spec.sastEnabled ? 'enabled' : 'disabled'} for the organization on ${host}`,
      artifacts: { host, sastEnabled: spec.sastEnabled },
      rollbackData: { prior } satisfies SastRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `SAST settings deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

/** GET the current SAST settings attributes; throws on a non-OK response. */
export async function readSastSettings(client: SnykClient): Promise<LiveSastSettings | null> {
  const res = await client.rest('GET', `${client.restOrgPath()}/settings/sast`)
  if (!res.ok) {
    throw new Error(`Failed to read SAST settings: ${snykErrorMessage(res)}`)
  }
  return restResult<LiveSastSettings>(res)
}

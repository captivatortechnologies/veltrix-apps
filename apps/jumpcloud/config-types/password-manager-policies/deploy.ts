import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage, parseJson, type JumpCloudClient } from '../../lib/jumpcloudApi'
import { extractPasswordManagerPolicySpecs, type JumpCloudPasswordManagerPolicy } from './_shared'

const PATH = '/passwordmanager/company/policies'
export const PASSWORD_MANAGER_NOT_ENABLED_MESSAGE =
  'Password Manager is not enabled for this JumpCloud organization (GET /passwordmanager/company/policies returned 404) — enable it in the Admin Console before deploying this configuration.'

export interface PasswordManagerPolicyRollbackData {
  id: string
  priorDisableExport: boolean
}

/**
 * Deploy the JumpCloud Password Manager organization policy (a tenant
 * singleton) over the API v2:
 *   read:   GET /passwordmanager/company/policies          -> { id, disableExport }
 *   update: PUT /passwordmanager/company/policies/{id}?disableExport=<bool>
 *
 * There is no create/delete — the policy object always exists once Password
 * Manager is enabled for the org; a 404 on GET means it is not enabled.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractPasswordManagerPolicySpecs(ctx.canvas)
  if (specs.length === 0) return { success: false, message: 'No Password Manager policy declared.' }
  const spec = specs[0]

  try {
    const live = await readPolicy(client)
    if (!live) return { success: false, message: PASSWORD_MANAGER_NOT_ENABLED_MESSAGE }

    const priorDisableExport = Boolean(live.disableExport)
    const res = await client.request('PUT', `${PATH}/${encodeURIComponent(String(live.id))}`, {
      query: { disableExport: spec.disableExport },
    })
    if (!res.ok) {
      return { success: false, message: `Failed to update Password Manager policy: ${jumpCloudErrorMessage(res)}` }
    }

    const rollbackData: PasswordManagerPolicyRollbackData = { id: String(live.id), priorDisableExport }
    return {
      success: true,
      message: `Password Manager vault export is now ${spec.disableExport ? 'disabled' : 'allowed'}.`,
      rollbackData,
    }
  } catch (error) {
    return { success: false, message: `Password Manager policy deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

/** Read the current Password Manager organization policy, or null on a 404 (not enabled). */
export async function readPolicy(client: JumpCloudClient): Promise<JumpCloudPasswordManagerPolicy | null> {
  const res = await client.request('GET', PATH)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(jumpCloudErrorMessage(res))
  return parseJson<JumpCloudPasswordManagerPolicy>(res.body)
}

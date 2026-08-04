import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPPClient, ppErrorMessage } from '../../lib/proofpoint'
import { buildEmailTaggingBody, extractEmailTaggingSpec, getEmailTagging, type EmailTaggingBody } from './validate'

export interface EmailTaggingRollbackData {
  priorBody: EmailTaggingBody
}

/**
 * Deploy the Proofpoint Essentials Email Tagging Settings singleton:
 *   PUT /orgs/{org}/email-tagging
 *
 * Every field has an explicit default, so this always declares the full managed
 * state (one PUT per deploy, same "always send the full managed state" approach
 * as `pp-authentication-settings`). The prior settings are captured so rollback
 * can restore them exactly.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl, orgDomain } = built

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    return { success: true, message: 'No Email Tagging Settings configured.', rollbackData: {} }
  }
  const spec = extractEmailTaggingSpec(ctx.canvas)

  try {
    const priorBody = await getEmailTagging(client)

    const body = buildEmailTaggingBody(spec)
    const res = await client.request('PUT', `${client.orgPath}/email-tagging`, { body })
    if (!res.ok) throw new Error(`Failed to update email-tagging settings: ${ppErrorMessage(res)}`)

    return {
      success: true,
      message:
        `Deployed email-tagging settings to Proofpoint Essentials org "${orgDomain}": ` +
        `warning tags ${spec.warningTagsEnabled ? 'enabled' : 'disabled'}, ` +
        `subject tag ${spec.subjectTagEnabled ? `enabled ("${spec.subjectTagContent}")` : 'disabled'}.`,
      artifacts: { baseUrl, orgDomain, body },
      rollbackData: { priorBody } satisfies EmailTaggingRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Email-tagging deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { baseUrl, orgDomain },
    }
  }
}

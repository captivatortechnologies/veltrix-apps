import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import { extractDlpTemplateSpecs, type DlpTemplateSpec, type LiveDlpTemplate } from './validate'

export interface DlpTemplateRollbackEntry {
  name: string
  existed: boolean
  id?: number
  prior?: {
    name?: string
    subject?: string
    plainTextMessage?: string
    htmlMessage?: string
    tlsEnabled?: boolean
    attachContent?: boolean
  }
}

/**
 * Deploy ZIA DLP notification templates via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZIA has no upsert): list /dlpNotificationTemplates,
 * match by name, then PUT an existing template or POST a new one. ZIA STAGES
 * every write — nothing takes effect until activation — so this writes all
 * templates, then calls activate() ONCE at the end. If activation fails the
 * writes remain staged and rollbackData is returned so the platform can revert
 * them.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractDlpTemplateSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: DlpTemplateRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listTemplates(client)
    const byName = new Map(existing.filter((t) => t.name).map((t) => [t.name as string, t]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && live.id != null) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: {
            name: live.name,
            subject: live.subject ?? '',
            plainTextMessage: live.plainTextMessage ?? '',
            htmlMessage: live.htmlMessage ?? '',
            tlsEnabled: live.tlsEnabled === true,
            attachContent: live.attachContent === true,
          },
        })
        const res = await client.zia('PUT', `/dlpNotificationTemplates/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update DLP notification template "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/dlpNotificationTemplates', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create DLP notification template "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveDlpTemplate>(res.body)
        if (created?.id == null) {
          throw new Error(`DLP notification template "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    // ZIA changes are staged — push them to production once, after all writes.
    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Staged ${deployed.length} ZIA DLP notification template(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedTemplates: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA DLP notification template(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedTemplates: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `DLP notification template deployment failed after ${deployed.length} of ${specs.length} template(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedTemplates: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA DLP notification templates; throws on a non-OK response. */
export async function listTemplates(client: ZscalerClient): Promise<LiveDlpTemplate[]> {
  const res = await client.ziaGetAll<LiveDlpTemplate>('/dlpNotificationTemplates')
  if (!res.ok) {
    throw new Error(
      `Failed to list DLP notification templates: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find a DLP notification template by name; null when absent. */
export async function findTemplate(client: ZscalerClient, name: string): Promise<LiveDlpTemplate | null> {
  const all = await listTemplates(client)
  return all.find((t) => t.name === name) ?? null
}

function buildPayload(spec: DlpTemplateSpec): Record<string, unknown> {
  // htmlMessage always sent (even empty) so clearing it converges the live template.
  return {
    name: spec.name,
    subject: spec.subject,
    plainTextMessage: spec.plainTextMessage,
    htmlMessage: spec.htmlMessage ?? '',
    tlsEnabled: spec.tlsEnabled,
    attachContent: spec.attachContent,
  }
}

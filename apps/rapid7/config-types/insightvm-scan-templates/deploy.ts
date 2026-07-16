import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient, insightVMErrorMessage, type InsightVMClient } from '../../lib/insightvm'
import {
  extractTemplateSpecs,
  parseJsonObject,
  templateKey,
  type LiveScanTemplate,
  type TemplateSpec,
} from './validate'

export interface TemplateRollbackEntry {
  key: string
  label: string
  templateId: string
  existed: boolean
  /** The full prior template document, captured for an update (PUT full-replace). */
  prior?: LiveScanTemplate
}

/**
 * Deploy Rapid7 InsightVM scan templates via the Console API.
 *
 * Identity is the string `id` (user-settable): list /scan_templates, match on the
 * id, then PUT /scan_templates/{id} to replace an existing template or POST
 * /scan_templates (with the id in the body) to create a new one. Console-shipped
 * built-in templates (builtin === true) are protected — never overwritten; clone
 * them under a new id instead.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built

  const specs = extractTemplateSpecs(ctx.canvas).filter((s) => s.templateId && s.name)
  const rollbackState: TemplateRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listTemplates(client)
    const byId = new Map(existing.filter((t) => t.id != null).map((t) => [t.id as string, t]))

    for (const spec of specs) {
      const label = spec.name ? `${spec.name} (${spec.templateId})` : spec.templateId
      const key = templateKey(spec)
      const live = byId.get(key)

      if (live && live.builtin === true) {
        throw new Error(`${spec.templateId} is a built-in scan template — clone it under a new id instead`)
      }

      if (live) {
        rollbackState.push({ key, label, templateId: spec.templateId, existed: true, prior: live })
        const res = await client.request('PUT', `/scan_templates/${encodeURIComponent(spec.templateId)}`, {
          body: buildBody(spec),
        })
        if (!res.ok) throw new Error(`Failed to update scan template "${label}": ${insightVMErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/scan_templates', { body: buildBody(spec) })
        if (!res.ok) throw new Error(`Failed to create scan template "${label}": ${insightVMErrorMessage(res)}`)
        rollbackState.push({ key, label, templateId: spec.templateId, existed: false })
        createdIds.push(spec.templateId)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} scan template(s) to ${consoleUrl}: ${deployed.join(', ')}`,
      artifacts: { consoleUrl, deployedTemplates: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Scan template deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedTemplates: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all scan templates; throws on a non-OK response. */
export async function listTemplates(client: InsightVMClient): Promise<LiveScanTemplate[]> {
  const res = await client.getAll<LiveScanTemplate>('/scan_templates')
  if (!res.ok) {
    throw new Error(
      `Failed to list scan templates: ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/**
 * Build the request body. The user-settable id, name and description sit at the
 * top level; the template_json config (checks/policies/discovery) is spread on
 * top so a full template document can be supplied verbatim.
 */
function buildBody(spec: TemplateSpec): Record<string, unknown> {
  const extra = parseJsonObject(spec.templateJson).value ?? {}
  return { id: spec.templateId, name: spec.name, description: spec.description, ...extra }
}

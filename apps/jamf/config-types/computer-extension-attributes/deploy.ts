import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient, type JamfClient } from '../../lib/jamfApi'
import {
  buildExtensionAttributeBody,
  extensionAttributeKey,
  extractExtensionAttributeSpecs,
  indexExtensionAttributesByName,
  type LiveExtensionAttribute,
} from './validate'

const EXTENSION_ATTRIBUTES_PATH = '/v1/computer-extension-attributes'

export interface ExtensionAttributeRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveExtensionAttribute
}

interface CreateExtensionAttributeResponse {
  id?: string
}

/**
 * Deploy Jamf Pro computer extension attributes via the modern Jamf Pro API
 * (see validate.ts header for why modern over Classic). Identity is the
 * attribute `name`.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, apiBase } = built

  const specs = extractExtensionAttributeSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ExtensionAttributeRollbackEntry[] = []
  const createdIds: string[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listExtensionAttributes(client, ctx.settings)
    const byName = indexExtensionAttributesByName(existing)

    for (const spec of specs) {
      const label = spec.name
      const key = extensionAttributeKey(spec.name)
      const live = byName.get(key)
      const body = buildExtensionAttributeBody(spec)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `${EXTENSION_ATTRIBUTES_PATH}/${encodeURIComponent(live.id)}`, body)
        if (res.error) throw new Error(`Failed to update extension attribute "${label}": ${res.error}`)
        updated.push(label)
      } else {
        const res = await client.request<CreateExtensionAttributeResponse>('POST', EXTENSION_ATTRIBUTES_PATH, body)
        if (res.error) throw new Error(`Failed to create extension attribute "${label}": ${res.error}`)
        const id = res.data?.id
        if (!id) throw new Error(`Extension attribute "${label}" was created but Jamf Pro returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
        created.push(label)
      }
    }

    return {
      success: true,
      message:
        `Reconciled ${specs.length} Jamf Pro computer extension attribute(s) on ${apiBase}: ` +
        `${created.length} created, ${updated.length} updated.`,
      artifacts: { apiBase, createdExtensionAttributes: created, updatedExtensionAttributes: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Extension attribute deployment failed after ${created.length + updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { apiBase, createdExtensionAttributes: created, updatedExtensionAttributes: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

export async function listExtensionAttributes(
  client: JamfClient,
  settings: Record<string, unknown>,
): Promise<LiveExtensionAttribute[]> {
  const pageSize = typeof settings.page_size === 'number' && settings.page_size > 0 ? settings.page_size : 100
  const res = await client.listAll<LiveExtensionAttribute>(EXTENSION_ATTRIBUTES_PATH, pageSize)
  if (res.error) throw new Error(`Failed to list Jamf Pro computer extension attributes: ${res.error}`)
  return res.nodes
}

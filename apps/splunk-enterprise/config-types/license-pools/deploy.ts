import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader, getEntityContent, postForm, splunkRequest } from '../../lib/splunkApi'

/**
 * Deploy license pool configuration via the REST API.
 *   list/create:  GET/POST   /services/licenser/pools
 *   get/edit:     GET/POST   /services/licenser/pools/<name>
 *   delete:       DELETE     /services/licenser/pools/<name>
 *
 * Canvas → Splunk REST parameter mapping:
 *   name          → pool name (path segment + `name` on create)
 *   stackId       → stack_id   (fixed at creation — see recreatePool below)
 *   quota         → quota      ("MAX" or "<number><B|MB|GB|TB>", passed through as-is)
 *   peers         → peers      (comma-separated peer ids, or "*")
 *   appendPeers   → append_peers (edit only; ignored on create)
 *   description   → description
 *
 * Source: Splunk REST API Reference — License endpoints
 * https://help.splunk.com/en/splunk-enterprise/leverage-rest-apis/rest-api-reference/10.4/license-endpoints/license-endpoint-descriptions
 */

export const LICENSE_POOLS_PATH = '/services/licenser/pools'

/** Pool settings snapshotted for rollback (stack_id is immutable, kept for reference only). */
const ROLLBACK_KEYS = ['quota', 'peers', 'description', 'stack_id'] as const

/** A field the View modal renders. */
interface ResourceField {
  label: string
  value: string
  copyable?: boolean
}
/** One deployed resource surfaced read-only in the config View modal. */
interface DeployedResource {
  name: string
  fields: ResourceField[]
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx

  if (!credential) {
    return { success: false, message: 'Missing credential for license pool deployment' }
  }
  if (!connectivity && !connectivityProvider) {
    return { success: false, message: 'Missing connectivity for license pool deployment' }
  }

  const baseUrl = buildSplunkUrl(component, connectivity, connectivityProvider)
  const auth = buildAuthHeader(credential)

  const rollbackSnapshot: Record<string, unknown>[] = []
  const createdPools: string[] = []
  const deployedPools: string[] = []
  const resources: DeployedResource[] = []
  const notes: string[] = []

  try {
    for (const section of canvas.sections) {
      const fields = section.fields
      const name = fields.name as string
      if (!name) continue

      const stackId = String(fields.stackId ?? '')
      const quota = String(fields.quota ?? 'MAX')
      const peers = typeof fields.peers === 'string' && fields.peers.trim() ? fields.peers.trim() : '*'
      const description = typeof fields.description === 'string' ? fields.description : undefined
      const appendPeers = fields.appendPeers === true

      const poolPath = `${LICENSE_POOLS_PATH}/${encodeURIComponent(name)}`
      let existing = await getEntityContent(baseUrl, auth, poolPath)

      // The stack a pool belongs to is fixed at creation — Splunk has no
      // "move pool to another stack" operation. Reconcile by recreating: the
      // canvas is the declarative source of truth, so a changed stackId means
      // the old pool must go and a new one (on the requested stack) takes its
      // place. This can fail for a stack's fixed default pool (not every pool
      // supports deletion) — surfaced as a clear error rather than silently
      // leaving the pool on its old stack.
      if (existing && String(existing.stack_id ?? '') !== stackId) {
        try {
          await splunkRequest(`${baseUrl}${poolPath}`, { method: 'DELETE', headers: auth })
        } catch (error) {
          throw new Error(
            `Pool "${name}" already exists on stack "${existing.stack_id}" and could not be moved to ` +
              `"${stackId}" (delete failed — some stacks have fixed pools that cannot be removed): ` +
              `${error instanceof Error ? error.message : 'unknown error'}. Use a different pool name instead.`,
          )
        }
        notes.push(`Recreated pool "${name}" to move it from stack "${existing.stack_id}" to "${stackId}"`)
        existing = null
      }

      if (existing) {
        const snapshot: Record<string, unknown> = { name }
        for (const key of ROLLBACK_KEYS) {
          if (existing[key] !== undefined) snapshot[key] = existing[key]
        }
        rollbackSnapshot.push(snapshot)

        await postForm(baseUrl, auth, poolPath, {
          quota,
          peers,
          append_peers: appendPeers ? '1' : '0',
          description,
        })
      } else {
        await postForm(baseUrl, auth, LICENSE_POOLS_PATH, {
          name,
          stack_id: stackId,
          quota,
          peers,
          description,
        })
        createdPools.push(name)
      }

      const final = await getEntityContent(baseUrl, auth, poolPath)
      if (final) resources.push(buildPoolResource(name, component.hostname, final))

      deployedPools.push(name)
    }

    const noteSuffix = notes.length > 0 ? ` (${notes.join('; ')})` : ''
    return {
      success: true,
      message: `Deployed ${deployedPools.length} license pool(s): ${deployedPools.join(', ')}${noteSuffix}`,
      artifacts: { deployedPools, createdPools, resources },
      rollbackData: { previousState: rollbackSnapshot, createdPools },
    }
  } catch (error) {
    return {
      success: false,
      message: `License pool deployment failed after ${deployedPools.length} pool(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { deployedPools, createdPools, failedAt: canvas.sections[deployedPools.length]?.fields?.name },
      rollbackData: { previousState: rollbackSnapshot, createdPools },
    }
  }
}

/** Build the View-modal resource for a deployed pool from its live splunkd content. */
function buildPoolResource(name: string, hostname: string, content: Record<string, unknown>): DeployedResource {
  const s = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : String(v))
  return {
    name: `${name} · ${hostname}`,
    fields: [
      { label: 'Pool', value: name, copyable: true },
      { label: 'Server', value: hostname },
      { label: 'Stack', value: s(content.stack_id) ?? '—' },
      { label: 'Quota (bytes)', value: s(content.quota) ?? '—' },
      { label: 'Used (bytes)', value: s(content.used_bytes) ?? '—' },
      { label: 'Peers', value: s(content.peers) ?? '(none)' },
      { label: 'Description', value: s(content.description) ?? '—' },
    ],
  }
}

/** Byte multipliers for the quota suffix. Splunk's own conf/REST usage is 1024-based (MiB/GiB). */
const UNIT_BYTES: Record<string, number> = { B: 1, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }

/**
 * Parse a canvas quota string ("MAX" | "500GB" | "1000000") into bytes, or the
 * literal `'MAX'` sentinel. Returns null when unparseable (validate.ts already
 * rejects this shape, so callers only see it on unexpected data).
 */
export function parseQuotaBytes(quota: string): number | 'MAX' | null {
  const trimmed = quota.trim()
  if (/^max$/i.test(trimmed)) return 'MAX'
  const match = /^(\d+(?:\.\d+)?)\s*(b|mb|gb|tb)?$/i.exec(trimmed)
  if (!match) return null
  const value = Number(match[1])
  const unit = (match[2] ?? 'B').toUpperCase()
  return Math.round(value * (UNIT_BYTES[unit] ?? 1))
}

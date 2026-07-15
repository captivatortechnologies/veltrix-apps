import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import { extractAttributeSpecs, type AttributeSpec, type LiveAttribute } from './validate'

export interface AttributeRollbackEntry {
  name: string
  existed: boolean
  /** Tenable-assigned id (stringified) — the stable key rollback is keyed on. */
  id?: string
  prior?: { description?: string }
}

/**
 * Deploy custom asset-attribute FIELD definitions to a Tenable tenant via the
 * Assets Attributes API.
 *
 * An asset attribute is a custom metadata field; its logical identity is the
 * `name`, and Tenable assigns each definition an id used for update/delete. For
 * each declared attribute:
 *   - GET  /api/v3/assets/attributes        — list, then match on name
 *   - PUT  /api/v3/assets/attributes/{id}   — update an existing definition
 *                                             (capture prior description)
 *   - POST /api/v3/assets/attributes        — create a missing definition
 *                                             (capture the new id)
 *
 * Create accepts an ARRAY under "attributes"; because identity is per-name we
 * send exactly one attribute per POST. Only the DEFINITION is managed here —
 * the per-asset values assigned to these fields are data, never touched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractAttributeSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: AttributeRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = spec.name

      const existing = await findAttribute(client, spec.name)

      if (existing && existing.id != null) {
        const id = String(existing.id)
        rollbackState.push({
          name: spec.name,
          existed: true,
          id,
          // Capture an explicit empty so rollback can clear a description the
          // deployment sets on an attribute that previously had none.
          prior: { description: typeof existing.description === 'string' ? existing.description : '' },
        })

        const res = await client.request('PUT', `/api/v3/assets/attributes/${id}`, {
          body: buildUpdatePayload(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update attribute "${label}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/api/v3/assets/attributes', {
          body: buildCreatePayload(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to create attribute "${label}": ${tenableErrorMessage(res)}`)
        }
        // The create body is an array wrapper and the response shape is not
        // guaranteed to echo the new id, so read it from the response when
        // present and otherwise re-resolve by name — either way we must capture
        // a stable id for rollback.
        const created =
          extractCreatedAttribute(res.body, spec.name) ?? (await findAttribute(client, spec.name))
        if (!created?.id) {
          throw new Error(`Attribute "${label}" was created but no id could be resolved`)
        }
        const id = String(created.id)
        rollbackState.push({ name: spec.name, existed: false, id })
        createdIds.push(id)
      }

      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} asset attribute(s) to Tenable tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedAttributes: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Asset attribute deployment failed after ${deployed.length} of ${specs.length} attribute(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedAttributes: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/**
 * Find an attribute definition by its name; null when absent.
 * A plain GET /api/v3/assets/attributes returns the full attribute list.
 */
export async function findAttribute(
  client: TenableClient,
  name: string,
): Promise<LiveAttribute | null> {
  const res = await client.request('GET', '/api/v3/assets/attributes')
  if (!res.ok) {
    throw new Error(`Failed to list asset attributes while resolving "${name}": ${tenableErrorMessage(res)}`)
  }
  const attributes = parseJson<{ attributes?: LiveAttribute[] }>(res.body)?.attributes ?? []
  // The name is the logical key — match it exactly. A name differing only in
  // case is a DIFFERENT attribute definition and must not be adopted.
  return attributes.find((a) => a.name === name) ?? null
}

/**
 * Best-effort extraction of the created attribute from a POST response body.
 * The create endpoint accepts (and may return) an array under "attributes";
 * tolerate either a wrapped list or a bare array. Returns null when the body
 * does not carry the new record, in which case deploy re-resolves by name.
 */
function extractCreatedAttribute(body: string, name: string): LiveAttribute | null {
  const parsed = parseJson<{ attributes?: LiveAttribute[] } | LiveAttribute[]>(body)
  const list = Array.isArray(parsed) ? parsed : parsed?.attributes
  if (!list) return null
  return list.find((a) => a && a.name === name) ?? null
}

function buildCreatePayload(spec: AttributeSpec): Record<string, unknown> {
  // Create accepts an ARRAY under "attributes"; we send exactly one per item.
  const attribute: Record<string, unknown> = { name: spec.name }
  if (spec.description) attribute.description = spec.description
  return { attributes: [attribute] }
}

function buildUpdatePayload(spec: AttributeSpec): Record<string, unknown> {
  // PUT only mutates the description — the name is the immutable identity we
  // matched on. Always send description (empty string when blank) so clearing
  // it on the canvas converges the live attribute and drift detection agrees
  // about the target state.
  return { description: spec.description ?? '' }
}

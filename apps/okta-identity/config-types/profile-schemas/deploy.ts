import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import { extractProfileSchemaSpecs, type ProfileSchemaSpec } from './validate'

export interface ProfileSchemaRollbackEntry {
  schemaType: 'user' | 'group'
  userTypeId: string
  /**
   * The prior state of every attribute this deploy managed: name -> prior
   * definition (object) or `null` when the attribute did not exist before. Replayed
   * verbatim on rollback (a null re-removes an attribute this deploy added).
   */
  priorAttributes: Record<string, unknown>
}

/** Shape of a profile schema returned by GET /meta/schemas/{...}. */
export interface LiveSchema {
  id?: string
  name?: string
  definitions?: {
    base?: { properties?: Record<string, unknown> }
    custom?: { properties?: Record<string, unknown> }
  }
  [key: string]: unknown
}

/**
 * Deploy profile-schema custom attributes to an Okta org. Schemas are UPDATE-ONLY
 * (the schema object is never created or deleted), so for each declared schema:
 *   - GET  the schema                       — capture the prior state of the
 *                                             managed attributes (for rollback)
 *   - POST the schema with a `definitions.custom.properties` patch — Okta merges it
 *     key-by-key, so ONLY the declared attribute names are touched. A value of
 *     `null` removes that custom attribute; unmanaged custom attributes are never
 *     pruned. Base (#base) attributes are immutable and never sent.
 *
 * A 404 on GET means the schema does not exist — surfaced clearly (for a user type,
 * create the user type first with the User Types config type).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractProfileSchemaSpecs(ctx.canvas).filter(
    (s): s is ProfileSchemaSpec & { schemaType: 'user' | 'group'; attributes: Record<string, unknown> } =>
      (s.schemaType === 'user' || s.schemaType === 'group') &&
      s.attributes !== null &&
      Object.keys(s.attributes).length > 0,
  )
  const rollbackState: ProfileSchemaRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = schemaLabel(spec.schemaType, spec.userTypeId)

      // GET first: the schema must already exist (update-only), and we capture the
      // prior definition of every managed attribute so rollback can restore it.
      const live = await getSchema(client, spec.schemaType, spec.userTypeId)
      if (!live) {
        throw new Error(
          `Schema for ${label} does not exist. Schemas are update-only — for a user type, create the user type first (User Types config type); the group schema always exists.`,
        )
      }

      const liveProps = live.definitions?.custom?.properties ?? {}
      const priorAttributes: Record<string, unknown> = {}
      for (const name of Object.keys(spec.attributes)) {
        priorAttributes[name] = Object.prototype.hasOwnProperty.call(liveProps, name)
          ? liveProps[name]
          : null
      }
      rollbackState.push({
        schemaType: spec.schemaType,
        userTypeId: spec.userTypeId,
        priorAttributes,
      })

      const res = await client.request('POST', schemaPath(spec.schemaType, spec.userTypeId), {
        body: buildCustomUpdateBody(spec.attributes),
      })
      if (!res.ok) {
        throw new Error(`Failed to update ${label} custom attributes: ${oktaErrorMessage(res)}`)
      }

      const count = Object.keys(spec.attributes).length
      deployed.push(`${label} (${count} attr)`)
    }

    return {
      success: true,
      message: `Deployed custom profile attributes to ${deployed.length} schema(s) on Okta org at ${baseUrl}: ${
        deployed.join(', ') || 'none'
      }.`,
      artifacts: { baseUrl, deployedSchemas: deployed },
      rollbackData: { previousState: rollbackState, createdIds: [] },
    }
  } catch (error) {
    return {
      success: false,
      message: `Profile schema deployment failed after ${deployed.length} of ${specs.length} schema(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedSchemas: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds: [] },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Human label for a schema, e.g. `user schema "default"` or `the group schema`. */
export function schemaLabel(schemaType: 'user' | 'group', userTypeId: string): string {
  return schemaType === 'group' ? 'the group schema' : `user schema "${userTypeId}"`
}

/**
 * REST path for a profile schema. User schemas are keyed by the user-type id (or
 * `default`); the group schema is always `/meta/schemas/group/default`. The user
 * type id is URL-encoded (it may be a machine name).
 */
export function schemaPath(schemaType: 'user' | 'group', userTypeId: string): string {
  return schemaType === 'group'
    ? '/meta/schemas/group/default'
    : `/meta/schemas/user/${encodeURIComponent(userTypeId)}`
}

/** Fetch a profile schema; null on 404 (no such schema / user type). */
export async function getSchema(
  client: OktaClient,
  schemaType: 'user' | 'group',
  userTypeId: string,
): Promise<LiveSchema | null> {
  const res = await client.request('GET', schemaPath(schemaType, userTypeId))
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch ${schemaLabel(schemaType, userTypeId)}: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveSchema>(res.body)
}

/**
 * Build the update (POST) body — a partial patch of the `#custom` subschema. Okta
 * merges `definitions.custom.properties` key-by-key: a value that is an attribute
 * object adds/updates it, a value of `null` removes it. `id`/`type` are the fixed
 * `#custom` descriptors. Only custom attributes are ever written — never `#base`.
 */
export function buildCustomUpdateBody(attributes: Record<string, unknown>): Record<string, unknown> {
  return {
    definitions: {
      custom: {
        id: '#custom',
        type: 'object',
        properties: attributes,
      },
    },
  }
}

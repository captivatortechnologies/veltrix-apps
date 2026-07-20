import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, type OktaClient } from '../../lib/okta'
import {
  buildLinkedObjectBody,
  extractLinkedObjectSpecs,
  type LinkedObjectSpec,
  type LiveLinkedObject,
} from './validate'

export interface LinkedObjectRollbackEntry {
  /** Primary name of the definition — the rollback key. */
  primaryName: string
  /** Whether the definition already existed before this deploy ran. */
  existed: boolean
}

const LINKED_OBJECTS_PATH = '/meta/schemas/user/linkedObjects'

/**
 * Deploy user linked-object definitions to an Okta org via the Linked Objects
 * API. A definition is IMMUTABLE — there is NO update endpoint — so for each
 * declared definition:
 *   - GET /meta/schemas/user/linkedObjects  — list and match by PRIMARY name
 *   - a matching definition (same primary/associated name + title + description)
 *     is a no-op, recorded as unchanged (skipped)
 *   - a definition that exists but DIFFERS is a hard error: it cannot be updated
 *     in place; the operator must delete it first (which removes every user link
 *     that uses it), then redeploy to recreate it
 *   - a missing definition is CREATED via POST (captured for rollback)
 *
 * deploy never deletes: it only creates missing definitions or leaves matching
 * ones untouched, so nothing an operator already relies on is silently changed.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractLinkedObjectSpecs(ctx.canvas).filter((s) => s.primaryName && s.associatedName)
  const previousState: LinkedObjectRollbackEntry[] = []
  const createdNames: string[] = []
  const deployedLinkedObjects: string[] = []
  const skipped: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findLinkedObject(client, spec.primaryName)

      if (existing) {
        // A definition is IMMUTABLE. If the live definition already matches the
        // declared one there is nothing to do; if it DIFFERS we refuse to touch
        // it, because Okta offers no update — the operator must delete then
        // recreate it (which drops every user link that uses it).
        if (linkedObjectMatches(spec, existing)) {
          skipped.push(spec.primaryName)
          deployedLinkedObjects.push(spec.primaryName)
          continue
        }
        throw new Error(
          `Linked-object definition "${spec.primaryName}" already exists with a different definition and cannot be updated in place — Okta linked objects are immutable. Delete "${spec.primaryName}" first (this removes all existing user links that use it), then redeploy to recreate it with the new definition.`,
        )
      }

      // Missing — create it. A 409 Conflict here means it was created
      // concurrently between the list and this POST.
      const res = await client.request('POST', LINKED_OBJECTS_PATH, { body: buildLinkedObjectBody(spec) })
      if (!res.ok) {
        throw new Error(`Failed to create linked-object definition "${spec.primaryName}": ${oktaErrorMessage(res)}`)
      }
      previousState.push({ primaryName: spec.primaryName, existed: false })
      createdNames.push(spec.primaryName)
      deployedLinkedObjects.push(spec.primaryName)
    }

    return {
      success: true,
      message: `Deployed ${deployedLinkedObjects.length} linked-object definition(s) to Okta org at ${baseUrl}: ${deployedLinkedObjects.join(
        ', ',
      )}${skipped.length ? ` (${skipped.length} unchanged: ${skipped.join(', ')})` : ''}`,
      artifacts: { baseUrl, deployedLinkedObjects, skipped },
      rollbackData: { previousState, createdIds: createdNames },
    }
  } catch (error) {
    return {
      success: false,
      message: `Linked-object deployment failed after ${deployedLinkedObjects.length} of ${specs.length} definition(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedLinkedObjects, skipped },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState, createdIds: createdNames },
    }
  }
}

// --- Helpers ---

/**
 * Find a linked-object definition by its PRIMARY name across the full list; null
 * when absent. Matching is case-insensitive on the primary name so a
 * differently-cased entry is still recognised as the same definition.
 */
export async function findLinkedObject(client: OktaClient, name: string): Promise<LiveLinkedObject | null> {
  const res = await client.getAll<LiveLinkedObject>(LINKED_OBJECTS_PATH)
  if (!res.ok) {
    throw new Error(
      `Failed to list linked-object definitions while resolving "${name}": ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }
  const lower = name.trim().toLowerCase()
  return res.items.find((lo) => (lo.primary?.name ?? '').trim().toLowerCase() === lower) ?? null
}

/**
 * True when a live definition matches the declared spec on both sides' name,
 * title and description. Used to decide "no-op (unchanged)" vs "immutable
 * conflict". Names compare case-insensitively; titles/descriptions exactly.
 */
export function linkedObjectMatches(spec: LinkedObjectSpec, live: LiveLinkedObject): boolean {
  const primary = live.primary ?? {}
  const associated = live.associated ?? {}
  return (
    sameName(spec.primaryName, primary.name) &&
    sameText(spec.primaryTitle, primary.title) &&
    sameText(spec.primaryDescription, primary.description) &&
    sameName(spec.associatedName, associated.name) &&
    sameText(spec.associatedTitle, associated.title) &&
    sameText(spec.associatedDescription, associated.description)
  )
}

/** Names compare case-insensitively (Okta treats a name as a stable identifier). */
function sameName(expected: string, actual: string | undefined): boolean {
  return expected.trim().toLowerCase() === (actual ?? '').trim().toLowerCase()
}

/** Titles/descriptions compare exactly, treating an absent value as an empty string. */
function sameText(expected: string | undefined, actual: string | undefined): boolean {
  return (expected ?? '') === (actual ?? '')
}

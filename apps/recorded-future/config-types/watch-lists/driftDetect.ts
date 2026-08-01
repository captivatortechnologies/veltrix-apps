import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildRecordedFutureClient, type RecordedFutureClient } from '../../lib/recordedFutureApi'
import {
  listPaths,
  listsFromResponse,
  entitiesFromResponse,
  entitySignatures,
  findList,
  parseEntities,
  normalize,
} from './_shared'

/**
 * Drift for Watch Lists: for each declared list, confirm it exists and that every
 * declared entity is still a member. Read-only:
 *   POST /list/search           → locate the list by name
 *   GET  /list/{id}/entities    → its current members
 *
 * Best-effort — a list that can't be found or read is reported as missing / skipped
 * rather than raising noisy false drift. Members present in RF but NOT declared here
 * are NOT flagged (deploy is additive and does not prune).
 *
 * VERIFY the search + entities response shapes against a live Recorded Future account.
 */
async function findListEntities(
  client: RecordedFutureClient,
  name: string,
  type: string,
): Promise<{ found: boolean; signatures: Set<string> }> {
  const search = await client.post(listPaths.search, { name, type, limit: 100 })
  if (!search.ok) return { found: false, signatures: new Set() }
  const match = findList(listsFromResponse(search.json), name, type)
  if (!match?.id) return { found: false, signatures: new Set() }

  const entities = await client.get(listPaths.entities(String(match.id)))
  if (!entities.ok) return { found: true, signatures: new Set() }
  return { found: true, signatures: entitySignatures(entitiesFromResponse(entities.json)) }
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { credential, settings, component, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildRecordedFutureClient(credential, settings, component?.hostname)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const listType = String(item.fields.listType ?? '').trim()
    if (!name) continue

    let state
    try {
      state = await findListEntities(client, name, listType)
    } catch {
      continue // best-effort: transient error — no drift asserted for this list
    }

    if (!state.found) {
      diffs.push({ field: `${name}`, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    for (const value of parseEntities(item.fields.entities)) {
      if (!state.signatures.has(normalize(value))) {
        diffs.push({ field: `${name}.${value}`, expected: 'member', actual: 'absent', severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

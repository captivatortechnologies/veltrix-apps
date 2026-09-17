import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildQRadarClient,
  parseJson,
  qradarErrorMessage,
  readQRadarSettings,
  resolveQRadarCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type QRadarClient,
} from '../../lib/qradar'
import { indexByLowerName, listLogSourceTypes, listLowLevelCategories } from '../../lib/lookups'
import {
  extractQidRecordSpecs,
  mappingKey,
  parseMappings,
  type LiveEventMapping,
  type LiveQidRecord,
  type QidRecordSpec,
} from './validate'

const QID_PATH = '/data_classification/qid_records'
const MAP_PATH = '/data_classification/dsm_event_mappings'
const enc = encodeURIComponent

export interface QidState {
  name: string
  description: string
  severity?: number
  low_level_category_id?: number
}

export interface MappingEntry {
  key: string
  eventId: string
  eventCategory: string
  existed: boolean
  id?: number
}

export interface RollbackEntry {
  itemId?: string
  name: string
  logSourceType: string
  existed: boolean
  id?: number
  prior?: QidState
  mappings: MappingEntry[]
}

async function getById(client: QRadarClient, id: number): Promise<LiveQidRecord | null> {
  const res = await client.request('GET', `${QID_PATH}/${id}`)
  if (!res.ok) return null
  return parseJson<LiveQidRecord>(res.body)
}

/** A name match that belongs to a DIFFERENT log source type (or to no stated type). */
interface NameCollision {
  collision: LiveQidRecord
}

/**
 * Find this spec's record. Identity is (log source type, name) — a QID record
 * name is unique only WITHIN a device type.
 *
 * Matching on name alone meant deploying "Failed Login" for Linux rewrote the
 * customer's Windows "Failed Login" record; and since the update body omits
 * `log_source_type_id`, the victim kept its own type, so nothing in the console
 * showed what had happened. There is no delete endpoint for QID records, so that
 * is unrecoverable.
 *
 * A name matching a record of ANOTHER type comes back as a collision rather than
 * being created alongside it — a duplicate would be permanent too. An absent
 * `log_source_type_id` counts as a collision for the same reason: it has not
 * established that the record is this device type's to write.
 */
async function findByName(
  client: QRadarClient,
  name: string,
  logSourceTypeId: number,
): Promise<LiveQidRecord | NameCollision | undefined> {
  const res = await client.request('GET', `${QID_PATH}?filter=${enc(`name="${name}"`)}`, { range: 'items=0-99' })
  if (!res.ok) return undefined
  const parsed = parseJson<LiveQidRecord[]>(res.body)
  if (!Array.isArray(parsed)) return undefined
  const named = parsed.filter((r) => (r.name ?? '').toLowerCase() === name.toLowerCase())
  const mine = named.find((r) => r.log_source_type_id === logSourceTypeId)
  if (mine) return mine
  return named.length > 0 ? { collision: named[0] } : undefined
}

function isCollision(v: LiveQidRecord | NameCollision | undefined | null): v is NameCollision {
  return !!v && 'collision' in v
}

/**
 * This record's live event mappings, or null when they could not be read.
 *
 * NOT an empty array on failure: this listing decides which mappings to create,
 * so a refused read used to add a duplicate of one that already exists.
 */
async function listMappingsFor(client: QRadarClient, qidRecordId: number): Promise<LiveEventMapping[] | null> {
  const res = await client.request('GET', `${MAP_PATH}?filter=${enc(`qid_record_id=${qidRecordId}`)}`, { range: 'items=0-9999' })
  if (!res.ok) return null
  const parsed = parseJson<LiveEventMapping[]>(res.body)
  return Array.isArray(parsed) ? parsed : []
}

function qidStateOf(live: LiveQidRecord): QidState {
  return { name: live.name ?? '', description: live.description ?? '', severity: live.severity, low_level_category_id: live.low_level_category_id }
}

function qidCreateBody(spec: QidRecordSpec, typeId: number, categoryId: number): Record<string, unknown> {
  const body: Record<string, unknown> = { log_source_type_id: typeId, name: spec.name, low_level_category_id: categoryId }
  if (spec.description) body.description = spec.description
  if (spec.severity !== undefined) body.severity = spec.severity
  return body
}

function qidUpdateBody(spec: QidRecordSpec, categoryId: number): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, low_level_category_id: categoryId, description: spec.description }
  if (spec.severity !== undefined) body.severity = spec.severity
  return body
}

function qidDiffers(state: QidState, spec: QidRecordSpec, categoryId: number): boolean {
  return (
    state.name !== spec.name ||
    (state.description ?? '') !== spec.description ||
    (spec.severity !== undefined && (state.severity ?? undefined) !== spec.severity) ||
    (state.low_level_category_id ?? undefined) !== categoryId
  )
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildQRadarClient(cred, settings)

  const specs = extractQidRecordSpecs(ctx.canvas).filter((s) => s.logSourceType && s.name && s.lowLevelCategory)
  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId as string, p]))
  const priorByName = new Map(prior.map((p) => [p.name.toLowerCase(), p]))

  const [types, categories] = await Promise.all([listLogSourceTypes(client), listLowLevelCategories(client)])
  const typeByName = indexByLowerName(types)
  const categoryByName = indexByLowerName(categories)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const typeId = typeByName.get(spec.logSourceType.toLowerCase())
    if (typeId === undefined) {
      failures.push(`${spec.name}: unknown log source type "${spec.logSourceType}"`)
      continue
    }
    const categoryId = categoryByName.get(spec.lowLevelCategory.toLowerCase())
    if (categoryId === undefined) {
      failures.push(`${spec.name}: unknown low level category "${spec.lowLevelCategory}"`)
      continue
    }

    const priorEntry = (spec.itemId && priorByItem.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    let existing: LiveQidRecord | NameCollision | undefined | null =
      priorEntry?.id !== undefined ? await getById(client, priorEntry.id) : undefined
    // A recorded id can outlive its record, and the id is reusable — confirm the
    // record it points at still belongs to this device type before writing to it.
    if (existing && !isCollision(existing) && existing.log_source_type_id !== typeId) {
      existing = { collision: existing }
    }
    if (!existing) existing = await findByName(client, spec.name, typeId)

    if (isCollision(existing)) {
      const other = existing.collision
      failures.push(
        `${spec.name}: a QID record with this name already exists under a different log source type ` +
          `(id ${String(other.log_source_type_id ?? 'unreported')}, qid ${String(other.qid ?? other.id ?? '?')}) — ` +
          'writing it would rewrite that device type\'s record, and QID records cannot be deleted. ' +
          'Rename this one, or reconcile it in the console first.',
      )
      continue
    }

    let recordId: number | undefined
    let existed: boolean
    let priorState: QidState | undefined

    if (existing && typeof existing.id === 'number') {
      recordId = existing.id
      existed = true
      priorState = qidStateOf(existing)
      if (qidDiffers(priorState, spec, categoryId)) {
        const resp = await client.request('POST', `${QID_PATH}/${existing.id}`, { body: qidUpdateBody(spec, categoryId) })
        if (!resp.ok) {
          failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
          continue
        }
      }
    } else {
      const resp = await client.request('POST', QID_PATH, { body: qidCreateBody(spec, typeId, categoryId) })
      if (!resp.ok) {
        failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveQidRecord>(resp.body)
      recordId = created?.id
      existed = false
    }

    // Nested DSM event mappings (create-if-missing / re-point qid_record_id; no delete).
    const mappingEntries: MappingEntry[] = []
    const { mappings } = parseMappings(spec.mappingsRaw)
    if (recordId !== undefined && mappings.length > 0) {
      const liveMappings = await listMappingsFor(client, recordId)
      if (liveMappings === null) {
        // Unreadable is not empty. Creating from an unknown state would add a
        // duplicate mapping; the record itself is already written, so this is
        // reported rather than thrown.
        failures.push(`${spec.name}: could not read the existing event mappings, so none were changed`)
        entries.push({ itemId: spec.itemId, name: spec.name, existed, id: recordId, priorState, mappings: [] })
        continue
      }
      const liveByKey = new Map(liveMappings.map((m) => [mappingKey(m.log_source_event_id ?? '', m.log_source_event_category ?? ''), m]))
      for (const m of mappings) {
        const key = mappingKey(m.eventId, m.eventCategory)
        const liveMap = liveByKey.get(key)
        const body = { log_source_type_id: typeId, log_source_event_id: m.eventId, log_source_event_category: m.eventCategory, qid_record_id: recordId }
        if (liveMap && typeof liveMap.id === 'number') {
          if (liveMap.qid_record_id !== recordId) {
            const resp = await client.request('POST', `${MAP_PATH}/${liveMap.id}`, { body })
            if (!resp.ok) {
              failures.push(`${spec.name} [${m.eventId}/${m.eventCategory}]: ${qradarErrorMessage(resp)}`)
              continue
            }
          }
          mappingEntries.push({ key, eventId: m.eventId, eventCategory: m.eventCategory, existed: true, id: liveMap.id })
        } else {
          const resp = await client.request('POST', MAP_PATH, { body })
          if (!resp.ok) {
            failures.push(`${spec.name} [${m.eventId}/${m.eventCategory}]: ${qradarErrorMessage(resp)}`)
            continue
          }
          const created = parseJson<LiveEventMapping>(resp.body)
          mappingEntries.push({ key, eventId: m.eventId, eventCategory: m.eventCategory, existed: false, id: created?.id })
        }
      }
    }

    entries.push({ itemId: spec.itemId, name: spec.name, logSourceType: spec.logSourceType, existed, id: recordId, prior: priorState, mappings: mappingEntries })
  }

  // NOTE: the API exposes no delete for QID records or event mappings, so there is
  // no reconcile-delete — records/mappings this app created but no longer declares remain.

  if (failures.length) {
    return { success: false, message: `Some QID records failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} QID record(s)`, rollbackData: { entries } }
}

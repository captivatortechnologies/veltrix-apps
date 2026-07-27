import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  parseJson,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
  type SecOpsClient,
} from '../../lib/googlesecops'
import { extractParserSpecs, type ParserSpec, type LiveParser } from './validate'

// Parsers are immutable + versioned with one active parser per log type. This
// type content-hashes the desired code: if the active parser already decodes to
// it, nothing changes; otherwise a new parser version is created and activated,
// and the previously app-created version is pruned (delete+recreate family).
export interface RollbackEntry {
  itemId?: string
  logType: string
  /** false = this app owns `createdParserId`; true = a pre-existing active parser already matched. */
  existed: boolean
  /** The parser version this app created + activated for the log type. */
  createdParserId?: string
  /** The parser active immediately before this app first took over — restored on rollback/reconcile. */
  priorActiveParserId?: string
  /** Whether THIS deploy created a new version (drives rollback). */
  changed?: boolean
}

const enc = encodeURIComponent

/** Base64-encode parser source (the SDK's `cbn` field). */
export function encodeCbn(code: string): string {
  return Buffer.from(code, 'utf-8').toString('base64')
}

/** Decode a base64 `cbn` blob back to source; '' when it is not valid base64. */
export function decodeCbn(cbn: string | undefined): string {
  if (!cbn) return ''
  try {
    return Buffer.from(cbn, 'base64').toString('utf-8')
  } catch {
    return ''
  }
}

/** Collapse whitespace so cosmetic re-formatting is not read as a change. */
export function normalizeCode(code: string): string {
  return code.replace(/\s+/g, ' ').trim()
}

export function parserIdOf(name: string): string {
  return name.split('/').pop() ?? ''
}

/** List every parser under one log type, following pagination. */
export async function listParsers(client: SecOpsClient, parent: string, logType: string): Promise<{ ok: boolean; parsers: LiveParser[]; error?: string }> {
  const parsers: LiveParser[] = []
  let pageToken = ''
  do {
    const query = pageToken ? `?pageSize=1000&pageToken=${enc(pageToken)}` : '?pageSize=1000'
    const res = await client.request('GET', `${parent}/logTypes/${enc(logType)}/parsers${query}`)
    if (!res.ok) return { ok: false, parsers, error: secopsErrorMessage(res) }
    const parsed = parseJson<{ parsers?: LiveParser[]; nextPageToken?: string }>(res.body)
    if (parsed?.parsers) parsers.push(...parsed.parsers)
    pageToken = parsed?.nextPageToken ?? ''
  } while (pageToken)
  return { ok: true, parsers }
}

export function activeParser(parsers: LiveParser[]): LiveParser | undefined {
  return parsers.find((p) => (p.state ?? '').toUpperCase() === 'ACTIVE')
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
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const specs = extractParserSpecs(ctx.canvas).filter((s) => s.logType && s.code.trim())
  const prior = await loadPriorEntries(ctx)
  const priorByLogType = new Map(prior.map((p) => [p.logType.toLowerCase(), p]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const listed = await listParsers(client, parent, spec.logType)
    if (!listed.ok) {
      failures.push(`${spec.logType}: ${listed.error}`)
      continue
    }
    const active = activeParser(listed.parsers)
    const desiredNorm = normalizeCode(spec.code)
    const priorEntry = priorByLogType.get(spec.logType.toLowerCase())
    const ownedPrior = priorEntry && priorEntry.existed === false ? priorEntry : undefined

    if (active && normalizeCode(decodeCbn(active.cbn)) === desiredNorm) {
      if (ownedPrior?.createdParserId && ownedPrior.createdParserId === parserIdOf(active.name ?? '')) {
        // Desired code already active AND it is the version we created — carry ownership.
        entries.push({ itemId: spec.itemId, logType: spec.logType, existed: false, createdParserId: ownedPrior.createdParserId, priorActiveParserId: ownedPrior.priorActiveParserId, changed: false })
      } else {
        // A pre-existing parser already matches — nothing to own.
        entries.push({ itemId: spec.itemId, logType: spec.logType, existed: true })
      }
      continue
    }

    const createRes = await client.request('POST', `${parent}/logTypes/${enc(spec.logType)}/parsers`, { cbn: encodeCbn(spec.code), validatedOnEmptyLogs: false })
    if (!createRes.ok) {
      failures.push(`${spec.logType}: ${secopsErrorMessage(createRes)}`)
      continue
    }
    const created = parseJson<LiveParser>(createRes.body)
    const newId = parserIdOf(created?.name ?? '')
    const priorActiveParserId = ownedPrior?.priorActiveParserId ?? (active ? parserIdOf(active.name ?? '') : undefined)
    // Record the entry before activating so a failed activate still leaves a
    // rollback trail to clean up the created version.
    entries.push({ itemId: spec.itemId, logType: spec.logType, existed: false, createdParserId: newId, priorActiveParserId, changed: true })

    const actRes = await client.request('POST', `${parent}/logTypes/${enc(spec.logType)}/parsers/${enc(newId)}:activate`, {})
    if (!actRes.ok) {
      failures.push(`${spec.logType}: created parser but activation failed: ${secopsErrorMessage(actRes)}`)
      continue
    }
    // Prune the previous version this app created for the log type.
    if (ownedPrior?.createdParserId && ownedPrior.createdParserId !== newId) {
      const del = await client.request('DELETE', `${parent}/logTypes/${enc(spec.logType)}/parsers/${enc(ownedPrior.createdParserId)}`)
      if (!del.ok && del.status !== 404) failures.push(`prune ${spec.logType} parser: ${secopsErrorMessage(del)}`)
    }
  }

  // Reconcile: for log types this app took over but no longer declares, restore
  // the prior active parser then delete the version this app created.
  const declaredLogTypes = new Set(specs.map((s) => s.logType.toLowerCase()))
  for (const p of prior) {
    if (p.existed || !p.createdParserId || declaredLogTypes.has(p.logType.toLowerCase())) continue
    if (p.priorActiveParserId) {
      await client.request('POST', `${parent}/logTypes/${enc(p.logType)}/parsers/${enc(p.priorActiveParserId)}:activate`, {})
    }
    const del = await client.request('DELETE', `${parent}/logTypes/${enc(p.logType)}/parsers/${enc(p.createdParserId)}`)
    if (!del.ok && del.status !== 404) failures.push(`delete ${p.logType} parser: ${secopsErrorMessage(del)}`)
  }

  if (failures.length) {
    return { success: false, message: `Some parsers failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} parser(s)`, rollbackData: { entries } }
}

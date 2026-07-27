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
import { extractParserExtensionSpecs, type ParserExtensionSpec, type LiveParserExtension } from './validate'
import { encodeCbn, decodeCbn, normalizeCode, parserIdOf } from '../parsers/deploy'

// Parser extensions are immutable (no update): "editing" is delete + recreate +
// activate, keyed by log type. Deploy content-hashes the desired snippet against
// the app-owned extension; if it differs, a new extension is created and
// activated and the previous app-created one is removed.
export interface RollbackEntry {
  itemId?: string
  logType: string
  /** false = this app owns `extensionId`; true = a pre-existing extension already matched. */
  existed: boolean
  extensionId?: string
  /** Whether THIS deploy created a new extension (drives rollback). */
  changed?: boolean
}

const enc = encodeURIComponent

export function extensionBody(spec: ParserExtensionSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { cbnSnippet: encodeCbn(spec.cbnSnippet) }
  if (spec.logSample.trim()) body.log = encodeCbn(spec.logSample)
  return body
}

/** List every parser extension under one log type, following pagination. */
export async function listExtensions(client: SecOpsClient, parent: string, logType: string): Promise<{ ok: boolean; extensions: LiveParserExtension[]; error?: string }> {
  const extensions: LiveParserExtension[] = []
  let pageToken = ''
  do {
    const query = pageToken ? `?pageSize=1000&pageToken=${enc(pageToken)}` : '?pageSize=1000'
    const res = await client.request('GET', `${parent}/logTypes/${enc(logType)}/parserExtensions${query}`)
    if (!res.ok) return { ok: false, extensions, error: secopsErrorMessage(res) }
    const parsed = parseJson<{ parserExtensions?: LiveParserExtension[]; nextPageToken?: string }>(res.body)
    if (parsed?.parserExtensions) extensions.push(...parsed.parserExtensions)
    pageToken = parsed?.nextPageToken ?? ''
  } while (pageToken)
  return { ok: true, extensions }
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

  const specs = extractParserExtensionSpecs(ctx.canvas).filter((s) => s.logType && s.cbnSnippet.trim())
  const prior = await loadPriorEntries(ctx)
  const priorByLogType = new Map(prior.map((p) => [p.logType.toLowerCase(), p]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const listed = await listExtensions(client, parent, spec.logType)
    if (!listed.ok) {
      failures.push(`${spec.logType}: ${listed.error}`)
      continue
    }
    const priorEntry = priorByLogType.get(spec.logType.toLowerCase())
    const ownedPrior = priorEntry && priorEntry.existed === false ? priorEntry : undefined
    const ownedLive = ownedPrior?.extensionId ? listed.extensions.find((e) => parserIdOf(e.name ?? '') === ownedPrior.extensionId) : undefined

    if (ownedLive) {
      // Our extension still exists — only recreate when its snippet is readable AND differs.
      const liveSnippet = decodeCbn(ownedLive.cbnSnippet)
      const contentDiffers = liveSnippet !== '' && normalizeCode(liveSnippet) !== normalizeCode(spec.cbnSnippet)
      if (!contentDiffers) {
        entries.push({ itemId: spec.itemId, logType: spec.logType, existed: false, extensionId: ownedPrior!.extensionId, changed: false })
        continue
      }
    }

    const createRes = await client.request('POST', `${parent}/logTypes/${enc(spec.logType)}/parserExtensions`, extensionBody(spec))
    if (!createRes.ok) {
      failures.push(`${spec.logType}: ${secopsErrorMessage(createRes)}`)
      continue
    }
    const created = parseJson<LiveParserExtension>(createRes.body)
    const newId = parserIdOf(created?.name ?? '')
    entries.push({ itemId: spec.itemId, logType: spec.logType, existed: false, extensionId: newId, changed: true })

    const actRes = await client.request('POST', `${parent}/logTypes/${enc(spec.logType)}/parserExtensions/${enc(newId)}:activate`, {})
    if (!actRes.ok) {
      failures.push(`${spec.logType}: created extension but activation failed: ${secopsErrorMessage(actRes)}`)
      continue
    }
    // Remove the previous extension this app created for the log type.
    if (ownedPrior?.extensionId && ownedPrior.extensionId !== newId) {
      const del = await client.request('DELETE', `${parent}/logTypes/${enc(spec.logType)}/parserExtensions/${enc(ownedPrior.extensionId)}`)
      if (!del.ok && del.status !== 404) failures.push(`prune ${spec.logType} extension: ${secopsErrorMessage(del)}`)
    }
  }

  // Reconcile: delete extensions this app created for log types no longer declared.
  const declaredLogTypes = new Set(specs.map((s) => s.logType.toLowerCase()))
  for (const p of prior) {
    if (p.existed || !p.extensionId || declaredLogTypes.has(p.logType.toLowerCase())) continue
    const del = await client.request('DELETE', `${parent}/logTypes/${enc(p.logType)}/parserExtensions/${enc(p.extensionId)}`)
    if (!del.ok && del.status !== 404) failures.push(`delete ${p.logType} extension: ${secopsErrorMessage(del)}`)
  }

  if (failures.length) {
    return { success: false, message: `Some parser extensions failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} parser extension(s)`, rollbackData: { entries } }
}

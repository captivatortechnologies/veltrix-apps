import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  listAllPages,
} from '../../lib/auth0Api'
import { parseJsonObject, readOptionalString, readString, stripSecretKeys } from '../../lib/fields'
import { findLogStreamByName, parseJsonArray, type Auth0LogStream } from './_shared'

/**
 * Drift for Auth0 log streams: compare the status and the declared (non-secret)
 * sink keys we author against the live stream in Auth0 (matched by name). Only
 * DECLARED sink keys are compared, so server-side sink defaults never raise
 * false drift; secret-bearing sink keys are ignored because Auth0 returns them
 * masked. Best-effort — an unmatched stream is skipped. Read-only: mint token
 * → GET /log-streams.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const creds = resolveClientCredentials(credential)
  if (!creds) return { hasDrift: false, diffs }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  let live: Auth0LogStream[]
  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })
    live = await listAllPages<Auth0LogStream>((page) => `${base}/log-streams?per_page=100&page=${page}`, accessToken)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = readString(item.fields.name)
    const match = findLogStreamByName(live, name)
    if (!match) continue

    const expectedStatus = readOptionalString(item.fields.status)
    if (expectedStatus !== undefined) {
      const actualStatus = String(match.status ?? '').trim()
      if (expectedStatus !== actualStatus) {
        diffs.push({ field: `${name}.status`, expected: expectedStatus, actual: actualStatus, severity: 'warning' })
      }
    }

    const parsedSink = parseJsonObject(item.fields.sink)
    if (parsedSink.ok) {
      const declared = stripSecretKeys(parsedSink.value)
      const liveSink = (match.sink ?? {}) as Record<string, unknown>
      for (const [key, value] of Object.entries(declared)) {
        const expected = JSON.stringify(value)
        const actual = JSON.stringify(liveSink[key])
        if (expected !== actual) {
          diffs.push({ field: `${name}.sink.${key}`, expected, actual, severity: 'warning' })
        }
      }
    }

    const parsedFilters = parseJsonArray(item.fields.filters)
    if (parsedFilters.ok && parsedFilters.value.length > 0) {
      const expectedFilters = JSON.stringify(parsedFilters.value)
      const actualFilters = JSON.stringify(match.filters ?? [])
      if (expectedFilters !== actualFilters) {
        diffs.push({ field: `${name}.filters`, expected: parsedFilters.value, actual: match.filters ?? [], severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

import { createHash } from 'node:crypto'
import type { DriftDiff, RemoteExecutor } from '@veltrixsecops/app-sdk'
import { buildAppPackage, extractAppSpec, parseConf } from '../../lib/splunkPackage'
import { getJson } from '../../lib/splunkApi'

// ============================================================================
// Content drift for inline Splunk apps: compare the FILES a deploy shipped
// against the live app.
//
//  - Managed ZTNA (ctx.remote): SHA-256 every file on the box and compare to
//    the hashes of what we shipped; for a changed file, pull its content and
//    surface both sides so the diff is visible. Also flags missing shipped files
//    and unexpected files added under default/ (the folder the app fully owns).
//  - Non-managed (REST): read the effective merged .conf via configs/conf-<file>
//    and compare the stanza keys WE shipped to their effective values.
//
// Only meaningful for source=inline (we authored the files, so we know the
// expected bytes). Package/url/splunkbase apps skip content drift.
// ============================================================================

/** How much of a changed file's content to surface in a diff (per side). */
const MAX_CONTENT_CHARS = 4000

export interface ExpectedFile {
  /** Path relative to the app dir, e.g. `default/inputs.conf`. */
  rel: string
  sha256: string
  content: string
  isText: boolean
}

function cap(text: string): string {
  return text.length > MAX_CONTENT_CHARS ? `${text.slice(0, MAX_CONTENT_CHARS)}\n… (truncated)` : text
}

/**
 * The per-file hashes a deploy of this inline app would ship, relative to the
 * app directory. Built from the same package builder the deploy uses, so the
 * hashes match the extracted-on-disk bytes exactly (text and binary alike).
 */
export function expectedAppFiles(
  fields: Record<string, unknown>,
  opts: { build: number; configName: string },
): ExpectedFile[] {
  const { spec } = extractAppSpec(fields, opts)
  const pkg = buildAppPackage(spec)
  const appPrefix = `${spec.appId}/`
  const out: ExpectedFile[] = []
  for (const entry of pkg.entries) {
    if (entry.type !== 'file' || !entry.content) continue
    const buf = entry.content
    const rel = entry.path.startsWith(appPrefix) ? entry.path.slice(appPrefix.length) : entry.path
    out.push({
      rel,
      sha256: createHash('sha256').update(buf).digest('hex'),
      content: buf.toString('utf8'),
      isText: !buf.subarray(0, 8000).includes(0),
    })
  }
  return out
}

/**
 * File-hash content drift over the managed tailnet. Compares the shipped file
 * hashes to a live `hashTree` of `etc/apps/<app>`, pulling changed files to show
 * the diff.
 */
export async function detectManagedContentDrift(
  remote: RemoteExecutor,
  appId: string,
  expected: ExpectedFile[],
): Promise<DriftDiff[]> {
  const diffs: DriftDiff[] = []
  const appDir = `${remote.homeDir}/etc/apps/${appId}`

  let live: Array<{ path: string; sha256: string }>
  try {
    live = await remote.hashTree(appDir)
  } catch (error) {
    return [{ field: appId, expected: 'readable on the target', actual: `unreadable: ${msg(error)}`, severity: 'warning' }]
  }
  // No files at all → the app isn't on disk. The metadata check reports "missing"
  // (a 404 on apps/local); don't double-report every file here.
  if (live.length === 0) return diffs

  const liveMap = new Map(live.map((f) => [f.path, f.sha256]))
  const expectedRels = new Set(expected.map((e) => e.rel))

  for (const ef of expected) {
    const liveHash = liveMap.get(ef.rel)
    if (liveHash === undefined) {
      diffs.push({ field: `${appId}/${ef.rel}`, expected: 'present (as shipped)', actual: 'missing on the target', severity: 'warning' })
      continue
    }
    if (liveHash !== ef.sha256) {
      if (!ef.isText) {
        diffs.push({ field: `${appId}/${ef.rel}`, expected: `binary, sha256 ${ef.sha256.slice(0, 12)}…`, actual: `binary, sha256 ${liveHash.slice(0, 12)}… (differs)`, severity: 'warning' })
        continue
      }
      let liveContent = ''
      try {
        liveContent = await remote.readFile(`${appDir}/${ef.rel}`)
      } catch {
        // Fall back to a hash-only diff when the file can't be pulled.
        diffs.push({ field: `${appId}/${ef.rel}`, expected: `sha256 ${ef.sha256.slice(0, 12)}…`, actual: `sha256 ${liveHash.slice(0, 12)}… (differs; content unavailable)`, severity: 'warning' })
        continue
      }
      diffs.push({ field: `${appId}/${ef.rel}`, expected: cap(ef.content), actual: cap(liveContent), severity: 'warning' })
    }
  }

  // Unexpected files added under default/ — the folder the shipped app owns.
  for (const f of live) {
    if (f.path.startsWith('default/') && !expectedRels.has(f.path)) {
      diffs.push({ field: `${appId}/${f.path}`, expected: 'not shipped', actual: 'present on the target (added out of band)', severity: 'info' })
    }
  }

  return diffs
}

/**
 * Effective-config drift via REST for a non-managed target: for each shipped
 * default/*.conf, read the merged config (`configs/conf-<file>`) and compare only
 * the stanza keys WE shipped to their effective values — so a local/ override or
 * a manual edit shows up, without flagging Splunk's own defaults.
 */
export async function detectRestConfigDrift(
  baseUrl: string,
  auth: Record<string, string>,
  appId: string,
  fields: Record<string, unknown>,
): Promise<DriftDiff[]> {
  const diffs: DriftDiff[] = []
  const appFiles = Array.isArray(fields.appFiles) ? (fields.appFiles as Array<{ path?: string; content?: string }>) : []

  for (const file of appFiles) {
    const path = typeof file?.path === 'string' ? file.path : ''
    if (!path.startsWith('default/') || !path.endsWith('.conf')) continue
    const confName = path.slice('default/'.length, -'.conf'.length)
    const parsed = parseConf(typeof file.content === 'string' ? file.content : '')
    if (parsed.stanzas.length === 0) continue

    let effective: Record<string, Record<string, unknown>>
    try {
      const json = await getJson<{ entry?: Array<{ name?: string; content?: Record<string, unknown> }> }>(
        baseUrl,
        auth,
        `/servicesNS/nobody/${encodeURIComponent(appId)}/configs/conf-${encodeURIComponent(confName)}?count=0`,
      )
      effective = {}
      for (const entry of json.entry ?? []) if (entry.name) effective[entry.name] = entry.content ?? {}
    } catch {
      continue // conf not readable via REST — skip rather than false-alarm
    }

    for (const stanza of parsed.stanzas) {
      const liveStanza = effective[stanza.name]
      if (!liveStanza) {
        diffs.push({ field: `${appId}/${confName}.conf/[${stanza.name}]`, expected: 'present', actual: 'missing', severity: 'warning' })
        continue
      }
      for (const { key, value } of stanza.keys) {
        const liveVal = liveStanza[key]
        if (liveVal === undefined || String(liveVal) !== value) {
          diffs.push({
            field: `${appId}/${confName}.conf/[${stanza.name}]/${key}`,
            expected: value,
            actual: liveVal === undefined ? '(absent)' : String(liveVal),
            severity: 'warning',
          })
        }
      }
    }
  }

  return diffs
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

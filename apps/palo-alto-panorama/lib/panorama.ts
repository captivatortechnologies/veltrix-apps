// =============================================================================
// Shared Palo Alto Networks Panorama / PAN-OS client for this Veltrix app.
//
// Two surfaces, one client:
//   * REST API (PAN-OS 9.0+) — the primary CRUD path for objects and policies:
//       https://<host>/restapi/<version>/<resource>?location=...&device-group=...&name=...
//     JSON bodies of the shape { entry: [ { "@name": ..., "@location": ..., ... } ] }.
//     POST=create, PUT=update, GET=read, DELETE=delete. Auth is the API key sent
//     in the X-PAN-KEY header on every call.
//   * XML API — used ONLY for commit operations the REST API does not own:
//       POST /api/?type=commit&cmd=<commit></commit>   (commit candidate -> Panorama)
//       POST /api/?type=op&cmd=<show><jobs><id>N</id></jobs></show>  (poll the job)
//
// The PAN-OS "REST API version" in the URL is an enumerated string that does NOT
// always equal the PAN-OS release (PAN-OS 11.1 serves /restapi/v11.0), so it is a
// per-connection setting (rest_api_version, default v11.0) rather than hardcoded.
//
// Panorama pushes to DEVICE GROUPS. `device_group` (default "shared") drives the
// REST `location` query param: "shared" -> location=shared; any other value ->
// location=device-group&device-group=<name>.
//
// TLS: Panorama management certs are commonly self-signed. Handlers run in-process
// and may NOT install a custom fetch dispatcher, so this client cannot disable TLS
// verification — the platform host must trust the Panorama certificate. The
// `verify_tls` setting is informational only (surfaced in messages/tests).
//
// Handlers run in-process, so requests use fetch with an AbortController timeout
// and never throw on an HTTP error status — callers inspect `status`/`ok`.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_REST_VERSION = 'v11.0'
const SHARED_LOCATION = 'shared'
/** Upper bound on how long a single commit job is polled before giving up. */
const MAX_COMMIT_POLL_MS = 60_000
const COMMIT_POLL_INTERVAL_MS = 3_000

export interface PanoramaSettings {
  /** REST API version segment, e.g. "v11.0". */
  restApiVersion: string
  /** Device group to target; "shared" means the shared location (no device group). */
  deviceGroup: string
  /** When true, deploy/rollback commit the candidate config to Panorama. */
  autoCommit: boolean
  /** Informational: whether the operator expects the Panorama cert to be trusted. */
  verifyTls: boolean
  timeoutMs: number
}

/** Read and normalize the app settings that drive Panorama API access. */
export function readPanoramaSettings(settings: Record<string, unknown>): PanoramaSettings {
  const rawVersion = settings.rest_api_version
  const restApiVersion =
    typeof rawVersion === 'string' && /^v\d+\.\d+$/.test(rawVersion.trim())
      ? rawVersion.trim()
      : DEFAULT_REST_VERSION

  const rawDeviceGroup = settings.device_group
  const deviceGroup =
    typeof rawDeviceGroup === 'string' && rawDeviceGroup.trim().length > 0
      ? rawDeviceGroup.trim()
      : SHARED_LOCATION

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : DEFAULT_TIMEOUT_MS

  return {
    restApiVersion,
    deviceGroup,
    autoCommit: coerceBoolean(settings.auto_commit, false),
    verifyTls: coerceBoolean(settings.verify_tls, true),
    timeoutMs,
  }
}

/**
 * Extract the PAN-OS API key from a Veltrix credential. Convention: the
 * pre-generated API key lives in the "API token" (apiToken) field. `password`
 * is accepted as a fallback for operators who stored it there.
 */
export function resolvePanoramaApiKey(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const key = (credential.apiToken ?? credential.password ?? '').trim()
  return key.length > 0 ? key : null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Panorama API key — store a pre-generated PAN-OS API key in the credential "API token" field. ' +
  'Generate one with GET/POST https://<panorama>/api/?type=keygen&user=<u>&password=<p>. Use a ' +
  'dedicated admin account whose role is scoped to what this app manages.'

export interface PanoramaResponse {
  status: number
  ok: boolean
  body: string
}

export type PanoramaMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/** One entry inside a REST collection ({ result: { entry: [...] } }). */
export interface PanoramaEntry {
  '@name'?: string
  '@location'?: string
  '@device-group'?: string
  [key: string]: unknown
}

/**
 * Where a managed object lives. For "shared" the REST `location` is "shared"
 * and no device-group param is sent; otherwise `location` is "device-group"
 * and `deviceGroup` names it.
 */
export interface PanoramaLocation {
  /** REST `location` value: "shared" | "device-group". */
  location: string
  /** Device group name when location is "device-group", else null. */
  deviceGroup: string | null
}

export function resolveLocation(settings: PanoramaSettings): PanoramaLocation {
  if (settings.deviceGroup === SHARED_LOCATION || settings.deviceGroup.length === 0) {
    return { location: SHARED_LOCATION, deviceGroup: null }
  }
  return { location: 'device-group', deviceGroup: settings.deviceGroup }
}

/** Human label for a location, used in messages. */
export function locationLabel(loc: PanoramaLocation): string {
  return loc.deviceGroup ? `device-group "${loc.deviceGroup}"` : 'shared'
}

export class PanoramaClient {
  private readonly restBase: string
  private readonly xmlBase: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  readonly location: PanoramaLocation

  constructor(opts: {
    host: string
    apiKey: string
    restApiVersion: string
    location: PanoramaLocation
    timeoutMs: number
  }) {
    this.restBase = `https://${opts.host}/restapi/${opts.restApiVersion}`
    this.xmlBase = `https://${opts.host}/api`
    this.apiKey = opts.apiKey
    this.location = opts.location
    this.timeoutMs = opts.timeoutMs
  }

  /**
   * Build the REST location query params. Always sets `location`; adds
   * `device-group` for the device-group location; adds `name` when given.
   */
  private locationQuery(name?: string): Record<string, string> {
    const query: Record<string, string> = { location: this.location.location }
    if (this.location.deviceGroup) query['device-group'] = this.location.deviceGroup
    if (name) query.name = name
    return query
  }

  /**
   * Wrap the caller's inner fields as a REST entry body, repeating the identity
   * (@name) and @location (+ @device-group) the way the REST API expects.
   */
  private entryBody(name: string, fields: Record<string, unknown>): Record<string, unknown> {
    const entry: PanoramaEntry = { '@name': name, '@location': this.location.location, ...fields }
    if (this.location.deviceGroup) entry['@device-group'] = this.location.deviceGroup
    return { entry: [entry] }
  }

  /** Low-level REST call. `resourcePath` is e.g. "/Objects/Addresses". */
  private async rest(
    method: PanoramaMethod,
    resourcePath: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<PanoramaResponse> {
    const url = new URL(`${this.restBase}${resourcePath}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value)
    }
    return this.send(method, url.toString(), {
      headers: { 'X-PAN-KEY': this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
  }

  /** GET every object of a resource type at the configured location. */
  async list(resourcePath: string): Promise<{ ok: boolean; entries: PanoramaEntry[]; status: number; body: string }> {
    const res = await this.rest('GET', resourcePath, { query: this.locationQuery() })
    if (!res.ok) return { ok: false, entries: [], status: res.status, body: res.body }
    const parsed = parseEntries(res.body)
    return { ok: true, entries: parsed.value ?? [], status: res.status, body: res.body }
  }

  /** Create one object at `resourcePath` (POST). */
  createObject(resourcePath: string, name: string, fields: Record<string, unknown>): Promise<PanoramaResponse> {
    return this.rest('POST', resourcePath, { query: this.locationQuery(name), body: this.entryBody(name, fields) })
  }

  /** Update one object at `resourcePath` (PUT). */
  updateObject(resourcePath: string, name: string, fields: Record<string, unknown>): Promise<PanoramaResponse> {
    return this.rest('PUT', resourcePath, { query: this.locationQuery(name), body: this.entryBody(name, fields) })
  }

  /** Delete one object at `resourcePath` (DELETE). */
  deleteObject(resourcePath: string, name: string): Promise<PanoramaResponse> {
    return this.rest('DELETE', resourcePath, { query: this.locationQuery(name) })
  }

  // --- XML API: commit + job polling ---------------------------------------

  /** Low-level XML API call. Params become the query string; auth via header. */
  private async xml(params: Record<string, string>): Promise<PanoramaResponse> {
    const url = new URL(this.xmlBase)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    return this.send('POST', url.toString(), {
      headers: { 'X-PAN-KEY': this.apiKey, Accept: 'application/xml' },
    })
  }

  /**
   * Commit the candidate configuration to Panorama. Returns the enqueued job id
   * (or null when the API reports there is nothing to commit). Throws on an API
   * error response.
   */
  async commit(): Promise<{ jobId: string | null; noChanges: boolean }> {
    const res = await this.xml({ type: 'commit', cmd: '<commit></commit>' })
    if (!res.ok) throw new Error(`Commit request failed: ${panoramaXmlErrorMessage(res)}`)
    const status = extractXmlTag(res.body, 'response', true)
    if (status && /error/i.test(status)) {
      throw new Error(`Commit rejected: ${panoramaXmlErrorMessage(res)}`)
    }
    if (/no changes to commit|no edits/i.test(res.body)) {
      return { jobId: null, noChanges: true }
    }
    const jobId = extractXmlTag(res.body, 'job')
    return { jobId, noChanges: jobId === null }
  }

  /**
   * Poll a commit job until it reaches FIN or the bounded timeout elapses.
   * Returns the terminal state. Never throws for a FAIL result — the caller
   * decides how to surface it.
   */
  async pollJob(jobId: string): Promise<{ finished: boolean; ok: boolean; detail: string }> {
    const deadline = Date.now() + MAX_COMMIT_POLL_MS
    let last = 'unknown'
    while (Date.now() < deadline) {
      const res = await this.xml({ type: 'op', cmd: `<show><jobs><id>${jobId}</id></jobs></show>` })
      if (res.ok) {
        // The job block nests its own <result>OK</result> inside the response's
        // <result> wrapper — scope extraction to the <job> block to read them.
        const jobBlock = extractXmlTag(res.body, 'job') ?? res.body
        const jobStatus = extractXmlTag(jobBlock, 'status')
        const jobResult = extractXmlTag(jobBlock, 'result')
        last = jobResult || jobStatus || last
        if (jobStatus && jobStatus.toUpperCase() === 'FIN') {
          const ok = !jobResult || jobResult.toUpperCase() === 'OK'
          return { finished: true, ok, detail: jobResult || 'FIN' }
        }
      }
      await sleep(COMMIT_POLL_INTERVAL_MS)
    }
    return { finished: false, ok: false, detail: `still running after ${MAX_COMMIT_POLL_MS / 1000}s (last: ${last})` }
  }

  private async send(
    method: PanoramaMethod,
    url: string,
    init: { headers: Record<string, string>; body?: string },
  ): Promise<PanoramaResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, { method, headers: init.headers, body: init.body, signal: controller.signal })
      const text = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body: text }
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface BuiltClient {
  client: PanoramaClient
  panoramaUrl: string
  location: PanoramaLocation
  settings: PanoramaSettings
}

/**
 * Build a PanoramaClient from a component hostname, a credential and settings,
 * or return the reason it cannot be built. Deploy-family handlers all start here.
 */
export function buildPanoramaClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): BuiltClient | { error: string } {
  const apiKey = resolvePanoramaApiKey(credential)
  if (!apiKey) return { error: MISSING_CREDENTIAL_MESSAGE }

  let host = (hostname ?? '').trim()
  if (!host) {
    return {
      error:
        'No Panorama host — register a component whose hostname is the Panorama management host ' +
        '(e.g. panorama.example.com). HTTPS is always used.',
    }
  }
  host = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')

  const resolved = readPanoramaSettings(settings)
  const location = resolveLocation(resolved)
  const client = new PanoramaClient({
    host,
    apiKey,
    restApiVersion: resolved.restApiVersion,
    location,
    timeoutMs: resolved.timeoutMs,
  })
  return { client, panoramaUrl: `https://${host}`, location, settings: resolved }
}

// --- Deploy / rollback orchestration (shared by every config type) -----------

/** One object to upsert: a name plus its inner REST entry fields. */
export interface UpsertSpec {
  name: string
  fields: Record<string, unknown>
}

/**
 * What deploy did to one object, captured for rollback. NON-UNION shape (all
 * fields always present) so platform handler loading never has to narrow it.
 */
export interface DeployedObject {
  name: string
  existed: boolean
}

export interface UpsertOutcome {
  deployed: string[]
  rollback: DeployedObject[]
}

/**
 * Write each spec to the Panorama candidate config: list existing objects by
 * name, then PUT an existing object or POST a new one. Tracks whether each
 * object existed beforehand so rollback can delete only what it created.
 * Throws on the first API error (the caller returns the partial rollback state).
 */
export async function upsertObjects(
  client: PanoramaClient,
  resourcePath: string,
  specs: UpsertSpec[],
  rollback: DeployedObject[],
  deployed: string[],
): Promise<void> {
  const listed = await client.list(resourcePath)
  if (!listed.ok) {
    throw new Error(`Failed to list existing objects at ${resourcePath}: ${panoramaErrorMessage({ status: listed.status, ok: false, body: listed.body })}`)
  }
  const existingNames = new Set(
    listed.entries.map((e) => (typeof e['@name'] === 'string' ? (e['@name'] as string).toLowerCase() : '')).filter(Boolean),
  )

  for (const spec of specs) {
    const exists = existingNames.has(spec.name.toLowerCase())
    if (exists) {
      const res = await client.updateObject(resourcePath, spec.name, spec.fields)
      if (!res.ok) throw new Error(`Failed to update "${spec.name}": ${panoramaErrorMessage(res)}`)
      rollback.push({ name: spec.name, existed: true })
    } else {
      const res = await client.createObject(resourcePath, spec.name, spec.fields)
      if (!res.ok) throw new Error(`Failed to create "${spec.name}": ${panoramaErrorMessage(res)}`)
      rollback.push({ name: spec.name, existed: false })
    }
    deployed.push(spec.name)
  }
}

/** Result of an auto-commit attempt. NON-UNION: message always present. */
export interface CommitOutcome {
  committed: boolean
  jobId: string | null
  message: string
}

/**
 * Commit the candidate to Panorama when auto_commit is enabled, polling the job
 * to completion. Returns a human message describing what happened; throws only
 * on a hard commit failure so the caller can mark the deploy failed.
 */
export async function commitIfEnabled(client: PanoramaClient, settings: PanoramaSettings): Promise<CommitOutcome> {
  if (!settings.autoCommit) {
    return {
      committed: false,
      jobId: null,
      message: 'Candidate config written but NOT committed (auto_commit is off) — commit to Panorama and push to the device group to activate.',
    }
  }
  const { jobId, noChanges } = await client.commit()
  if (noChanges || !jobId) {
    return { committed: true, jobId: null, message: 'Committed to Panorama (no changes were queued).' }
  }
  const job = await client.pollJob(jobId)
  if (!job.finished) {
    return { committed: true, jobId, message: `Commit job ${jobId} ${job.detail}.` }
  }
  if (!job.ok) {
    throw new Error(`Commit job ${jobId} finished with result ${job.detail}`)
  }
  return { committed: true, jobId, message: `Committed to Panorama (job ${jobId}, ${job.detail}).` }
}

// --- Parsing + error helpers (NON-UNION { value, error } shapes) --------------

/** Parse result for a REST collection body. Both fields always present. */
export interface EntriesParseResult {
  value: PanoramaEntry[] | null
  error: string | null
}

/**
 * Parse a REST collection body ({ result: { entry: [...] } }) into an array of
 * entries. `entry` may be a single object (count 1) or an array; both normalize.
 */
export function parseEntries(body: string): EntriesParseResult {
  const parsed = parseJson<{ result?: { entry?: PanoramaEntry | PanoramaEntry[] } }>(body)
  if (parsed.error) return { value: null, error: parsed.error }
  const entry = parsed.value?.result?.entry
  if (entry === undefined || entry === null) return { value: [], error: null }
  return { value: Array.isArray(entry) ? entry : [entry], error: null }
}

/** Parse result for a JSON body. Both fields always present. */
export interface JsonParseResult<T> {
  value: T | null
  error: string | null
}

/** Parse a JSON body without throwing. Returns a NON-UNION { value, error }. */
export function parseJson<T>(body: string): JsonParseResult<T> {
  const text = (body ?? '').trim()
  if (!text) return { value: null, error: null }
  try {
    return { value: JSON.parse(text) as T, error: null }
  } catch (err) {
    return { value: null, error: err instanceof Error ? err.message : 'invalid JSON' }
  }
}

/** Parse a JSON object field from canvas input. NON-UNION { value, error }. */
export interface JsonObjectParseResult {
  value: Record<string, unknown> | null
  error: string | null
}

export function parseJsonObject(raw: string | undefined): JsonObjectParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { value: {}, error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: 'must be a JSON object' }
  }
  return { value: parsed as Record<string, unknown>, error: null }
}

/**
 * Extract the text (or an attribute) of the first `<tag ...>...</tag>` in an XML
 * string. Returns a plain `string | null` — a nullable, not a discriminated
 * union, so it is safe for the platform handler loader. When `attrStatus` is
 * true, returns the tag's `status` attribute value instead of its text content.
 */
export function extractXmlTag(xml: string, tag: string, attrStatus = false): string | null {
  if (attrStatus) {
    const attr = new RegExp(`<${tag}\\b[^>]*\\bstatus\\s*=\\s*"([^"]*)"`, 'i').exec(xml)
    return attr ? attr[1] : null
  }
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)
  return match ? match[1].trim() : null
}

/** Human-readable message from a PAN-OS REST error response. */
export function panoramaErrorMessage(res: PanoramaResponse): string {
  const parsed = parseJson<{
    message?: string | string[]
    result?: { msg?: string | { line?: string | string[] } }
  }>(res.body)
  const val = parsed.value
  if (val) {
    if (typeof val.message === 'string' && val.message.trim()) return val.message
    if (Array.isArray(val.message) && val.message.length > 0) return val.message.join('; ')
    const msg = val.result?.msg
    if (typeof msg === 'string' && msg.trim()) return msg
    if (msg && typeof msg === 'object') {
      const line = msg.line
      if (typeof line === 'string' && line.trim()) return line
      if (Array.isArray(line) && line.length > 0) return line.join('; ')
    }
  }
  // Some PAN-OS REST errors come back as XML even on the REST endpoint.
  const xmlLine = extractXmlTag(res.body, 'line') || extractXmlTag(res.body, 'msg')
  if (xmlLine) return xmlLine
  return res.body?.trim() || `HTTP ${res.status}`
}

/** Human-readable message from a PAN-OS XML API error response. */
export function panoramaXmlErrorMessage(res: PanoramaResponse): string {
  const line = extractXmlTag(res.body, 'line') || extractXmlTag(res.body, 'msg')
  if (line) return line
  return res.body?.trim() || `HTTP ${res.status}`
}

/**
 * Coerce a settings/canvas value to a boolean. Serializers may store booleans
 * as strings or numbers; anything unrecognized keeps the default.
 */
export function coerceBoolean(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1 || value === '1' || value === 'yes') return true
  if (value === 'false' || value === 0 || value === '0' || value === 'no') return false
  return defaultValue
}

/** Split a comma/newline separated canvas value (or array) into trimmed strings. */
export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Wrap a list of members as PAN-OS { member: [...] }, or undefined when empty. */
export function memberList(values: string[]): { member: string[] } | undefined {
  return values.length > 0 ? { member: values } : undefined
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Order-insensitive, case-sensitive equality of two string lists. */
export function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((item) => bSet.has(item))
}

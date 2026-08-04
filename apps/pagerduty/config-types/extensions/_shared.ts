// Shared helpers for the PagerDuty Extensions config type
// (validate + deploy + rollback + drift + health).
//
// A PagerDuty extension lives at /extensions and is keyed for reconciliation by
// its `name` (PagerDuty assigns the server id). An extension attaches an
// extension SCHEMA (a vendor integration such as "Generic V2 Webhook", "Slack"
// or "ServiceNow") to one or more services. The operator supplies the schema and
// the services by NAME; deploy resolves both to their ids by listing
// /extension_schemas and /services.
//
// Request/response shapes follow the PagerDuty REST API v2 (verified against
// PagerDuty's official OpenAPI v2 spec):
//   list:   GET    /extensions          -> { extensions: [...] }
//   create: POST   /extensions          <- { extension: {...} }
//   get:    GET    /extensions/{id}      -> { extension: {...} }
//   update: PUT    /extensions/{id}      <- { extension: {...} }
//   delete: DELETE /extensions/{id}
//   schemas: GET   /extension_schemas    -> { extension_schemas: [...] }
//
// Docs: https://developer.pagerduty.com/api-reference/b3A6Mjc0ODEzMw-create-an-extension
//
// NOTE: the wire `ExtensionSchema` object has no `name` field — its
// human-readable label is carried in `summary` (and mirrored in `label`, a
// second free-text field PagerDuty also returns). This config type still calls
// the canvas field "extension_schema (name)" for operator familiarity — the
// same vocabulary the escalation_policy field in the services config type
// uses — but resolves it by matching `summary` first, falling back to `label`.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** APIReference to the extension schema (vendor integration) an extension applies. */
export interface ExtensionSchemaReference {
  id?: string
  type?: string
  summary?: string
}

/** APIReference to a service an extension is attached to. */
export interface ServiceObjectReference {
  id?: string
  type?: string
  summary?: string
}

/** An extension as returned by GET /extensions. */
export interface LiveExtension {
  id?: string
  type?: string
  name?: string
  endpoint_url?: string
  extension_schema?: ExtensionSchemaReference
  extension_objects?: ServiceObjectReference[]
  config?: Record<string, unknown>
}

/** An extension schema as returned by GET /extension_schemas. */
export interface LiveExtensionSchema {
  id?: string
  type?: string
  summary?: string
  label?: string
}

/** One canvas item, normalized to the fields this config type manages. */
export interface ExtensionSpec {
  itemName: string
  name: string
  /** The NAME of the extension schema to attach; resolved to an id at deploy. */
  extensionSchemaName: string
  endpointUrl: string
  /** Raw JSON text for the extension_objects array of service NAMES. */
  extensionObjectsJson: string
  /** Raw JSON text for the optional vendor-specific config object. */
  configJson: string
}

/**
 * Result of parsing the extension_objects JSON. NOT a discriminated union — the
 * platform's handler loader does not narrow `{ ok:true } | { ok:false }`, so
 * `names` and `error` are always-present nullable fields (same convention as
 * escalation-policies' RulesParseResult).
 */
export interface ExtensionObjectsParseResult {
  names: string[] | null
  error: string | null
}

/** Same nullable-pair convention as ExtensionObjectsParseResult, for the optional `config` blob. */
export interface ConfigParseResult {
  config: Record<string, unknown> | null
  error: string | null
}

/** Each canvas item describes one extension. */
export function extractExtensionSpecs(canvas: CanvasSnapshot): ExtensionSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      extensionSchemaName: typeof fields.extension_schema === 'string' ? fields.extension_schema.trim() : '',
      endpointUrl: typeof fields.endpoint_url === 'string' ? fields.endpoint_url.trim() : '',
      extensionObjectsJson: typeof fields.extension_objects === 'string' ? fields.extension_objects : '',
      configJson: typeof fields.config === 'string' ? fields.config : '',
    }
  })
}

/**
 * Parse + shallow-validate the extension_objects JSON: a non-empty array of
 * non-empty service-name strings. A blank input is an error (required field).
 */
export function parseExtensionObjects(raw: string | undefined): ExtensionObjectsParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { names: null, error: 'is required (a non-empty JSON array of service names)' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { names: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (!Array.isArray(parsed)) return { names: null, error: 'must be a JSON array of service names' }
  if (parsed.length === 0) return { names: null, error: 'must contain at least one service name' }

  const names: string[] = []
  for (let i = 0; i < parsed.length; i++) {
    const value = parsed[i]
    if (typeof value !== 'string' || !value.trim()) {
      return { names: null, error: `entry ${i + 1} must be a non-empty service name string` }
    }
    names.push(value.trim())
  }
  return { names, error: null }
}

/**
 * Parse + validate the optional `config` JSON blob: must be a plain JSON
 * object when supplied. Vendor-specific — no shape beyond "is it an object" is
 * enforced (see the driftDetect.ts header for why this stays unverified).
 */
export function parseExtensionConfig(raw: string | undefined): ConfigParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { config: null, error: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { config: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { config: null, error: 'must be a JSON object' }
  }
  return { config: parsed as Record<string, unknown>, error: null }
}

/** A loose check that a value "looks like" an http(s) URL — deploy-time is the real judge. */
export function looksLikeUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Build the request body for POST/PUT /extensions. Wrapped in an
 * { extension: {...} } envelope by callers.
 *
 * SECURITY NOTE: `endpoint_url` and `config` may carry a vendor secret (e.g. a
 * webhook token embedded in the URL, or an access_token inside config) — this
 * is the extension's OWN credential, not this app's platform credential, and
 * it is stored and displayed like any other declared field (visible in the
 * Configuration Canvas, drift diffs, and audit history).
 */
export function buildExtensionBody(
  spec: ExtensionSpec,
  extensionSchemaId: string,
  serviceIds: string[],
  config: Record<string, unknown> | null,
): LiveExtension {
  const body: LiveExtension = {
    type: 'extension',
    name: spec.name,
    extension_schema: { id: extensionSchemaId, type: 'extension_schema_reference' },
    extension_objects: serviceIds.map((id) => ({ id, type: 'service_reference' })),
  }
  if (spec.endpointUrl) body.endpoint_url = spec.endpointUrl
  if (config) body.config = config
  return body
}

/** Rebuild an extension body from its prior live shape (used by rollback restore). */
export function extensionRestoreBody(prior: LiveExtension): LiveExtension {
  const body: LiveExtension = { type: 'extension', name: String(prior.name ?? '') }
  if (prior.extension_schema?.id) {
    body.extension_schema = { id: prior.extension_schema.id, type: 'extension_schema_reference' }
  }
  if (Array.isArray(prior.extension_objects)) {
    body.extension_objects = prior.extension_objects
      .filter((o) => o.id)
      .map((o) => ({ id: o.id, type: 'service_reference' }))
  }
  if (prior.endpoint_url) body.endpoint_url = prior.endpoint_url
  if (prior.config) body.config = prior.config
  return body
}

/** Find a live extension by name (case-insensitive — the reconciliation identity). */
export function findExtension(extensions: LiveExtension[], name: string): LiveExtension | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return extensions.find((e) => String(e.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Resolve an extension schema NAME to its id, matching `summary` then `label` (case-insensitive). */
export function findExtensionSchemaId(schemas: LiveExtensionSchema[], name: string): string | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  const match = schemas.find(
    (s) => String(s.summary ?? '').trim().toLowerCase() === n || String(s.label ?? '').trim().toLowerCase() === n,
  )
  return match?.id ?? null
}

/** Resolve a service NAME to its id (case-insensitive). */
export function findServiceId(services: Array<{ id?: string; name?: string }>, name: string): string | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  const match = services.find((s) => String(s.name ?? '').trim().toLowerCase() === n)
  return match?.id ?? null
}

/** A human-readable label for a schema, preferring `summary` then `label` then its id. */
export function extensionSchemaLabel(schema: LiveExtensionSchema): string {
  return schema.summary || schema.label || schema.id || '(unnamed)'
}

import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { asArray, barracudaErrorMessage, readBool, readNumber, readString, readStringList, type BarracudaWaasClient } from '../../lib/barracudaWaf'

// --- Barracuda WAF-as-a-Service Traffic Rules constraints ---------------------
//
// A dedicated collection resource of the Application:
//   GET/POST              /applications/{appName}/traffic_rules/
//   GET/PUT/PATCH/DELETE   /applications/{appName}/traffic_rules/{name}   (no trailing slash)
// Every field (name, status, endpoints[], host_match, url_match,
// extended_match, extended_match_sequence, servers[]) is confirmed directly
// against the live API's request-body example (api.waas.barracudanetworks.com
// /v4/swagger/, operation addAppTrafficRule). Identity for reconciliation is
// the rule `name`, used directly in the URL (no separate server-assigned id).
// `endpoints`/`servers` are arrays of numeric ids referencing Application
// Endpoints/Servers (out of this app's scope — see README Coverage).

export interface TrafficRuleSpec {
  sectionName: string
  name: string
  status: boolean
  hostMatch: string
  urlMatch: string
  extendedMatch: string
  extendedMatchSequence: number
  endpoints: number[]
  endpointsInvalid: string[]
  servers: number[]
  serversInvalid: string[]
}

function readIdList(value: unknown): { ids: number[]; invalid: string[] } {
  const raw = readStringList(value)
  const ids: number[] = []
  const invalid: string[] = []
  for (const v of raw) {
    const n = Number(v)
    if (Number.isInteger(n)) ids.push(n)
    else invalid.push(v)
  }
  return { ids, invalid }
}

/** Each canvas item describes one traffic rule. */
export function extractTrafficRuleSpecs(canvas: CanvasSnapshot): TrafficRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const endpoints = readIdList(fields.endpoints)
    const servers = readIdList(fields.servers)
    return {
      sectionName: section.name,
      name: readString(fields.name),
      status: readBool(fields.status, true),
      hostMatch: readString(fields.host_match) || '*',
      urlMatch: readString(fields.url_match) || '/*',
      extendedMatch: readString(fields.extended_match) || '*',
      extendedMatchSequence: readNumber(fields.extended_match_sequence, 1),
      endpoints: endpoints.ids,
      endpointsInvalid: endpoints.invalid,
      servers: servers.ids,
      serversInvalid: servers.invalid,
    }
  })
}

/** The rule's identity key — its name. */
export function trafficRuleKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Shape of a rule returned by GET /applications/{appName}/traffic_rules/. */
export interface LiveTrafficRule {
  name?: string
  status?: boolean
  endpoints?: number[]
  host_match?: string
  url_match?: string
  extended_match?: string
  extended_match_sequence?: number
  servers?: number[]
}

/** Build the POST/PUT request body for a declared traffic rule. */
export function buildTrafficRuleBody(spec: TrafficRuleSpec): LiveTrafficRule {
  return {
    name: spec.name,
    status: spec.status,
    endpoints: spec.endpoints,
    host_match: spec.hostMatch,
    url_match: spec.urlMatch,
    extended_match: spec.extendedMatch,
    extended_match_sequence: spec.extendedMatchSequence,
    servers: spec.servers,
  }
}

/** List every traffic rule on the Application (follows pagination); throws on a non-OK response. */
export async function listTrafficRules(client: BarracudaWaasClient, appName: string): Promise<LiveTrafficRule[]> {
  const res = await client.listAll<LiveTrafficRule>(`${client.appPath(appName)}/traffic_rules/`)
  if (!res.ok) throw new Error(`Failed to list Traffic Rules: ${barracudaErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  return res.items.length ? res.items : asArray<LiveTrafficRule>(res.body)
}

/** Path to a single traffic rule by name (no trailing slash — see module doc). */
export function trafficRulePath(client: BarracudaWaasClient, appName: string, name: string): string {
  return `${client.appPath(appName)}/traffic_rules/${encodeURIComponent(name)}`
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Traffic Rules: the name is required and unique across the canvas;
 * every declared endpoint/server id must be a valid integer.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractTrafficRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = trafficRuleKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate rule name "${spec.name}" — each rule may only be declared once`, code: 'duplicate_name' })
      }
      seen.add(key)
    }

    if (spec.endpointsInvalid.length > 0) {
      errors.push({ field: `${prefix}.endpoints`, message: `Not valid integer Endpoint ids: ${spec.endpointsInvalid.join(', ')}`, code: 'invalid_id' })
    }
    if (spec.serversInvalid.length > 0) {
      errors.push({ field: `${prefix}.servers`, message: `Not valid integer Server ids: ${spec.serversInvalid.join(', ')}`, code: 'invalid_id' })
    }
    if (!Number.isInteger(spec.extendedMatchSequence) || spec.extendedMatchSequence < 0) {
      errors.push({ field: `${prefix}.extended_match_sequence`, message: 'Extended Match Sequence must be a non-negative integer', code: 'invalid_sequence' })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

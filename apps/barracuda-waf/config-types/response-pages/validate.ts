import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { asArray, barracudaErrorMessage, readString, readStringList, type BarracudaWaasClient } from '../../lib/barracudaWaf'

// --- Barracuda WAF-as-a-Service Response Pages constraints -------------------
//
// A dedicated collection resource of the Application:
//   GET/POST              /applications/{appName}/response_page_component/pages/          (list, create — trailing slash)
//   GET/PATCH/PUT/DELETE   /applications/{appName}/response_page_component/pages/{name}/  (both paths carry a trailing slash)
// Every field (name, status_code, type, headers[], body) is confirmed
// directly against the live API's request-body example
// (api.waas.barracudanetworks.com/v4/swagger/, "Add a Response Page").
// Identity for reconciliation is the page `name`, used directly in the URL
// (no separate server-assigned id, same convention as Traffic Rules/Header
// Allow-Deny rules/Rate Control Pools). `status_code` is free-text (the live
// example is a JSON string, not a number); `type` has only one confirmed
// example value ("Error Pages") and is left free-text rather than a closed
// enum (see canvas.yaml).

export interface ResponsePageSpec {
  sectionName: string
  name: string
  statusCode: string
  type: string
  headers: string[]
  body: string
}

/** Each canvas item describes one custom response page. */
export function extractResponsePageSpecs(canvas: CanvasSnapshot): ResponsePageSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: readString(fields.name),
      statusCode: readString(fields.status_code),
      type: readString(fields.type) || 'Error Pages',
      headers: readStringList(fields.headers),
      body: readString(fields.body),
    }
  })
}

/** The page's identity key — its name. */
export function responsePageKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Shape of a page returned by GET /applications/{appName}/response_page_component/pages/. */
export interface LiveResponsePage {
  name?: string
  status_code?: string
  type?: string
  headers?: string[]
  body?: string
}

/** Build the POST/PUT request body for a declared response page. */
export function buildResponsePageBody(spec: ResponsePageSpec): LiveResponsePage {
  return {
    name: spec.name,
    status_code: spec.statusCode,
    type: spec.type,
    headers: spec.headers,
    body: spec.body,
  }
}

/** List every response page on the Application (follows pagination); throws on a non-OK response. */
export async function listResponsePages(client: BarracudaWaasClient, appName: string): Promise<LiveResponsePage[]> {
  const res = await client.listAll<LiveResponsePage>(`${client.appPath(appName)}/response_page_component/pages/`)
  if (!res.ok) throw new Error(`Failed to list Response Pages: ${barracudaErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  return res.items.length ? res.items : asArray<LiveResponsePage>(res.body)
}

/** Path to a single response page by name (trailing slash — see module doc). */
export function responsePagePath(client: BarracudaWaasClient, appName: string, name: string): string {
  return `${client.appPath(appName)}/response_page_component/pages/${encodeURIComponent(name)}/`
}

// --- Validate handler ---------------------------------------------------------

const STATUS_CODE_RE = /^[1-5]\d{2}$/

/**
 * Validate Response Pages: the name is required and unique across the
 * canvas; the status code is required, and warned when it doesn't look like
 * a 3-digit HTTP status; each declared header is warned when it doesn't look
 * like a "Name: value" line.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractResponsePageSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = responsePageKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate page name "${spec.name}" — each page may only be declared once`, code: 'duplicate_name' })
      }
      seen.add(key)
    }

    if (!spec.statusCode) {
      errors.push({ field: `${prefix}.status_code`, message: 'Status Code is required', code: 'required' })
    } else if (!STATUS_CODE_RE.test(spec.statusCode)) {
      warnings.push({ field: `${prefix}.status_code`, message: `"${spec.statusCode}" does not look like a 3-digit HTTP status code`, code: 'status_code_format' })
    }

    for (const header of spec.headers) {
      if (!header.includes(':')) {
        warnings.push({ field: `${prefix}.headers`, message: `Header "${header}" does not look like a "Name: value" line`, code: 'header_format' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

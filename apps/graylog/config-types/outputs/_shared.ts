// Shared helpers for the Graylog Outputs config type (validate + deploy +
// rollback + drift). Shapes follow the Graylog REST API
// (/api/system/outputs):
//   • POST body      = CreateOutputRequest { title, type, configuration, streams? }
//   • PUT  body       = arbitrary deltas map (this app always sends
//                       { title, type, configuration })
//   • GET  response  = OutputListResponse { total, outputs: [OutputSummary] }
// Source: org.graylog2.rest.resources.system.outputs.OutputResource (@ 6.1).
//
// IMPORTANT — Graylog's output UPDATE always MERGES `configuration` into the
// existing map (OutputResource.update: `mergedConfiguration.putAll(...)`), it
// never replaces it wholesale. A key removed from the canvas declaration is
// therefore NOT removed from the live output on the next deploy — only keys
// present in the declared configuration are overwritten. This is a Graylog API
// characteristic, not a limitation of this handler; drift detection still
// compares every DECLARED key so a changed value is caught.
//
// Attaching an output to a stream (`streams`) is a separate many-to-many
// wiring action (POST/DELETE /streams/{streamId}/outputs) layered on top of
// the output's own definition — this config type manages the output object
// itself only; see the app README for the intentional scope boundary.

import { asString, parseJsonObject } from '../../lib/coerce'

/** Fully-qualified class name for Graylog's bundled GELF output (org.graylog2.outputs.GelfOutput). */
export const GELF_OUTPUT_TYPE = 'org.graylog2.outputs.GelfOutput'

/** One output as returned by GET /api/system/outputs (OutputSummary). */
export interface GraylogOutput {
  id?: string
  title?: string
  type?: string
  creator_user_id?: string
  created_at?: string
  configuration?: Record<string, unknown>
  content_pack?: string
  [key: string]: unknown
}

/** GET /api/system/outputs envelope: `{ total, outputs: [...] }`. */
interface OutputListResponse {
  total?: number
  outputs?: GraylogOutput[]
}

/** Body sent to POST /api/system/outputs (and, as deltas, to PUT .../{id}). */
export interface OutputBody {
  title: string
  type: string
  configuration: Record<string, unknown>
}

/** Unwrap GET /api/system/outputs into a flat array of outputs. */
export function outputsFromList(list: unknown): GraylogOutput[] {
  if (Array.isArray(list)) return list as GraylogOutput[]
  const outputs = (list as OutputListResponse | null)?.outputs
  return Array.isArray(outputs) ? outputs : []
}

/** Find a live output by title (the stable identity used for upsert + drift). */
export function findOutput(outputs: GraylogOutput[], title: string): GraylogOutput | null {
  const t = asString(title)
  if (!t) return null
  return outputs.find((o) => asString(o.title) === t) ?? null
}

export interface BuiltOutputBody {
  body?: OutputBody
  error?: string
}

/** Build the output body from canvas fields. */
export function buildOutputBody(fields: Record<string, unknown>): BuiltOutputBody {
  const { value: configuration, error } = parseJsonObject(fields.configuration)
  if (error) return { error: `configuration ${error}` }
  return {
    body: {
      title: asString(fields.title),
      type: asString(fields.type),
      configuration,
    },
  }
}

/** Build a restore body from a live output (rollback). */
export function bodyFromLiveOutput(output: GraylogOutput): OutputBody {
  return {
    title: asString(output.title),
    type: asString(output.type),
    configuration: (output.configuration && typeof output.configuration === 'object' ? output.configuration : {}) as Record<string, unknown>,
  }
}

// Shared helpers for the Graylog Inputs config type (validate + deploy + rollback
// + drift). Shapes follow the Graylog REST API (/api/system/inputs):
//   • POST/PUT body  = InputCreateRequest { title, type, global, configuration, node? }
//   • GET  response  = InputsList { total, inputs: [InputSummary] } — note the input's
//                      configuration values come back under `attributes`, NOT
//                      `configuration` (verified against graylog2-server
//                      rest/models/system/inputs/responses/InputSummary.java @ 6.1).
// Source: rest/resources/system/inputs/InputsResource.java (@Path /system/inputs;
//         POST/PUT -> InputCreated { id }, DELETE -> 204).

import { asString, toBool, parseJsonObject } from '../../lib/coerce'

/** One input as returned by GET /api/system/inputs (InputSummary). */
export interface GraylogInput {
  id?: string
  title?: string
  type?: string
  global?: boolean
  node?: string | null
  /** Configuration values on read live here (NOT under `configuration`). */
  attributes?: Record<string, unknown>
  static_fields?: Record<string, unknown>
  [key: string]: unknown
}

/** GET /api/system/inputs envelope: `{ total, inputs: [...] }`. */
export interface InputsListResponse {
  total?: number
  inputs?: GraylogInput[]
}

/** Body sent to POST/PUT /api/system/inputs (InputCreateRequest). */
export interface InputCreateBody {
  title: string
  type: string
  global: boolean
  configuration: Record<string, unknown>
  node?: string
}

/** POST/PUT response (InputCreated). */
export interface InputCreatedResponse {
  id?: string
}

/** Unwrap GET /api/system/inputs into a flat array of inputs. */
export function inputsFromList(list: unknown): GraylogInput[] {
  if (Array.isArray(list)) return list as GraylogInput[]
  const inputs = (list as InputsListResponse | null)?.inputs
  return Array.isArray(inputs) ? inputs : []
}

/** Find a live input by title (the stable identity used for upsert + drift). */
export function findInput(inputs: GraylogInput[], title: string): GraylogInput | null {
  const t = asString(title)
  if (!t) return null
  return inputs.find((i) => asString(i.title) === t) ?? null
}

export interface BuiltInputBody {
  body?: InputCreateBody
  error?: string
}

/** Build the InputCreateRequest body from canvas fields. */
export function buildInputBody(fields: Record<string, unknown>): BuiltInputBody {
  const { value: configuration, error } = parseJsonObject(fields.configuration)
  if (error) return { error: `configuration ${error}` }
  const body: InputCreateBody = {
    title: asString(fields.title),
    type: asString(fields.type),
    global: toBool(fields.global),
    configuration,
  }
  const node = asString(fields.node)
  if (node) body.node = node
  return { body }
}

/**
 * Rebuild a create/update body from a live input for rollback restore. The live
 * input carries its configuration under `attributes`, so it is mapped back onto
 * `configuration` here.
 */
export function bodyFromLiveInput(input: GraylogInput): InputCreateBody {
  const body: InputCreateBody = {
    title: asString(input.title),
    type: asString(input.type),
    global: toBool(input.global),
    configuration:
      input.attributes && typeof input.attributes === 'object' ? input.attributes : {},
  }
  if (typeof input.node === 'string' && input.node) body.node = input.node
  return body
}

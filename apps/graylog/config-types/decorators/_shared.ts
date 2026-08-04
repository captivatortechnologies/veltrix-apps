// Shared helpers for the Graylog Decorators (message-list decorators) config
// type (validate + deploy + rollback + drift). Shapes follow the Graylog REST
// API (/api/search/decorators):
//   • POST/PUT body  = DecoratorImpl { type, config, stream? (Optional<String>), order }
//   • GET  response  = bare JSON array of Decorator
// Source: org.graylog2.rest.resources.search.DecoratorResource,
// org.graylog2.decorators.DecoratorImpl (@ 6.1).
//
// IMPORTANT — a decorator has NO name/title field, only an id Graylog assigns
// on create. This config type therefore reconciles by the (stream, type) PAIR
// — `stream_title` blank means the GLOBAL default-stream decorator — which
// assumes at most one decorator of a given type per stream (validate warns on
// a declared duplicate). Two decorators of the SAME type on the SAME stream
// created outside this app (e.g. by hand in the Graylog UI) would collapse to
// one match here; this is a documented limitation, not a bug.

import { asString, toInt, parseJsonObject } from '../../lib/coerce'
import { getJson } from '../../lib/graylogApi'

/** A stream as returned by GET /api/streams (only the fields used here). */
interface StreamRef {
  id?: string
  title?: string
}
interface StreamListResponse {
  streams?: StreamRef[]
}

/** One decorator as returned by GET /api/search/decorators (DecoratorImpl). */
export interface GraylogDecorator {
  id?: string
  type?: string
  config?: Record<string, unknown>
  stream?: string
  order?: number
  [key: string]: unknown
}

/** Body sent to POST/PUT /api/search/decorators[/{decoratorId}]. */
export interface DecoratorBody {
  type: string
  config: Record<string, unknown>
  stream?: string
  order: number
}

/** Unwrap GET /api/search/decorators into a flat array (it is a bare array). */
export function decoratorsFromList(list: unknown): GraylogDecorator[] {
  return Array.isArray(list) ? (list as GraylogDecorator[]) : []
}

/**
 * Find a live decorator by the (stream, type) PAIR — the identity this config
 * type assumes (see the module doc above). `streamId` is '' for the global
 * (no-stream) decorator.
 */
export function findDecorator(decorators: GraylogDecorator[], streamId: string, type: string): GraylogDecorator | null {
  const t = asString(type)
  if (!t) return null
  const sid = asString(streamId)
  return decorators.find((d) => asString(d.type) === t && asString(d.stream) === sid) ?? null
}

/** Resolve a stream title to its id via GET /api/streams. Returns '' (global) for a blank title, or if not found. */
export async function resolveDecoratorStreamId(base: string, headers: Record<string, string>, streamTitle: string): Promise<string> {
  const t = asString(streamTitle)
  if (!t) return ''
  try {
    const res = await getJson<StreamListResponse | StreamRef[]>(`${base}/api/streams`, headers)
    const streams = Array.isArray(res) ? res : (res.streams ?? [])
    return asString(streams.find((s) => asString(s.title) === t)?.id)
  } catch {
    return ''
  }
}

export interface BuiltDecoratorBody {
  body?: DecoratorBody
  error?: string
}

/** Build the DecoratorImpl body from canvas fields + a resolved stream id ('' = global). */
export function buildDecoratorBody(fields: Record<string, unknown>, streamId: string): BuiltDecoratorBody {
  const { value: config, error } = parseJsonObject(fields.config)
  if (error) return { error: `config ${error}` }
  const body: DecoratorBody = {
    type: asString(fields.type),
    config,
    order: toInt(fields.order, 0),
  }
  if (streamId) body.stream = streamId
  return { body }
}

/** Build a restore body from a live decorator (rollback). */
export function bodyFromLiveDecorator(decorator: GraylogDecorator): DecoratorBody {
  const body: DecoratorBody = {
    type: asString(decorator.type),
    config: (decorator.config && typeof decorator.config === 'object' ? decorator.config : {}) as Record<string, unknown>,
    order: typeof decorator.order === 'number' ? decorator.order : 0,
  }
  if (decorator.stream) body.stream = decorator.stream
  return body
}

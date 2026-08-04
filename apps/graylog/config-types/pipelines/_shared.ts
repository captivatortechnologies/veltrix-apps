// Shared helpers for the Graylog Pipelines config type (validate + deploy +
// rollback + drift). Shapes follow the Graylog REST API
// (/api/system/pipelines/pipeline):
//   • POST/PUT body  = PipelineSource { title?, description?, source (required) }
//   • GET  response  = bare JSON array of PipelineSource
// IMPORTANT: exactly like pipeline-rules, Graylog derives the pipeline's stored
// title from its DSL declaration (`pipeline "NAME" stage 0 ... end`), NOT from
// the request body's `title` field — createFromParser/update parse `source` and
// persist `pipeline.name()` as the title (PipelineResource.java @ 6.1). The
// identity `title` therefore MUST equal the `pipeline "NAME"` in the source,
// which validate.ts enforces. The name "Default Routing" is reserved by Graylog
// for its own input-routing pipeline and cannot be (re)used here.

import { asString } from '../../lib/coerce'

/** Pipeline name reserved by Graylog for its built-in input-routing pipeline. */
export const RESERVED_PIPELINE_NAME = 'Default Routing'

/** One pipeline as returned by GET /api/system/pipelines/pipeline (PipelineSource). */
export interface GraylogPipeline {
  id?: string
  title?: string
  description?: string
  source?: string
  created_at?: string
  modified_at?: string
  stages?: unknown[]
  errors?: unknown
  [key: string]: unknown
}

/** Body sent to POST/PUT /api/system/pipelines/pipeline. */
export interface PipelineBody {
  title: string
  description: string
  source: string
}

/** GET /api/system/pipelines/pipeline returns a bare JSON array of PipelineSource. */
export function pipelinesFromList(list: unknown): GraylogPipeline[] {
  return Array.isArray(list) ? (list as GraylogPipeline[]) : []
}

/** Find a live pipeline by title (the stable identity used for upsert + drift). */
export function findPipeline(pipelines: GraylogPipeline[], title: string): GraylogPipeline | null {
  const t = asString(title)
  if (!t) return null
  return pipelines.find((p) => asString(p.title) === t) ?? null
}

/**
 * Extract the pipeline name from a Graylog pipeline DSL source:
 * `pipeline "NAME"`. Returns null when no pipeline declaration is present.
 * Unescapes \" / \\ in the name.
 */
export function extractPipelineName(source: unknown): string | null {
  const m = String(source ?? '').match(/\bpipeline\s+"((?:[^"\\]|\\.)*)"/)
  return m ? m[1].replace(/\\(["\\])/g, '$1') : null
}

/** Build the PipelineSource body from canvas fields. */
export function buildPipelineBody(fields: Record<string, unknown>): PipelineBody {
  return {
    title: asString(fields.title),
    description: asString(fields.description),
    source: String(fields.source ?? '').trim(),
  }
}

/** Build a restore body from a live pipeline (rollback). */
export function bodyFromLivePipeline(pipeline: GraylogPipeline): PipelineBody {
  return {
    title: asString(pipeline.title),
    description: asString(pipeline.description),
    source: String(pipeline.source ?? '').trim(),
  }
}

/** Collapse runs of whitespace so cosmetic reformatting isn't read as drift. */
export function normalizePipelineSource(source: unknown): string {
  return String(source ?? '').replace(/\s+/g, ' ').trim()
}

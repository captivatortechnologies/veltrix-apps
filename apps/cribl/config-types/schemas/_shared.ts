// Cribl Schemas config type — reusable JSON Schema (draft 2019-09) library
// entries over /api/v1/m/<group>/lib/schemas. Shares the generic record CRUD
// engine in lib/criblRecordEntities. A SchemaLibEntry is a flat named record:
// { id, description, schema } where `schema` is the JSON Schema, itself
// serialized as a JSON string.
//
// NOTE: Parquet Schemas (a near-identical resource at lib/parquet-schemas,
// scoped to typing Parquet destination output) are intentionally NOT covered —
// see README "Intentionally excluded".

import type { RecordDescriptor, RecordSpec } from '../../lib/criblRecordEntities'

export const SCHEMA: RecordDescriptor = {
  resource: 'lib/schemas',
  kind: 'schema',
  Kind: 'Schema',
}

export function buildSchemaRecord(fields: Record<string, unknown>, settings: Record<string, unknown>): RecordSpec {
  void settings
  const id = String(fields.id ?? '').trim()
  if (!id) return { id: '', body: null, error: null }

  const schemaText = String(fields.schema ?? '').trim()
  if (!schemaText) return { id, body: null, error: 'schema is empty — provide the JSON Schema.' }
  try {
    JSON.parse(schemaText)
  } catch (e) {
    return { id, body: null, error: `schema is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }

  const body: Record<string, unknown> = { id, schema: schemaText }
  const description = String(fields.description ?? '').trim()
  if (description) body.description = description

  return { id, body, error: null }
}

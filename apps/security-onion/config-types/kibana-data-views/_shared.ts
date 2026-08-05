// Shared helpers for the Kibana Data Views config type.

/** The subset of a Kibana `data_view` object this config type manages. */
export interface DataViewFields {
  title: string
  name: string
  timeFieldName?: string
}

/** Build the `data_view` fields from canvas item fields, omitting an unset
 *  time field so a partial update (POST .../data_view/<id>) doesn't clear it. */
export function buildDataViewFields(fields: Record<string, unknown>): DataViewFields {
  const timeFieldName = String(fields.timeFieldName ?? '').trim()
  return {
    title: String(fields.title ?? '').trim(),
    name: String(fields.name ?? '').trim(),
    ...(timeFieldName ? { timeFieldName } : {}),
  }
}

/** GET /api/data_views/data_view/<id> response envelope. */
export interface DataViewGetResponse {
  data_view?: Record<string, unknown>
}

// Cribl Subscriptions config type — bindings from an internal data-plane
// stream to a Pipeline, over /api/v1/m/<group>/system/subscriptions. Shares
// the generic record CRUD engine in lib/criblRecordEntities. A Subscription is
// a flat named record: { id, pipeline, description, disabled, filter }.
//
// NOTE: the schema also has a `consumer` block, but Cribl's own docs mark it
// "Consumers are now defined on projects instead of subscriptions" — omitted
// here as a deprecated/superseded field, matching how this app already skips
// deprecated surfaces elsewhere. Verify against a live Cribl.

import type { RecordDescriptor, RecordSpec } from '../../lib/criblRecordEntities'

export const SUBSCRIPTION: RecordDescriptor = {
  resource: 'system/subscriptions',
  kind: 'subscription',
  Kind: 'Subscription',
}

export function buildSubscriptionRecord(fields: Record<string, unknown>, settings: Record<string, unknown>): RecordSpec {
  void settings
  const id = String(fields.id ?? '').trim()
  if (!id) return { id: '', body: null, error: null }
  const pipeline = String(fields.pipeline ?? '').trim()
  if (!pipeline) return { id, body: null, error: 'pipeline is required — the Pipeline this subscription feeds.' }

  const body: Record<string, unknown> = { id, pipeline, disabled: Boolean(fields.disabled) }
  const description = String(fields.description ?? '').trim()
  if (description) body.description = description
  const filter = String(fields.filter ?? '').trim()
  if (filter) body.filter = filter

  return { id, body, error: null }
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildBusinessUnitBody, filterValuesOf } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers apply over the Orca REST API via lib/orcaApi (fetch),
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Payments',
  businessCriticality: 'high',
  ownerTeam: 'Platform',
  application: 'Checkout',
  contactEmails: ['a@example.com', 'b@example.com'],
  deploymentStages: ['prod'],
  filterType: 'cloud_providers',
  filterValues: ['aws', 'azure'],
}

// --- validate ----------------------------------------------------------------

test('validate accepts a well-formed business unit', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown criticality', async () => {
  const res = await validate(ctxOf([{ ...good, businessCriticality: 'urgent' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CRITICALITY'))
})

test('validate allows an empty (unset) criticality', async () => {
  const res = await validate(ctxOf([{ ...good, businessCriticality: '' }]))
  assert.equal(res.valid, true)
})

test('validate requires values when a scope filter type is chosen', async () => {
  const res = await validate(ctxOf([{ ...good, filterValues: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_FILTER_VALUES'))
})

test('validate accepts an org-wide unit with no filter', async () => {
  const res = await validate(ctxOf([{ name: 'Global', filterType: '', filterValues: [] }]))
  assert.equal(res.valid, true)
})

test('validate rejects more than 2 contact emails', async () => {
  const res = await validate(ctxOf([{ ...good, contactEmails: ['a@x.com', 'b@x.com', 'c@x.com'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'TOO_MANY_EMAILS'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ---------------------------------------------------------

test('buildBusinessUnitBody maps canvas fields and the chosen filter type', () => {
  const body = buildBusinessUnitBody(good)
  assert.equal(body.name, 'Payments')
  assert.equal(body.business_criticality, 'high')
  assert.equal(body.owner_team, 'Platform')
  assert.equal(body.application, 'Checkout')
  assert.deepEqual(body.contact_emails, ['a@example.com', 'b@example.com'])
  assert.deepEqual(body.deployment_stages, ['prod'])
  // cloud_providers -> cloud_provider JSON key
  assert.deepEqual(body.filter_data, { cloud_provider: ['aws', 'azure'] })
})

test('buildBusinessUnitBody maps cloud_tags to the inventory_tags key', () => {
  const body = buildBusinessUnitBody({ name: 'X', filterType: 'cloud_tags', filterValues: ['env|prod'] })
  assert.deepEqual(body.filter_data, { inventory_tags: ['env|prod'] })
})

test('buildBusinessUnitBody emits global_filter for an org-wide unit', () => {
  const body = buildBusinessUnitBody({ name: 'Global', filterType: '', global: true })
  assert.equal(body.global_filter, true)
  assert.equal(body.filter_data, undefined)
})

test('filterValuesOf reads the populated filter key back', () => {
  assert.deepEqual(filterValuesOf({ filter_data: { custom_tags: ['team|x'] } }), ['team|x'])
  assert.deepEqual(filterValuesOf({ filter_data: {} }), [])
  assert.deepEqual(filterValuesOf(null), [])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildCreateBody,
  buildPatchBody,
  managedFieldsToPatchBody,
  readManagedFields,
  readOptionalInt,
  sameManagedFields,
  snapshotManagedFields,
  SLUG_PATTERN,
  type AuthentikApplication,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the authentik Core API via
 * lib/authentikApi (node:https), which is impractical to mock here. Tests focus
 * on validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.slug ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Grafana',
  slug: 'grafana',
  provider: 3,
  meta_description: 'Metrics dashboards',
  meta_publisher: 'Grafana Labs',
  group: 'Observability',
  policy_engine_mode: 'any',
}

// --- validate ----------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing slug', async () => {
  const res = await validate(ctxOf([{ ...good, slug: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SLUG'))
})

test('validate rejects a slug with invalid characters', async () => {
  const res = await validate(ctxOf([{ ...good, slug: 'grafana dashboards!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SLUG'))
})

test('validate accepts a slug with hyphens and underscores', async () => {
  const res = await validate(ctxOf([{ ...good, slug: 'grafana-metrics_v2' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects an unknown policy_engine_mode', async () => {
  const res = await validate(ctxOf([{ ...good, policy_engine_mode: 'majority' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_POLICY_ENGINE_MODE'))
})

test('validate accepts a blank policy_engine_mode (defaults applied later)', async () => {
  const res = await validate(ctxOf([{ ...good, policy_engine_mode: '' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a non-integer provider', async () => {
  const res = await validate(ctxOf([{ ...good, provider: 'not-a-number' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PROVIDER'))
})

test('validate rejects a zero/negative provider pk', async () => {
  const res = await validate(ctxOf([{ ...good, provider: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PROVIDER'))
})

test('validate accepts a blank provider (no bound provider yet)', async () => {
  const res = await validate(ctxOf([{ ...good, provider: '' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate slug', async () => {
  const res = await validate(ctxOf([good, { ...good, name: 'Grafana (copy)' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_SLUG'))
})

test('validate accepts a fully populated application', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- _shared helpers ---------------------------------------------------------

test('SLUG_PATTERN matches authentik\'s Application.slug pattern', () => {
  assert.equal(SLUG_PATTERN.test('grafana-metrics_v2'), true)
  assert.equal(SLUG_PATTERN.test('grafana dashboards'), false)
  assert.equal(SLUG_PATTERN.test('grafana!'), false)
})

test('readOptionalInt tolerates numeric strings and blanks', () => {
  assert.equal(readOptionalInt(5), 5)
  assert.equal(readOptionalInt('7'), 7)
  assert.equal(readOptionalInt('  9  '), 9)
  assert.equal(readOptionalInt(''), null)
  assert.equal(readOptionalInt(undefined), null)
  assert.equal(readOptionalInt('not-a-number'), null)
})

test('readManagedFields trims strings and defaults an invalid/blank policy mode to "any"', () => {
  const managed = readManagedFields({ ...good, policy_engine_mode: '  ', name: '  Grafana  ' })
  assert.equal(managed.name, 'Grafana')
  assert.equal(managed.policy_engine_mode, 'any')
  assert.equal(managed.provider, 3)
})

test('buildCreateBody includes the slug alongside the managed fields', () => {
  const body = buildCreateBody('grafana', good) as Record<string, unknown>
  assert.equal(body.slug, 'grafana')
  assert.equal(body.name, 'Grafana')
  assert.equal(body.provider, 3)
  assert.equal(body.policy_engine_mode, 'any')
})

test('buildPatchBody never includes the slug', () => {
  const body = buildPatchBody(good) as Record<string, unknown>
  assert.equal('slug' in body, false)
  assert.equal(body.name, 'Grafana')
})

test('snapshotManagedFields reads a live Application and defaults an unknown policy mode', () => {
  const live: AuthentikApplication = {
    pk: 'uuid-1',
    name: 'Grafana',
    slug: 'grafana',
    provider: 3,
    meta_description: 'Metrics dashboards',
    meta_publisher: 'Grafana Labs',
    group: 'Observability',
    policy_engine_mode: 'weird-value',
  }
  const snap = snapshotManagedFields(live)
  assert.equal(snap.policy_engine_mode, 'any')
  assert.equal(snap.provider, 3)
  assert.equal(snap.group, 'Observability')
})

test('sameManagedFields compares every managed field', () => {
  const a = readManagedFields(good)
  const b = readManagedFields(good)
  assert.equal(sameManagedFields(a, b), true)
  assert.equal(sameManagedFields(a, { ...b, provider: 99 }), false)
  assert.equal(sameManagedFields(a, { ...b, policy_engine_mode: 'all' }), false)
})

test('managedFieldsToPatchBody round-trips a captured snapshot', () => {
  const managed = readManagedFields(good)
  const body = managedFieldsToPatchBody(managed) as Record<string, unknown>
  assert.equal(body.name, 'Grafana')
  assert.equal(body.provider, 3)
  assert.equal('slug' in body, false)
})

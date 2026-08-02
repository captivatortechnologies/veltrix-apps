import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { parseRoutes, buildRoutesBody, ROUTES_TABLE_DEFAULT_ID, canonicalJson } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * Routes is a singleton routing table per group. The deploy/rollback/drift
 * handlers apply over the Cribl REST API (impractical to mock), so tests focus
 * on validate.ts and the pure _shared helpers (parse / build / ordering).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>, settings: Record<string, unknown> = {}): PipelineContext {
  return { canvas: { items: toItems(list) }, settings } as unknown as PipelineContext
}

const routesJson = '{ "routes": [ { "name": "main", "filter": "true", "pipeline": "passthru", "final": true } ] }'
const good = { id: 'default', worker_group: 'default', routes: routesJson }

// --- validate ---------------------------------------------------------------

test('validate accepts a good routing table', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate defaults a blank id to "default" and still passes', async () => {
  const res = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(res.valid, true)
  assert.ok(!res.errors.some((e) => e.code === 'INVALID_ID'))
})

test('validate rejects an id with illegal characters', async () => {
  const res = await validate(ctxOf([{ ...good, id: 'bad id!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ID'))
})

test('validate rejects routes that are not valid JSON', async () => {
  const res = await validate(ctxOf([{ ...good, routes: '{ not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROUTES'))
})

test('validate rejects an object without a routes array', async () => {
  const res = await validate(ctxOf([{ ...good, routes: '{ "groups": {} }' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROUTES'))
})

test('validate warns on an empty routing table', async () => {
  const res = await validate(ctxOf([{ ...good, routes: '{ "routes": [] }' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_ROUTES'))
})

test('validate warns on a route with no name', async () => {
  const res = await validate(ctxOf([{ ...good, routes: '{ "routes": [ { "filter": "true" } ] }' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'ROUTE_NO_NAME'))
})

test('validate warns on a duplicate table for the same group', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ID'))
})

test('validate does NOT flag the same table id in different groups', async () => {
  const res = await validate(ctxOf([good, { ...good, worker_group: 'prod' }]))
  assert.equal(res.warnings.filter((w) => w.code === 'DUPLICATE_ID').length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- parseRoutes ------------------------------------------------------------

test('parseRoutes accepts a full table object and preserves extras', () => {
  const { routes, extra, error } = parseRoutes('{ "routes": [ { "name": "a" } ], "groups": { "g1": {} } }')
  assert.equal(error, null)
  assert.equal(routes?.length, 1)
  assert.deepEqual(extra, { groups: { g1: {} } })
})

test('parseRoutes wraps a bare routes array', () => {
  const { routes, error } = parseRoutes('[ { "name": "a" }, { "name": "b" } ]')
  assert.equal(error, null)
  assert.equal(routes?.length, 2)
})

test('parseRoutes rejects invalid JSON, non-objects and missing routes', () => {
  assert.ok(parseRoutes('nope').error)
  assert.ok(parseRoutes('42').error)
  assert.ok(parseRoutes('{ "foo": 1 }').error)
  assert.ok(parseRoutes('   ').error)
})

// --- buildRoutesBody + ordering ---------------------------------------------

test('buildRoutesBody defaults a blank id to "default" and keeps extras', () => {
  const body = buildRoutesBody('', [{ name: 'a' }], { groups: {} })
  assert.equal(body.id, ROUTES_TABLE_DEFAULT_ID)
  assert.equal(body.routes.length, 1)
  assert.deepEqual(body.groups, {})
})

test('route ORDER is significant for drift (canonicalJson preserves array order)', () => {
  const a = canonicalJson([{ name: 'x' }, { name: 'y' }])
  const b = canonicalJson([{ name: 'y' }, { name: 'x' }])
  assert.notEqual(a, b)
})

test('canonicalJson ignores object-key order within a route', () => {
  const a = canonicalJson([{ name: 'x', final: true }])
  const b = canonicalJson([{ final: true, name: 'x' }])
  assert.equal(a, b)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  parseFields,
  parseFilter,
  normalizeEntity,
  buildSavedQueryBody,
  buildRestoreBody,
  savedQueriesFromResponse,
  savedQueryId,
  findSavedQuery,
  createSavedQueryResource,
  updateSavedQueryResource,
  deleteSavedQueryResource,
} from '../_shared'
import { apiRoot, apiUrl, buildAuthHeaders } from '../../../lib/axoniusApi'
import type { PipelineContext, CredentialRef } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Axonius REST API via node:https
 * inside axoniusApi, which is impractical to mock here. Tests cover validate.ts and
 * the pure _shared / axoniusApi helpers (identity, body building, JSON:API
 * unwrapping, URL/auth construction).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Windows servers',
  entity: 'devices',
  query: '(specific_data.data.os.type == "Windows")',
  fields: ['specific_data.data.hostname', 'specific_data.data.name'],
}

// --- validate ---------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown asset module', async () => {
  const res = await validate(ctxOf([{ ...good, entity: 'vulnerabilities' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ENTITY'))
})

test('validate accepts both devices and users', async () => {
  for (const entity of ['devices', 'users']) {
    const res = await validate(ctxOf([{ ...good, entity }]))
    assert.equal(res.valid, true, `expected ${entity} to be valid`)
    assert.equal(res.errors.length, 0)
  }
})

test('validate warns on an empty AQL filter', async () => {
  const res = await validate(ctxOf([{ ...good, query: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_FILTER'))
})

test('validate warns on a duplicate name within the same module', async () => {
  const res = await validate(ctxOf([good, { ...good, query: 'other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate does NOT flag same name across different modules', async () => {
  const res = await validate(ctxOf([good, { ...good, entity: 'users' }]))
  assert.ok(!res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- field parsing ----------------------------------------------------------

test('parseFields accepts an array and dedupes preserving order', () => {
  assert.deepEqual(parseFields(['a', 'b', 'a', ' c ']), ['a', 'b', 'c'])
})

test('parseFields splits comma / newline strings', () => {
  assert.deepEqual(parseFields('a, b\nc'), ['a', 'b', 'c'])
})

test('parseFilter trims and normalizes empty', () => {
  assert.equal(parseFilter('  x '), 'x')
  assert.equal(parseFilter(undefined), '')
})

test('normalizeEntity defaults to devices', () => {
  assert.equal(normalizeEntity('users'), 'users')
  assert.equal(normalizeEntity('DEVICES'), 'devices')
  assert.equal(normalizeEntity('nope'), 'devices')
})

// --- body building ----------------------------------------------------------

test('buildSavedQueryBody produces a views_schema JSON:API body with view.query.filter', () => {
  const body = buildSavedQueryBody({ name: 'n', filter: 'f', columns: ['c1'], description: 'd', tags: ['t'] })
  assert.equal(body.data.type, 'views_schema')
  assert.equal(body.data.attributes.name, 'n')
  assert.deepEqual((body.data.attributes.view as Record<string, unknown>).query, { filter: 'f' })
  assert.deepEqual((body.data.attributes.view as Record<string, unknown>).fields, ['c1'])
})

test('buildSavedQueryBody omits fields when there are no columns', () => {
  const body = buildSavedQueryBody({ name: 'n', filter: '', columns: [] })
  assert.equal('fields' in (body.data.attributes.view as Record<string, unknown>), false)
})

test('buildRestoreBody wraps prior attributes verbatim', () => {
  const body = buildRestoreBody({ name: 'n', view: { query: { filter: 'x' } }, description: 'd', tags: ['t'] })
  assert.equal(body.data.type, 'views_schema')
  assert.deepEqual(body.data.attributes.view, { query: { filter: 'x' } })
})

// --- response unwrapping + identity -----------------------------------------

const listResponse = {
  data: [
    { id: 'uuid-1', type: 'views_details_schema', attributes: { name: 'Windows servers', module: 'devices', view: { query: { filter: 'q1' }, fields: ['a'] } } },
    { id: 'uuid-2', type: 'views_details_schema', attributes: { name: 'All users', module: 'users', predefined: true } },
    { id: 'uuid-3', type: 'views_details_schema', attributes: { name: 'Windows servers', module: 'users' } },
  ],
}

test('savedQueriesFromResponse flattens JSON:API rows and carries the uuid', () => {
  const rows = savedQueriesFromResponse(listResponse)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].name, 'Windows servers')
  assert.equal(savedQueryId(rows[0]), 'uuid-1')
})

test('findSavedQuery matches by name scoped to module and ignores predefined', () => {
  const rows = savedQueriesFromResponse(listResponse)
  const dev = findSavedQuery(rows, 'Windows servers', 'devices')
  assert.equal(savedQueryId(dev), 'uuid-1')
  const usr = findSavedQuery(rows, 'Windows servers', 'users')
  assert.equal(savedQueryId(usr), 'uuid-3')
  assert.equal(findSavedQuery(rows, 'All users', 'users'), null) // predefined skipped
})

// --- endpoint + auth construction -------------------------------------------

test('apiRoot is unversioned by default and versioned when api_version is set', () => {
  assert.equal(apiRoot(undefined), 'api')
  assert.equal(apiRoot({ api_version: 'V4.0' }), 'api/V4.0')
  assert.equal(apiRoot({ api_version: '/V4.0/' }), 'api/V4.0')
})

test('apiUrl joins base, root and resource paths', () => {
  assert.equal(apiUrl('https://tenant.axonius.com', undefined, 'queries/saved'), 'https://tenant.axonius.com/api/queries/saved')
  assert.equal(
    apiUrl('https://tenant.axonius.com', { api_version: 'V4.0' }, createSavedQueryResource('devices')),
    'https://tenant.axonius.com/api/V4.0/queries/devices',
  )
})

test('saved-query resource paths encode the uuid', () => {
  assert.equal(updateSavedQueryResource('a b'), 'queries/a%20b')
  assert.equal(deleteSavedQueryResource('a b'), 'queries/query/a%20b')
})

test('buildAuthHeaders maps username→api-key and apiToken→api-secret', () => {
  const cred = { username: 'KEY', apiToken: 'SECRET', password: '' } as unknown as CredentialRef
  assert.deepEqual(buildAuthHeaders(cred), { 'api-key': 'KEY', 'api-secret': 'SECRET' })
})

test('buildAuthHeaders returns empty when a half is missing', () => {
  const cred = { username: 'KEY', apiToken: '', password: '' } as unknown as CredentialRef
  assert.deepEqual(buildAuthHeaders(cred), {})
})

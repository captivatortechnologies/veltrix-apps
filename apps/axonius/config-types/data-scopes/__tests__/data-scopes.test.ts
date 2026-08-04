import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  parseText,
  parseNameList,
  buildCreateBody,
  buildUpdateBody,
  buildRestoreBody,
  dataScopesFromResponse,
  dataScopeId,
  findDataScope,
  resolveQueryNames,
  updateDataScopeResource,
  deleteDataScopeResource,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import type { AxoniusSavedQuery } from '../../saved-queries/_shared'

/**
 * The deploy/rollback/drift handlers apply over the Axonius REST API via
 * node:https inside axoniusApi, which is impractical to mock here. Tests cover
 * validate.ts and the pure _shared helpers (identity, body building, JSON:API
 * unwrapping, saved-query name resolution).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Contractors', description: 'Limited visibility', devices_queries: ['Windows servers'], users_queries: [] }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate requires at least one devices or users query', async () => {
  const res = await validate(ctxOf([{ ...good, devices_queries: [], users_queries: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SCOPES'))
})

test('validate accepts a users-only scope', async () => {
  const res = await validate(ctxOf([{ ...good, devices_queries: [], users_queries: ['All admins'] }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- field parsing ------------------------------------------------------------

test('parseNameList dedupes preserving order', () => {
  assert.deepEqual(parseNameList(['a', 'b', 'a']), ['a', 'b'])
})

test('parseText trims', () => {
  assert.equal(parseText('  x '), 'x')
})

// --- body building --------------------------------------------------------

test('buildCreateBody produces a data_scope_request_schema body', () => {
  const body = buildCreateBody({ name: 'n', description: 'd', devicesQueries: ['u1'], usersQueries: [] })
  assert.equal(body.data.type, 'data_scope_request_schema')
  assert.deepEqual(body.data.attributes.devices_queries, ['u1'])
})

test('buildUpdateBody carries the uuid in the attributes', () => {
  const body = buildUpdateBody({ uuid: 'u', name: 'n', description: '', devicesQueries: [], usersQueries: ['q1'] })
  assert.equal(body.data.attributes.uuid, 'u')
  assert.deepEqual(body.data.attributes.users_queries, ['q1'])
})

test('buildRestoreBody wraps prior attributes with the uuid', () => {
  const body = buildRestoreBody('u', { name: 'n', description: 'd', devices_queries: ['a'], users_queries: ['b'] })
  assert.equal(body.data.attributes.uuid, 'u')
  assert.deepEqual(body.data.attributes.devices_queries, ['a'])
})

// --- response unwrapping + identity -----------------------------------------

const doc = {
  data: {
    id: 'doc',
    type: 'data_scope_details_schema',
    attributes: {
      scopes: [
        { uuid: 'ds-1', name: 'Contractors', description: 'd', devices_queries: ['q1'], users_queries: [] },
        { uuid: 'ds-2', name: 'Full time', description: '', devices_queries: [], users_queries: ['q2'] },
      ],
      settings: {},
    },
  },
}

test('dataScopesFromResponse flattens the scopes array out of the single document', () => {
  const rows = dataScopesFromResponse(doc)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, 'Contractors')
  assert.equal(dataScopeId(rows[0]), 'ds-1')
})

test('findDataScope matches by exact name', () => {
  const rows = dataScopesFromResponse(doc)
  assert.equal(dataScopeId(findDataScope(rows, 'Full time')), 'ds-2')
  assert.equal(findDataScope(rows, 'Nope'), null)
})

// --- saved-query name resolution --------------------------------------------

const liveQueries: AxoniusSavedQuery[] = [
  { id: 'q-dev-1', name: 'Windows servers', module: 'devices' },
  { id: 'q-usr-1', name: 'All admins', module: 'users' },
]

test('resolveQueryNames resolves a name scoped to its module', () => {
  assert.deepEqual(resolveQueryNames(['Windows servers'], liveQueries, 'devices'), ['q-dev-1'])
  assert.deepEqual(resolveQueryNames(['All admins'], liveQueries, 'users'), ['q-usr-1'])
})

test('resolveQueryNames throws a clear error for an unresolved name', () => {
  assert.throws(() => resolveQueryNames(['Missing'], liveQueries, 'devices'), /not found/)
})

test('resolveQueryNames does not cross-match modules', () => {
  assert.throws(() => resolveQueryNames(['All admins'], liveQueries, 'devices'), /not found/)
})

// --- endpoint construction ---------------------------------------------------

test('data-scope resource paths encode the uuid', () => {
  assert.equal(updateDataScopeResource('a b'), 'settings/data_scope/a%20b')
  assert.equal(deleteDataScopeResource('a b'), 'settings/data_scope/a%20b')
})

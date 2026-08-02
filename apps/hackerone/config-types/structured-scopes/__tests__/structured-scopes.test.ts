import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  ASSET_TYPES,
  MAX_SEVERITIES,
  toBool,
  normalizeIdentifier,
  buildScopeAttributes,
  scopeWriteBody,
  groupItemsByProgram,
  findProgramId,
  scopesByIdentifier,
  type LiveScope,
  type ProgramResource,
} from '../_shared'
import type { CanvasItemSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the HackerOne API via fetch, which
 * is impractical to mock here. Tests focus on validate.ts and the pure _shared
 * helpers (attribute building, identity matching, program resolution) — all
 * network-free.
 */
function toItems(list: Array<Record<string, unknown>>): CanvasItemSnapshot[] {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.asset_identifier ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  program_handle: 'acme',
  asset_identifier: 'api.example.com',
  asset_type: 'URL',
  eligible_for_bounty: true,
  eligible_for_submission: true,
  max_severity: 'critical',
  instruction: 'Test the public API only.',
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed structured scope', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing program handle', async () => {
  const res = await validate(ctxOf([{ ...good, program_handle: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PROGRAM'))
})

test('validate rejects a missing asset identifier', async () => {
  const res = await validate(ctxOf([{ ...good, asset_identifier: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_IDENTIFIER'))
})

test('validate rejects an unknown asset type', async () => {
  const res = await validate(ctxOf([{ ...good, asset_type: 'FTP' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ASSET_TYPE'))
})

test('validate rejects an unknown max severity', async () => {
  const res = await validate(ctxOf([{ ...good, max_severity: 'urgent' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MAX_SEVERITY'))
})

test('validate accepts every documented asset type and severity', async () => {
  for (const asset_type of ASSET_TYPES) {
    const res = await validate(ctxOf([{ ...good, asset_type }]))
    assert.equal(res.valid, true, `expected asset_type ${asset_type} to be valid`)
  }
  for (const max_severity of MAX_SEVERITIES) {
    const res = await validate(ctxOf([{ ...good, max_severity }]))
    assert.equal(res.valid, true, `expected max_severity ${max_severity} to be valid`)
  }
})

test('validate warns on a duplicate asset within the same program', async () => {
  const res = await validate(ctxOf([good, { ...good, instruction: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ASSET'))
})

test('validate does not flag the same identifier under different programs', async () => {
  const res = await validate(ctxOf([good, { ...good, program_handle: 'other-program' }]))
  assert.equal(res.valid, true)
  assert.ok(!res.warnings.some((w) => w.code === 'DUPLICATE_ASSET'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- toBool -------------------------------------------------------------------

test('toBool coerces booleans, strings and falls back', () => {
  assert.equal(toBool(true), true)
  assert.equal(toBool('true'), true)
  assert.equal(toBool('1'), true)
  assert.equal(toBool('false'), false)
  assert.equal(toBool('0'), false)
  assert.equal(toBool('', true), true)
  assert.equal(toBool(undefined, true), true)
  assert.equal(toBool(undefined), false)
})

// --- buildScopeAttributes -----------------------------------------------------

test('buildScopeAttributes builds the writable attribute set', () => {
  assert.deepEqual(buildScopeAttributes(good), {
    asset_type: 'URL',
    asset_identifier: 'api.example.com',
    eligible_for_bounty: true,
    eligible_for_submission: true,
    max_severity: 'critical',
    instruction: 'Test the public API only.',
  })
})

test('buildScopeAttributes defaults eligibility and nulls empty instruction', () => {
  const attrs = buildScopeAttributes({ program_handle: 'acme', asset_identifier: 'x', asset_type: 'OTHER', max_severity: 'low' })
  assert.equal(attrs.eligible_for_submission, true) // defaults to true
  assert.equal(attrs.eligible_for_bounty, false) // defaults to false
  assert.equal(attrs.instruction, null)
})

// --- scopeWriteBody -----------------------------------------------------------

test('scopeWriteBody wraps attributes in a JSON:API document', () => {
  assert.deepEqual(scopeWriteBody({ archived: true }), { data: { type: 'structured-scope', attributes: { archived: true } } })
})

// --- groupItemsByProgram ------------------------------------------------------

test('groupItemsByProgram groups items by handle and skips blank handles', () => {
  const items = toItems([
    { program_handle: 'acme', asset_identifier: 'a' },
    { program_handle: 'acme', asset_identifier: 'b' },
    { program_handle: 'globex', asset_identifier: 'c' },
    { program_handle: '', asset_identifier: 'd' },
  ])
  const grouped = groupItemsByProgram(items)
  assert.equal(grouped.get('acme')?.length, 2)
  assert.equal(grouped.get('globex')?.length, 1)
  assert.equal(grouped.has(''), false)
})

// --- findProgramId ------------------------------------------------------------

test('findProgramId resolves a handle to its id, case-insensitively', () => {
  const programs: ProgramResource[] = [
    { id: '101', type: 'program', attributes: { handle: 'acme', name: 'Acme' } },
    { id: '202', type: 'program', attributes: { handle: 'Globex', name: 'Globex' } },
  ]
  assert.equal(findProgramId(programs, 'acme'), '101')
  assert.equal(findProgramId(programs, 'globex'), '202')
  assert.equal(findProgramId(programs, 'missing'), null)
})

// --- scopesByIdentifier + normalizeIdentifier ---------------------------------

test('scopesByIdentifier indexes scopes by normalized asset_identifier', () => {
  const scopes: LiveScope[] = [
    { id: '1', type: 'structured-scope', attributes: { asset_identifier: 'API.example.com', asset_type: 'URL' } },
    { id: '2', type: 'structured-scope', attributes: { asset_identifier: '*.example.com', asset_type: 'WILDCARD' } },
  ]
  const map = scopesByIdentifier(scopes)
  assert.equal(map.get(normalizeIdentifier('api.example.com'))?.id, '1')
  assert.equal(map.get('*.example.com')?.id, '2')
  assert.equal(map.size, 2)
})

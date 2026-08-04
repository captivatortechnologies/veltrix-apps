import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildExclusionAttributes,
  exclusionWriteBody,
  exclusionsByCategory,
  groupItemsByProgram,
  findProgramId,
  type LiveScopeExclusion,
  type ProgramResource,
} from '../_shared'
import type { CanvasItemSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the HackerOne API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (attribute building, identity matching, program resolution) —
 * all network-free.
 */
function toItems(list: Array<Record<string, unknown>>): CanvasItemSnapshot[] {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.category ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { program_handle: 'acme', category: 'Denial of Service', details: 'DoS/DDoS reports are out of scope.' }

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed scope exclusion', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing program handle', async () => {
  const res = await validate(ctxOf([{ ...good, program_handle: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PROGRAM'))
})

test('validate rejects a missing category', async () => {
  const res = await validate(ctxOf([{ ...good, category: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CATEGORY'))
})

test('validate accepts a blank details field (optional)', async () => {
  const res = await validate(ctxOf([{ ...good, details: '' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate category within the same program', async () => {
  const res = await validate(ctxOf([good, { ...good, details: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_CATEGORY'))
})

test('validate does not flag the same category under different programs', async () => {
  const res = await validate(ctxOf([good, { ...good, program_handle: 'other-program' }]))
  assert.equal(res.valid, true)
  assert.ok(!res.warnings.some((w) => w.code === 'DUPLICATE_CATEGORY'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- buildExclusionAttributes ---------------------------------------------------

test('buildExclusionAttributes builds the writable attribute set', () => {
  assert.deepEqual(buildExclusionAttributes(good), {
    category: 'Denial of Service',
    details: 'DoS/DDoS reports are out of scope.',
  })
})

// --- exclusionWriteBody ----------------------------------------------------------

test('exclusionWriteBody wraps attributes in a JSON:API document', () => {
  assert.deepEqual(exclusionWriteBody({ category: 'Spam', details: '' }), {
    data: { type: 'scope-exclusion', attributes: { category: 'Spam', details: '' } },
  })
})

// --- groupItemsByProgram (re-exported from lib/programScopes) -------------------

test('groupItemsByProgram groups items by handle and skips blank handles', () => {
  const items = toItems([
    { program_handle: 'acme', category: 'a' },
    { program_handle: 'acme', category: 'b' },
    { program_handle: 'globex', category: 'c' },
    { program_handle: '', category: 'd' },
  ])
  const grouped = groupItemsByProgram(items)
  assert.equal(grouped.get('acme')?.length, 2)
  assert.equal(grouped.get('globex')?.length, 1)
  assert.equal(grouped.has(''), false)
})

// --- findProgramId (re-exported from lib/programScopes) -------------------------

test('findProgramId resolves a handle to its id, case-insensitively', () => {
  const programs: ProgramResource[] = [{ id: '101', type: 'program', attributes: { handle: 'acme', name: 'Acme' } }]
  assert.equal(findProgramId(programs, 'ACME'), '101')
  assert.equal(findProgramId(programs, 'missing'), null)
})

// --- exclusionsByCategory ---------------------------------------------------------

test('exclusionsByCategory indexes exclusions by normalized category', () => {
  const exclusions: LiveScopeExclusion[] = [
    { id: '1', type: 'scope-exclusion', attributes: { category: 'Denial of Service', details: 'x' } },
    { id: '2', type: 'scope-exclusion', attributes: { category: 'Social Engineering', details: 'y' } },
  ]
  const map = exclusionsByCategory(exclusions)
  assert.equal(map.get('denial of service')?.id, '1')
  assert.equal(map.get('social engineering')?.id, '2')
  assert.equal(map.size, 2)
})

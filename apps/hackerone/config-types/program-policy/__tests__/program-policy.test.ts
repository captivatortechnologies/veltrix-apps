import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { policyWriteBody, readPolicyFromProgram, findProgramId, type ProgramResource } from '../_shared'
import type { CanvasItemSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the HackerOne API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (write-body building, policy-text extraction, program
 * resolution) — all network-free.
 */
function toItems(list: Array<Record<string, unknown>>): CanvasItemSnapshot[] {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.program_handle ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { program_handle: 'acme', policy: 'Please report security issues responsibly.' }

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed program policy', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing program handle', async () => {
  const res = await validate(ctxOf([{ ...good, program_handle: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PROGRAM'))
})

test('validate rejects empty policy text', async () => {
  const res = await validate(ctxOf([{ ...good, policy: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_POLICY'))
})

test('validate warns on a program declared more than once', async () => {
  const res = await validate(ctxOf([good, { ...good, policy: 'Updated text.' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_PROGRAM'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- policyWriteBody ------------------------------------------------------------

test('policyWriteBody wraps policy text in the program-policy JSON:API document', () => {
  assert.deepEqual(policyWriteBody('Report bugs here.'), {
    data: { type: 'program-policy', attributes: { policy: 'Report bugs here.' } },
  })
})

// --- readPolicyFromProgram -------------------------------------------------------

test('readPolicyFromProgram extracts policy text from a program response', () => {
  const body = { data: { id: '12', type: 'program', attributes: { handle: 'acme', policy: 'Existing policy.' } } }
  assert.equal(readPolicyFromProgram(body), 'Existing policy.')
})

test('readPolicyFromProgram returns null when the response has no policy text', () => {
  assert.equal(readPolicyFromProgram({ data: { attributes: {} } }), null)
  assert.equal(readPolicyFromProgram(null), null)
  assert.equal(readPolicyFromProgram({}), null)
})

// --- findProgramId (re-exported from lib/programScopes) -------------------------

test('findProgramId resolves a handle to its id, case-insensitively', () => {
  const programs: ProgramResource[] = [
    { id: '101', type: 'program', attributes: { handle: 'acme', name: 'Acme' } },
    { id: '202', type: 'program', attributes: { handle: 'Globex', name: 'Globex' } },
  ]
  assert.equal(findProgramId(programs, 'acme'), '101')
  assert.equal(findProgramId(programs, 'globex'), '202')
  assert.equal(findProgramId(programs, 'missing'), null)
})

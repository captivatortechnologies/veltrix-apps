import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  CREDENTIAL_INQUIRY_TYPE,
  buildInquiryDescription,
  inquiryWriteBody,
  inquiryCreateBody,
  inquiryScopeId,
  inquiriesByScopeId,
  type LiveInquiry,
} from '../_shared'
import type { CanvasItemSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the HackerOne API via fetch, which
 * is impractical to mock here. Tests focus on validate.ts and the pure _shared
 * helpers (description building, write bodies, scope-linkage resolution and
 * indexing) — all network-free.
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
  description: 'Reply with your preferred region and we will provision a sandbox account.',
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed credential inquiry', async () => {
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

test('validate rejects a missing description', async () => {
  const res = await validate(ctxOf([{ ...good, description: '   ' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DESCRIPTION'))
})

test('validate warns on a duplicate inquiry for the same scope in a program', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_INQUIRY'))
})

test('validate does not flag the same asset under different programs', async () => {
  const res = await validate(ctxOf([good, { ...good, program_handle: 'other-program' }]))
  assert.equal(res.valid, true)
  assert.ok(!res.warnings.some((w) => w.code === 'DUPLICATE_INQUIRY'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- buildInquiryDescription --------------------------------------------------

test('buildInquiryDescription trims the description', () => {
  assert.equal(buildInquiryDescription({ description: '  hello  ' }), 'hello')
  assert.equal(buildInquiryDescription({}), '')
})

// --- inquiryWriteBody / inquiryCreateBody -------------------------------------

test('inquiryWriteBody wraps a description in a JSON:API document', () => {
  assert.deepEqual(inquiryWriteBody('need creds'), {
    data: { type: CREDENTIAL_INQUIRY_TYPE, attributes: { description: 'need creds' } },
  })
})

test('inquiryCreateBody puts structured_scope_id as a top-level sibling of data', () => {
  assert.deepEqual(inquiryCreateBody('42', 'need creds'), {
    structured_scope_id: '42',
    data: { type: CREDENTIAL_INQUIRY_TYPE, attributes: { description: 'need creds' } },
  })
})

// --- inquiryScopeId -----------------------------------------------------------

test('inquiryScopeId reads the scope id from an attribute', () => {
  const inq: LiveInquiry = { id: '1', type: 'credential_inquiry', attributes: { description: 'x', structured_scope_id: 77 } }
  assert.equal(inquiryScopeId(inq), '77')
})

test('inquiryScopeId falls back to a JSON:API relationship linkage', () => {
  const inq = {
    id: '2',
    type: 'credential_inquiry',
    attributes: { description: 'x' },
    relationships: { structured_scope: { data: { id: 88 } } },
  } as unknown as LiveInquiry
  assert.equal(inquiryScopeId(inq), '88')
})

test('inquiryScopeId returns empty string when there is no linkage', () => {
  const inq: LiveInquiry = { id: '3', type: 'credential_inquiry', attributes: { description: 'x' } }
  assert.equal(inquiryScopeId(inq), '')
})

// --- inquiriesByScopeId -------------------------------------------------------

test('inquiriesByScopeId indexes inquiries by their scope id and skips unlinked ones', () => {
  const inquiries: LiveInquiry[] = [
    { id: '1', type: 'credential_inquiry', attributes: { description: 'a', structured_scope_id: '10' } },
    { id: '2', type: 'credential_inquiry', attributes: { description: 'b', structured_scope_id: '20' } },
    { id: '3', type: 'credential_inquiry', attributes: { description: 'c' } },
  ]
  const map = inquiriesByScopeId(inquiries)
  assert.equal(map.get('10')?.id, '1')
  assert.equal(map.get('20')?.id, '2')
  assert.equal(map.size, 2)
})

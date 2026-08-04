import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractCustomEmailSpecs, buildCustomEmailBody, priorFieldsOf, CUSTOM_EMAIL_TYPES } from '../_shared'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.type ?? i), fields }))
  return { items, sections: items } as unknown as CanvasSnapshot
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvasOf(list) } as unknown as PipelineContext
}

const good = { type: 'password_reset_confirmation', subject: 'Your password was reset', body: 'Hello {{firstname}}' }

// --- validate -----------------------------------------------------------------

test('validate rejects a missing type', async () => {
  const res = await validate(ctxOf([{ ...good, type: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TYPE'))
})

test('validate rejects an unrecognized type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'not_a_real_type' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects a missing subject', async () => {
  const res = await validate(ctxOf([{ ...good, subject: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SUBJECT'))
})

test('validate warns on a missing body', async () => {
  const res = await validate(ctxOf([{ ...good, body: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_BODY'))
})

test('validate errors on a duplicate type', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_TYPE'))
})

test('every JumpCloud custom email type is accepted', async () => {
  const res = await validate(ctxOf(CUSTOM_EMAIL_TYPES.map((type) => ({ ...good, type }))))
  assert.equal(res.errors.filter((e) => e.code === 'INVALID_TYPE').length, 0)
})

// --- _shared helpers ----------------------------------------------------------

test('extractCustomEmailSpecs trims fields', () => {
  const [spec] = extractCustomEmailSpecs(canvasOf([{ type: ' password_expiration ', subject: ' S ' }]))
  assert.equal(spec.type, 'password_expiration')
  assert.equal(spec.subject, 'S')
})

test('buildCustomEmailBody includes type plus all content fields', () => {
  const body = buildCustomEmailBody({
    type: 'password_expiration', subject: 'S', title: 'T', header: 'H', body: 'B', button: 'Btn', nextStepContactInfo: 'C',
  })
  assert.deepEqual(body, { type: 'password_expiration', subject: 'S', title: 'T', header: 'H', body: 'B', button: 'Btn', nextStepContactInfo: 'C' })
})

test('priorFieldsOf captures every managed field for rollback', () => {
  const prior = priorFieldsOf({ id: 'x', type: 'password_expiration', subject: 'S' })
  assert.equal(prior.type, 'password_expiration')
  assert.equal(prior.subject, 'S')
  assert.equal(prior.title, '')
})

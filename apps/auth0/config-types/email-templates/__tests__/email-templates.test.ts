import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildEmailTemplateCreateBody,
  buildEmailTemplateUpdateBody,
  snapshotEmailTemplate,
  EMAIL_TEMPLATE_NAMES,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Auth0 Management API
 * via lib/auth0Api (global fetch), which is impractical to mock here. Tests focus
 * on validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.template ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  template: 'verify_email',
  enabled: true,
  from: 'noreply@example.com',
  subject: 'Verify your email',
  syntax: 'liquid',
  body: '<p>Click {{ url }}</p>',
}

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing template', async () => {
  const res = await validate(ctxOf([{ ...good, template: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TEMPLATE'))
})

test('validate rejects an unknown template name', async () => {
  const res = await validate(ctxOf([{ ...good, template: 'not_a_real_template' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TEMPLATE'))
})

test('validate rejects a missing subject', async () => {
  const res = await validate(ctxOf([{ ...good, subject: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SUBJECT'))
})

test('validate rejects a missing body', async () => {
  const res = await validate(ctxOf([{ ...good, body: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_BODY'))
})

test('validate rejects a negative URL lifetime', async () => {
  const res = await validate(ctxOf([{ ...good, url_lifetime_in_seconds: -5 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_URL_LIFETIME'))
})

test('validate warns on a duplicate template', async () => {
  const res = await validate(ctxOf([good, { ...good, subject: 'Other subject' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TEMPLATE'))
})

test('validate accepts every known template name', async () => {
  for (const template of EMAIL_TEMPLATE_NAMES) {
    const res = await validate(ctxOf([{ ...good, template }]))
    assert.equal(res.valid, true, `expected "${template}" to validate`)
  }
})

// --- _shared ------------------------------------------------------------------

test('buildEmailTemplateCreateBody includes template and projects optional fields', () => {
  const body = buildEmailTemplateCreateBody(good)
  assert.equal(body.template, 'verify_email')
  assert.equal(body.subject, 'Verify your email')
  assert.equal(body.from, 'noreply@example.com')
  assert.equal(body.enabled, true)
})

test('buildEmailTemplateUpdateBody omits template (immutable / URL-fixed)', () => {
  const body = buildEmailTemplateUpdateBody(good) as Record<string, unknown>
  assert.equal('template' in body, false)
  assert.equal(body.subject, 'Verify your email')
})

test('buildEmailTemplateCreateBody defaults enabled to true when unset', () => {
  const body = buildEmailTemplateCreateBody({ ...good, enabled: undefined })
  assert.equal(body.enabled, true)
})

test('snapshotEmailTemplate captures managed fields', () => {
  const snap = snapshotEmailTemplate({
    template: 'verify_email',
    subject: 'Live subject',
    body: 'Live body',
    from: 'live@example.com',
    enabled: true,
  })
  assert.deepEqual(snap, { body: 'Live body', subject: 'Live subject', enabled: true, from: 'live@example.com' })
})

test('snapshotEmailTemplate defaults enabled to true when the live value is missing', () => {
  const snap = snapshotEmailTemplate({ template: 'welcome_email', subject: 'Welcome', body: 'Hi' })
  assert.equal(snap.enabled, true)
})

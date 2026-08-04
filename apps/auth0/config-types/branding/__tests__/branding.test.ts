import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildBrandingBody, buildPromptsBody, snapshotBranding, snapshotPrompts } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Auth0 Management API
 * via lib/auth0Api (global fetch), which is impractical to mock here. Tests focus
 * on validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: `item-${i}`, fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  logo_url: 'https://cdn.example.com/logo.png',
  colors_primary: '#635DFF',
  colors_page_background: '#000000',
  universal_login_experience: 'new',
  identifier_first: true,
  webauthn_platform_first_factor: false,
}

// --- validate ---------------------------------------------------------------

test('validate accepts zero items (nothing configured yet)', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, true)
})

test('validate accepts a well-formed singleton', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
})

test('validate rejects more than one item', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'SINGLETON'))
})

test('validate rejects a malformed hex color', async () => {
  const res = await validate(ctxOf([{ ...good, colors_primary: 'not-a-color' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_COLOR'))
})

test('validate rejects an unknown universal_login_experience', async () => {
  const res = await validate(ctxOf([{ ...good, universal_login_experience: 'retro' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXPERIENCE'))
})

test('validate warns when webauthn_platform_first_factor is set on the classic experience', async () => {
  const res = await validate(ctxOf([{ ...good, universal_login_experience: 'classic', webauthn_platform_first_factor: true }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'WEBAUTHN_REQUIRES_NEW_EXPERIENCE'))
})

// --- _shared ------------------------------------------------------------------

test('buildBrandingBody only includes declared fields', () => {
  const body = buildBrandingBody({ logo_url: 'https://x.example.com/l.png' })
  assert.deepEqual(body, { logo_url: 'https://x.example.com/l.png' })
})

test('buildBrandingBody omits everything when nothing is declared', () => {
  assert.deepEqual(buildBrandingBody({}), {})
})

test('buildBrandingBody groups both colors under one colors object', () => {
  const body = buildBrandingBody(good)
  assert.deepEqual(body.colors, { primary: '#635DFF', page_background: '#000000' })
})

test('buildPromptsBody is always fully declared with defaults', () => {
  const body = buildPromptsBody({})
  assert.deepEqual(body, { universal_login_experience: 'new', identifier_first: false, webauthn_platform_first_factor: false })
})

test('buildPromptsBody reflects declared values', () => {
  const body = buildPromptsBody(good)
  assert.deepEqual(body, { universal_login_experience: 'new', identifier_first: true, webauthn_platform_first_factor: false })
})

test('snapshotBranding captures only the managed keys present live', () => {
  const snap = snapshotBranding({ logo_url: 'https://live.example.com/l.png', colors: { primary: '#111111' } })
  assert.deepEqual(snap, { logo_url: 'https://live.example.com/l.png', colors: { primary: '#111111', page_background: undefined } })
})

test('snapshotPrompts defaults missing live booleans to false', () => {
  const snap = snapshotPrompts({})
  assert.deepEqual(snap, { universal_login_experience: 'new', identifier_first: false, webauthn_platform_first_factor: false })
})

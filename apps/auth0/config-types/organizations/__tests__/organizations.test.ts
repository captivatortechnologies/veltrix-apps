import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildOrganizationCreateBody,
  buildOrganizationUpdateBody,
  findOrganizationByName,
  parseEnabledConnections,
  sameEnabledConnection,
  snapshotOrganization,
  type Auth0Organization,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Auth0 Management API
 * via lib/auth0Api (global fetch), which is impractical to mock here. Tests focus
 * on validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'acme-corp',
  display_name: 'Acme Corp',
  colors_primary: '#635DFF',
  colors_page_background: '#000000',
  third_party_client_access: 'block',
  enabled_connections: 'con_abc123|assign_membership_on_login,show_as_button\ncon_def456',
}

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an uppercase name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'Acme-Corp' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects a malformed hex color', async () => {
  const res = await validate(ctxOf([{ ...good, colors_primary: 'blue' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_COLOR'))
})

test('validate rejects an invalid third_party_client_access', async () => {
  const res = await validate(ctxOf([{ ...good, third_party_client_access: 'sometimes' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACCESS_MODE'))
})

test('validate rejects malformed token_quota JSON', async () => {
  const res = await validate(ctxOf([{ ...good, token_quota: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TOKEN_QUOTA'))
})

test('validate rejects an enabled_connections line with no connection id', async () => {
  const res = await validate(ctxOf([{ ...good, enabled_connections: '|assign_membership_on_login' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ENABLED_CONNECTION'))
})

test('validate rejects an unrecognized enabled_connections flag', async () => {
  const res = await validate(ctxOf([{ ...good, enabled_connections: 'con_abc123|not_a_real_flag' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ENABLED_CONNECTION_FLAG'))
})

test('validate warns on a duplicate organization name', async () => {
  const res = await validate(ctxOf([good, { ...good, display_name: 'Other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good organization', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
})

// --- _shared ------------------------------------------------------------------

test('buildOrganizationCreateBody includes name and projects branding', () => {
  const body = buildOrganizationCreateBody(good)
  assert.equal(body.name, 'acme-corp')
  assert.deepEqual(body.branding, { colors: { primary: '#635DFF', page_background: '#000000' } })
  assert.equal(body.third_party_client_access, 'block')
})

test('buildOrganizationUpdateBody omits name (immutable)', () => {
  const body = buildOrganizationUpdateBody(good) as Record<string, unknown>
  assert.equal('name' in body, false)
  assert.equal(body.display_name, 'Acme Corp')
})

test('buildOrganizationCreateBody omits branding when no branding fields are set', () => {
  const body = buildOrganizationCreateBody({ name: 'bare-org' })
  assert.equal(body.branding, undefined)
})

test('findOrganizationByName matches by trimmed name', () => {
  const list: Auth0Organization[] = [{ id: 'org_1', name: 'acme-corp ' }]
  assert.equal(findOrganizationByName(list, 'acme-corp')?.id, 'org_1')
  assert.equal(findOrganizationByName(list, 'missing'), null)
})

test('snapshotOrganization captures managed fields', () => {
  const snap = snapshotOrganization({ id: 'org_1', name: 'acme-corp', display_name: 'Acme', metadata: { tier: 'gold' } })
  assert.deepEqual(snap, { display_name: 'Acme', metadata: { tier: 'gold' } })
})

test('parseEnabledConnections parses flags and de-duplicates by connection id (last wins)', () => {
  const specs = parseEnabledConnections('con_a|assign_membership_on_login\ncon_a|show_as_button\ncon_b')
  assert.equal(specs.length, 2)
  const a = specs.find((s) => s.connectionId === 'con_a')
  assert.deepEqual(a, { connectionId: 'con_a', assignMembershipOnLogin: false, isSignupEnabled: false, showAsButton: true })
  const b = specs.find((s) => s.connectionId === 'con_b')
  assert.deepEqual(b, { connectionId: 'con_b', assignMembershipOnLogin: false, isSignupEnabled: false, showAsButton: false })
})

test('sameEnabledConnection compares every field', () => {
  const a = { connectionId: 'con_a', assignMembershipOnLogin: true, isSignupEnabled: false, showAsButton: false }
  const b = { ...a, showAsButton: true }
  assert.equal(sameEnabledConnection(a, a), true)
  assert.equal(sameEnabledConnection(a, b), false)
})

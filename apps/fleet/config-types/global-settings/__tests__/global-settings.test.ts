import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildPatchBody, extractOwnedSections } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxOf(fieldsList: Array<Record<string, unknown>>): PipelineContext {
  const items = fieldsList.map((fields, i) => ({ id: `i${i}`, name: `item${i}`, fields }))
  return { canvas: { items } } as unknown as PipelineContext
}

const good = {
  scope: 'org',
  enableAnalytics: 'yes',
  aiFeaturesDisabled: 'no',
  enableHostUsers: 'yes',
  enableSoftwareInventory: 'yes',
  hostExpiryEnabled: 'no',
  activityExpiryEnabled: 'no',
}

test('validate rejects a non yes/no value', async () => {
  const res = await validate(ctxOf([{ ...good, enableAnalytics: 'maybe' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_YES_NO'))
})

test('validate requires a destination URL when a webhook is enabled', async () => {
  const res = await validate(ctxOf([{ ...good, hostStatusWebhookEnabled: 'yes' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_WEBHOOK_URL'))
})

test('validate warns on a webhook URL that does not look like http(s)', async () => {
  const res = await validate(ctxOf([{ ...good, hostStatusWebhookEnabled: 'yes', hostStatusWebhookUrl: 'ftp://x' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNVERIFIED_URL'))
})

test('validate accepts a good webhook config', async () => {
  const res = await validate(ctxOf([{ ...good, hostStatusWebhookEnabled: 'yes', hostStatusWebhookUrl: 'https://example.com/hook' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a non-positive expiry window', async () => {
  const res = await validate(ctxOf([{ ...good, hostExpiryWindowDays: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_WINDOW'))
})

test('validate warns when more than one item is declared (singleton)', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'SINGLETON'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared.ts -------------------------------------------------------------

test('buildPatchBody preserves an unmanaged field already on the current org_info', () => {
  const current = { org_info: { org_name: 'Old Name', contact_url: 'https://old.example.com' } }
  const body = buildPatchBody(current, { orgName: 'New Name' })
  assert.equal((body.org_info as Record<string, unknown>).org_name, 'New Name')
  assert.equal((body.org_info as Record<string, unknown>).contact_url, 'https://old.example.com')
})

test('buildPatchBody maps yes/no fields to booleans', () => {
  const body = buildPatchBody({}, { ...good, enableAnalytics: 'no' })
  assert.equal((body.server_settings as Record<string, unknown>).enable_analytics, false)
})

test('extractOwnedSections pulls only the sections this type owns', () => {
  const sections = extractOwnedSections({ org_info: { org_name: 'X' }, smtp_settings: { enable_smtp: true } } as never)
  assert.deepEqual(sections.org_info, { org_name: 'X' })
  assert.equal((sections as Record<string, unknown>).smtp_settings, undefined)
})

test('extractOwnedSections returns {} for a null config', () => {
  assert.deepEqual(extractOwnedSections(null), {})
})

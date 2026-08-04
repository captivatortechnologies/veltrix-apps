import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildChannelBody, findChannelByName, normalizeBoolean, splitList } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import type { SysdigNotificationChannel } from '../../../lib/sysdigApi'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const slack = { name: 'Slack Alerts', type: 'SLACK', enabled: true, url: 'https://hooks.slack.com/x', channel: '#alerts' }
const email = { name: 'Email Alerts', type: 'EMAIL', enabled: true, emailRecipients: 'a@x.com, b@x.com' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...slack, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown type', async () => {
  const res = await validate(ctxOf([{ ...slack, type: 'CARRIER_PIGEON' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate requires url + channel for slack', async () => {
  const res = await validate(ctxOf([{ ...slack, url: '', channel: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_URL'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CHANNEL'))
})

test('validate requires recipients for email', async () => {
  const res = await validate(ctxOf([{ ...email, emailRecipients: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_RECIPIENTS'))
})

test('validate requires a numeric team id for team email', async () => {
  const res = await validate(ctxOf([{ name: 'Team Alerts', type: 'TEAM_EMAIL', enabled: true }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TEAM_ID'))
})

test('validate accepts a good slack and email channel', async () => {
  const res = await validate(ctxOf([slack, email]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate channel name', async () => {
  const res = await validate(ctxOf([slack, { ...slack, channel: '#other' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('normalizeBoolean handles booleans, truthy/falsy strings and fallback', () => {
  assert.equal(normalizeBoolean(undefined, true), true)
  assert.equal(normalizeBoolean(false, true), false)
  assert.equal(normalizeBoolean('yes', false), true)
  assert.equal(normalizeBoolean('no', true), false)
})

test('splitList handles arrays and comma/newline strings', () => {
  assert.deepEqual(splitList(['a', ' b ', '']), ['a', 'b'])
  assert.deepEqual(splitList('a, b\nc'), ['a', 'b', 'c'])
})

test('buildChannelBody maps slack fields to the Sysdig options shape', () => {
  const body = buildChannelBody(slack)
  assert.equal(body.name, 'Slack Alerts')
  assert.equal(body.type, 'SLACK')
  assert.equal(body.enabled, true)
  assert.equal(body.options.url, slack.url)
  assert.equal(body.options.channel, slack.channel)
  assert.equal(body.options.privateChannel, false)
})

test('buildChannelBody maps email recipients', () => {
  const body = buildChannelBody(email)
  assert.deepEqual(body.options.emailRecipients, ['a@x.com', 'b@x.com'])
})

test('findChannelByName matches by exact name', () => {
  const channels: SysdigNotificationChannel[] = [
    { name: 'A', type: 'EMAIL', enabled: true, options: { notifyOnOk: false, notifyOnResolve: false, sendTestNotification: false } },
    { name: 'Slack Alerts', id: 7, type: 'SLACK', enabled: true, options: { notifyOnOk: false, notifyOnResolve: false, sendTestNotification: false } },
  ]
  assert.equal(findChannelByName(channels, 'Slack Alerts')?.id, 7)
  assert.equal(findChannelByName(channels, 'missing'), null)
})

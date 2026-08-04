import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildConfig,
  buildCreateBody,
  buildUpdateBody,
  stripSecrets,
  updateAllowsBusinessUnits,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers apply over the Orca REST API via lib/orcaApi (fetch),
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.templateName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodJira = {
  templateName: 'my-jira-cloud-template',
  service: 'jira',
  isEnabled: true,
  isDefault: false,
  jiraResourceId: 'd24c8158-e466-4c6c-b40b-f3d86dd9a4fc',
  jiraResourceUrl: 'https://acme.atlassian.net',
  jiraProjectId: '10000',
  jiraIssueTypeId: '10001',
  jiraMappingJson: JSON.stringify({ summary: ['alert_name'] }),
}

const goodSlack = {
  templateName: 'tf_slack',
  service: 'slack',
  slackWorkspaceId: 'T0A0KSCQ1B3',
  slackChannels: ['C0AE82CGDH7'],
  slackMappingJson: JSON.stringify({ title: ['alert_id'] }),
}

const goodWebhook = {
  templateName: 'alerts-webhook',
  service: 'webhook',
  webhookType: 'common',
  webhookUrl: 'https://example.com/hooks/orca',
  webhookApiKey: 'secret-token',
}

// --- validate ----------------------------------------------------------------

test('validate accepts a well-formed jira integration', async () => {
  const res = await validate(ctxOf([goodJira]))
  assert.equal(res.valid, true)
})

test('validate accepts a well-formed slack integration', async () => {
  const res = await validate(ctxOf([goodSlack]))
  assert.equal(res.valid, true)
})

test('validate accepts a well-formed webhook integration', async () => {
  const res = await validate(ctxOf([goodWebhook]))
  assert.equal(res.valid, true)
})

test('validate rejects a missing template name', async () => {
  const res = await validate(ctxOf([{ ...goodWebhook, templateName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TEMPLATE_NAME'))
})

test('validate rejects an unknown service', async () => {
  const res = await validate(ctxOf([{ ...goodWebhook, service: 'teams' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SERVICE'))
})

test('validate requires jira mapping json', async () => {
  const res = await validate(ctxOf([{ ...goodJira, jiraMappingJson: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_JIRA_MAPPING'))
})

test('validate requires at least one slack channel', async () => {
  const res = await validate(ctxOf([{ ...goodSlack, slackChannels: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SLACK_CHANNELS'))
})

test('validate rejects an unknown webhook variant', async () => {
  const res = await validate(ctxOf([{ ...goodWebhook, webhookType: 'zendesk' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_WEBHOOK_TYPE'))
})

test('validate warns on a duplicate (service, templateName) pair', async () => {
  const res = await validate(ctxOf([goodWebhook, { ...goodWebhook }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TEMPLATE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ---------------------------------------------------------

test('updateAllowsBusinessUnits is true only for webhook', () => {
  assert.equal(updateAllowsBusinessUnits('webhook'), true)
  assert.equal(updateAllowsBusinessUnits('jira'), false)
  assert.equal(updateAllowsBusinessUnits('slack'), false)
})

test('buildConfig builds the jira config block', () => {
  const config = buildConfig('jira', goodJira)
  assert.equal(config.resource_id, goodJira.jiraResourceId)
  assert.equal(config.project_id, '10000')
  assert.deepEqual(config.mapping, { summary: ['alert_name'] })
  assert.equal(config.subtask_issue_type_id, undefined)
})

test('buildConfig builds the slack config block', () => {
  const config = buildConfig('slack', goodSlack)
  assert.equal(config.workspace_id, 'T0A0KSCQ1B3')
  assert.deepEqual(config.channels, ['C0AE82CGDH7'])
  assert.equal(config.show_actions, true)
})

test('buildConfig builds the webhook config block', () => {
  const config = buildConfig('webhook', goodWebhook)
  assert.equal(config.webhook_url, goodWebhook.webhookUrl)
  assert.equal(config.type, 'common')
  assert.equal(config.api_key, 'secret-token')
})

test('buildCreateBody includes business_units on create for every service', () => {
  const body = buildCreateBody('jira', 'my-template', { ...goodJira, businessUnits: ['bu-1'] })
  assert.equal(body.service_name, 'jira')
  assert.equal(body.template_name, 'my-template')
  assert.deepEqual(body.business_units, ['bu-1'])
})

test('buildUpdateBody omits business_units for jira/slack but includes it for webhook', () => {
  const jiraUpdate = buildUpdateBody('jira', { ...goodJira, businessUnits: ['bu-1'] })
  assert.equal('business_units' in jiraUpdate, false)

  const webhookUpdate = buildUpdateBody('webhook', { ...goodWebhook, businessUnits: ['bu-1'] })
  assert.deepEqual(webhookUpdate.business_units, ['bu-1'])
})

test('stripSecrets removes api_key only for webhook', () => {
  const webhookConfig = { webhook_url: 'x', api_key: 'secret' }
  assert.deepEqual(stripSecrets('webhook', webhookConfig), { webhook_url: 'x' })

  const jiraConfig = { resource_id: 'x' }
  assert.deepEqual(stripSecrets('jira', jiraConfig), jiraConfig)
})

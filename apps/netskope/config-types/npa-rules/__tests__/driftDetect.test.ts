// driftDetect for npa-rules.
//
// The shared contract covers the refusals, the "deleted in the tenant" diff and
// the unreadable-tenant rule. What is specific here are the three changes that
// alter who gets access: a rule disabled, a block flipped to allow, and the
// private-app set changed. Netskope returns app names bracket-wrapped, so the
// comparison has to strip those before it can tell a real change from a
// formatting one.
//
// NOTE: the user, user-group, org-unit, access-method, device-classification,
// network-location and source-country criteria are deliberately not asserted.
// The handler does not diff them, so a rule widened from one user group to
// "everyone" reports as in sync — see the report accompanying these tests.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, npaList, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/policy\/npa\/rules/

const RULE = item('veltrix-alpha', {
  rule_name: 'veltrix-alpha',
  enabled: true,
  action: 'allow',
  private_apps: 'CRM',
  users: 'alice@acme.test',
})

const live = (over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
  rule_id: '4102',
  rule_name: 'veltrix-alpha',
  enabled: '1',
  rule_data: { match_criteria_action: { action_name: 'allow' }, private_apps: ['CRM'], ...data },
  ...over,
})

registerDriftContract({
  label: 'npa-rules',
  handler: driftDetect,
  basePath: '/policy/npa/rules',
  listKey: 'rules',
  items: [RULE],
  inSync: [live()],
  missingField: 'veltrix-alpha',
})

test('npa-rules driftDetect: reports a rule disabled in the console', async () => {
  const { restore } = routeFetch([{ url: BASE_RE, method: 'GET', respond: npaList('rules', [live({ enabled: '0' })]) }])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'true')
    assert.equal(diff.actual, 'false')
  } finally {
    restore()
  }
})

test('npa-rules driftDetect: reports an allow rule changed to block', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaList('rules', [live({}, { match_criteria_action: { action_name: 'block' } })]) },
  ])
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.action')
    assert.ok(diff, `expected an action diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'allow')
    assert.equal(diff.actual, 'block')
  } finally {
    restore()
  }
})

test('npa-rules driftDetect: reports a private app added to the rule in the console', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaList('rules', [live({}, { private_apps: ['CRM', 'FinanceDB'] })]) },
  ])
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.private_apps')
    assert.ok(diff, `expected a private_apps diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'CRM')
    assert.equal(diff.actual, 'CRM,FinanceDB')
  } finally {
    restore()
  }
})

test('npa-rules driftDetect: treats Netskope bracket-wrapped app names as the same names', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaList('rules', [live({}, { private_apps: ['[CRM]'] })]) },
  ])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, false, `bracket wrapping is formatting, not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('npa-rules driftDetect: treats a boolean enabled from the tenant as enabled', async () => {
  const { restore } = routeFetch([{ url: BASE_RE, method: 'GET', respond: npaList('rules', [live({ enabled: true })]) }])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, false, 'the API returns "1" on some tenants and true on others')
  } finally {
    restore()
  }
})

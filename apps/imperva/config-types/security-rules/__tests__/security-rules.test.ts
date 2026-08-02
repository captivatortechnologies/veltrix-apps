import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import validate from '../validate'
import {
  classifyRule,
  readSecurityFields,
  declaredSecurityValues,
  liveSecurityValues,
  wafRulesFromStatus,
  findWafRule,
  boolToStr,
} from '../_shared'

/**
 * The deploy/rollback/drift handlers call the Cloud WAF v1 API via fetch, which is
 * impractical to mock here. Tests cover validate.ts and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.ruleId ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const action = { siteId: '123456', ruleId: 'api.threats.sql_injection', securityRuleAction: 'api.threats.action.block_request' }
const ddos = {
  siteId: '123456',
  ruleId: 'api.threats.ddos',
  activationMode: 'api.threats.ddos.activation_mode.auto',
  ddosTrafficThreshold: '1000',
  unknownClientsChallenge: 'cookies',
  blockNonEssentialBots: 'false',
}
const bot = { siteId: '123456', ruleId: 'api.threats.bot_access_control', blockBadBots: 'true', challengeSuspectedBots: 'false' }

// --- validate ---------------------------------------------------------------

test('validate accepts a threat action rule, a ddos rule and a bot rule', async () => {
  for (const good of [action, ddos, bot]) {
    const res = await validate(ctxOf([good]))
    assert.equal(res.valid, true, JSON.stringify(res.errors))
  }
})

test('validate rejects a missing / non-numeric site ID', async () => {
  assert.ok((await validate(ctxOf([{ ...action, siteId: '' }]))).errors.some((e) => e.code === 'EMPTY_SITE_ID'))
  assert.ok((await validate(ctxOf([{ ...action, siteId: 'x' }]))).errors.some((e) => e.code === 'INVALID_SITE_ID'))
})

test('validate rejects an unknown rule id', async () => {
  const res = await validate(ctxOf([{ ...action, ruleId: 'api.threats.unknown' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RULE_ID'))
})

test('validate requires a valid action on a threat rule', async () => {
  assert.ok((await validate(ctxOf([{ ...action, securityRuleAction: '' }]))).errors.some((e) => e.code === 'EMPTY_ACTION'))
  assert.ok((await validate(ctxOf([{ ...action, securityRuleAction: 'nope' }]))).errors.some((e) => e.code === 'INVALID_ACTION'))
})

test('validate accepts every threat action and rule id', async () => {
  const rules = [
    'api.threats.sql_injection',
    'api.threats.cross_site_scripting',
    'api.threats.illegal_resource_access',
    'api.threats.remote_file_inclusion',
    'api.threats.backdoor',
  ]
  const actions = [
    'api.threats.action.block_request',
    'api.threats.action.block_ip',
    'api.threats.action.block_user',
    'api.threats.action.alert',
    'api.threats.action.disabled',
  ]
  for (const ruleId of rules) {
    for (const securityRuleAction of actions) {
      const res = await validate(ctxOf([{ siteId: '1', ruleId, securityRuleAction }]))
      assert.equal(res.valid, true, `${ruleId}/${securityRuleAction}: ${JSON.stringify(res.errors)}`)
    }
  }
})

test('validate warns when quarantine_url is used on a non-backdoor rule', async () => {
  const res = await validate(ctxOf([{ ...action, securityRuleAction: 'api.threats.action.quarantine_url' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'QUARANTINE_NON_BACKDOOR'))
})

test('validate accepts quarantine_url on backdoor with no warning', async () => {
  const res = await validate(ctxOf([{ siteId: '1', ruleId: 'api.threats.backdoor', securityRuleAction: 'api.threats.action.quarantine_url' }]))
  assert.equal(res.valid, true)
  assert.ok(!res.warnings.some((w) => w.code === 'QUARANTINE_NON_BACKDOOR'))
})

test('validate enforces ddos activation mode + threshold', async () => {
  assert.ok((await validate(ctxOf([{ ...ddos, activationMode: '' }]))).errors.some((e) => e.code === 'EMPTY_ACTIVATION_MODE'))
  assert.ok((await validate(ctxOf([{ ...ddos, activationMode: 'bad' }]))).errors.some((e) => e.code === 'INVALID_ACTIVATION_MODE'))
  assert.ok((await validate(ctxOf([{ ...ddos, ddosTrafficThreshold: '' }]))).errors.some((e) => e.code === 'EMPTY_THRESHOLD'))
  assert.ok((await validate(ctxOf([{ ...ddos, ddosTrafficThreshold: '999' }]))).errors.some((e) => e.code === 'INVALID_THRESHOLD'))
})

test('validate rejects invalid ddos challenge / bool toggles', async () => {
  assert.ok((await validate(ctxOf([{ ...ddos, unknownClientsChallenge: 'bad' }]))).errors.some((e) => e.code === 'INVALID_CHALLENGE'))
  assert.ok((await validate(ctxOf([{ ...ddos, blockNonEssentialBots: 'maybe' }]))).errors.some((e) => e.code === 'INVALID_BOOL'))
})

test('validate rejects invalid bot toggles', async () => {
  assert.ok((await validate(ctxOf([{ ...bot, blockBadBots: 'maybe' }]))).errors.some((e) => e.code === 'INVALID_BOOL'))
  assert.ok((await validate(ctxOf([{ ...bot, challengeSuspectedBots: 'maybe' }]))).errors.some((e) => e.code === 'INVALID_BOOL'))
})

test('validate warns on a duplicate (site, rule) and allows the same rule on another site', async () => {
  assert.ok((await validate(ctxOf([action, { ...action }]))).warnings.some((w) => w.code === 'DUPLICATE_RULE'))
  assert.ok(!(await validate(ctxOf([action, { ...action, siteId: '999' }]))).warnings.some((w) => w.code === 'DUPLICATE_RULE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('classifyRule maps rule ids to their parameter family', () => {
  assert.equal(classifyRule('api.threats.sql_injection'), 'action')
  assert.equal(classifyRule('api.threats.ddos'), 'ddos')
  assert.equal(classifyRule('api.threats.bot_access_control'), 'bot')
  assert.equal(classifyRule('api.threats.nope'), null)
})

test('declaredSecurityValues emits only the relevant params per kind', () => {
  assert.deepEqual(declaredSecurityValues(readSecurityFields(action)), { security_rule_action: 'api.threats.action.block_request' })
  assert.deepEqual(declaredSecurityValues(readSecurityFields(ddos)), {
    activation_mode: 'api.threats.ddos.activation_mode.auto',
    ddos_traffic_threshold: '1000',
    unknown_clients_challenge: 'cookies',
    block_non_essential_bots: 'false',
  })
  assert.deepEqual(declaredSecurityValues(readSecurityFields(bot)), { block_bad_bots: 'true', challenge_suspected_bots: 'false' })
})

test('declaredSecurityValues omits empty ddos optionals', () => {
  const v = declaredSecurityValues(readSecurityFields({ ...ddos, unknownClientsChallenge: '', blockNonEssentialBots: '' }))
  assert.deepEqual(v, { activation_mode: 'api.threats.ddos.activation_mode.auto', ddos_traffic_threshold: '1000' })
})

test('liveSecurityValues reads a status rule with the same param-name keys', () => {
  assert.deepEqual(liveSecurityValues({ id: 'api.threats.sql_injection', action: 'api.threats.action.block_ip' }, 'action'), {
    security_rule_action: 'api.threats.action.block_ip',
  })
  assert.deepEqual(
    liveSecurityValues(
      { id: 'api.threats.ddos', activation_mode: 'api.threats.ddos.activation_mode.on', ddos_traffic_threshold: 500, unknown_clients_challenge: 'captcha', block_non_essential_bots: true },
      'ddos',
    ),
    {
      activation_mode: 'api.threats.ddos.activation_mode.on',
      ddos_traffic_threshold: '500',
      unknown_clients_challenge: 'captcha',
      block_non_essential_bots: 'true',
    },
  )
  assert.deepEqual(liveSecurityValues({ id: 'api.threats.bot_access_control', block_bad_bots: false, challenge_suspected_bots: true }, 'bot'), {
    block_bad_bots: 'false',
    challenge_suspected_bots: 'true',
  })
})

test('wafRulesFromStatus + findWafRule navigate the status envelope', () => {
  const status = { res: 0, security: { waf: { rules: [{ id: 'api.threats.ddos', activation_mode: 'x' }, { id: 'api.threats.sql_injection', action: 'y' }] } } }
  const rules = wafRulesFromStatus(status)
  assert.equal(rules.length, 2)
  assert.equal(findWafRule(rules, 'api.threats.sql_injection')?.action, 'y')
  assert.equal(findWafRule(rules, 'api.threats.missing'), null)
  assert.deepEqual(wafRulesFromStatus({ res: 0 }), [])
  assert.deepEqual(wafRulesFromStatus(null), [])
})

test('boolToStr normalizes booleans, strings and numbers', () => {
  assert.equal(boolToStr(true), 'true')
  assert.equal(boolToStr(false), 'false')
  assert.equal(boolToStr('true'), 'true')
  assert.equal(boolToStr(1), 'true')
  assert.equal(boolToStr(0), 'false')
  assert.equal(boolToStr(undefined), '')
})

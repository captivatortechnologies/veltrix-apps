import validate from '../validate'
import {
  buildRulesBody,
  canonicalJson,
  extractL3FirewallRuleSpecs,
  looksLikeKnownNetworkId,
  networkIdKey,
  normalizeRule,
  parseRules,
  readBool,
} from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-meraki',
    customerId: 'cust-1',
    configTypeId: 'l3-firewall-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-meraki',
      entityType: 'l3-firewall-rules',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const goodRule = {
  comment: 'Allow HTTPS to web subnet',
  policy: 'allow',
  protocol: 'tcp',
  srcPort: 'any',
  srcCidr: 'any',
  destPort: '443',
  destCidr: '192.168.1.0/24',
  syslogEnabled: false,
}

const validFields = {
  network_id: 'L_646829496481099008',
  rules: JSON.stringify([goodRule]),
}

describe('Cisco Meraki L3 Firewall Rules Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed ruleset', async () => {
    const result = await validate(makeCtx([{ name: 'Item', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a network_id', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { rules: '[]' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'REQUIRED' && e.field.includes('network_id'))).toBe(true)
  })

  it('rejects a network_id with illegal characters', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, network_id: 'bad id!' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_NETWORK_ID')).toBe(true)
  })

  it('warns (does not error) on a network_id with an unusual prefix', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, network_id: 'X_12345' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'UNUSUAL_NETWORK_ID')).toBe(true)
  })

  it('rejects rules that are not valid JSON', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, rules: '{ not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_RULES')).toBe(true)
  })

  it('accepts a bare array or a { rules: [...] } object for the rules field', async () => {
    const bare = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, rules: JSON.stringify([goodRule]) } }]))
    const wrapped = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, rules: JSON.stringify({ rules: [goodRule] }) } }]))
    expect(bare.valid).toBe(true)
    expect(wrapped.valid).toBe(true)
  })

  it('warns on an empty ruleset', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, rules: '[]' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'EMPTY_RULES')).toBe(true)
  })

  it('rejects an unsupported policy', async () => {
    const rules = JSON.stringify([{ ...goodRule, policy: 'reject' }])
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_POLICY')).toBe(true)
  })

  it('rejects an unsupported protocol', async () => {
    const rules = JSON.stringify([{ ...goodRule, protocol: 'sctp' }])
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_PROTOCOL')).toBe(true)
  })

  it('warns on a rule with no comment', async () => {
    const rules = JSON.stringify([{ ...goodRule, comment: '' }])
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'RULE_NO_COMMENT')).toBe(true)
  })

  it('rejects a rule that is not a JSON object', async () => {
    const rules = JSON.stringify(['not-an-object'])
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_RULE')).toBe(true)
  })

  it('warns on a duplicate network_id across items (last one wins)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: validFields },
        { name: 'b', fields: { ...validFields } },
      ]),
    )
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_NETWORK_ID')).toBe(true)
  })
})

describe('Cisco Meraki L3 Firewall Rules shared helpers', () => {
  it('parseRules accepts a bare array and a wrapped object', () => {
    expect(parseRules(JSON.stringify([goodRule])).rules).toHaveLength(1)
    expect(parseRules(JSON.stringify({ rules: [goodRule] })).rules).toHaveLength(1)
  })

  it('parseRules rejects invalid JSON, non-array/object shapes and missing rules', () => {
    expect(parseRules('nope').error).toBeTruthy()
    expect(parseRules('42').error).toBeTruthy()
    expect(parseRules('{ "foo": 1 }').error).toBeTruthy()
    expect(parseRules('   ').error).toBeTruthy()
  })

  it('normalizeRule lower-cases enums, defaults match fields to "any" and coerces syslogEnabled', () => {
    const normalized = normalizeRule({ policy: 'ALLOW', protocol: 'TCP', destPort: '443' })
    expect(normalized.policy).toBe('allow')
    expect(normalized.protocol).toBe('tcp')
    expect(normalized.srcPort).toBe('any')
    expect(normalized.srcCidr).toBe('any')
    expect(normalized.destPort).toBe('443')
    expect(normalized.destCidr).toBe('any')
    expect(normalized.syslogEnabled).toBe(false)
  })

  it('buildRulesBody omits syslogDefaultRule when undefined (rollback path)', () => {
    const withFlag = buildRulesBody([], true)
    const withoutFlag = buildRulesBody([])
    expect(withFlag.syslogDefaultRule).toBe(true)
    expect('syslogDefaultRule' in withoutFlag).toBe(false)
  })

  it('canonicalJson is ORDER-SENSITIVE for arrays but ignores object-key order', () => {
    const a = canonicalJson([{ policy: 'allow' }, { policy: 'deny' }])
    const b = canonicalJson([{ policy: 'deny' }, { policy: 'allow' }])
    expect(a === b).toBe(false)

    const c = canonicalJson([{ policy: 'allow', protocol: 'tcp' }])
    const d = canonicalJson([{ protocol: 'tcp', policy: 'allow' }])
    expect(c).toBe(d)
  })

  it('looksLikeKnownNetworkId recognizes the L_/N_ prefixes only', () => {
    expect(looksLikeKnownNetworkId('L_123')).toBe(true)
    expect(looksLikeKnownNetworkId('N_123')).toBe(true)
    expect(looksLikeKnownNetworkId('X_123')).toBe(false)
  })

  it('networkIdKey trims whitespace', () => {
    expect(networkIdKey('  L_123  ')).toBe('L_123')
  })

  it('readBool behaves as documented', () => {
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(readBool(false, true)).toBe(false)
    expect(readBool(true, false)).toBe(true)
  })

  it('extractL3FirewallRuleSpecs reads and trims every field', () => {
    const specs = extractL3FirewallRuleSpecs(
      makeCtx([
        {
          name: 'e',
          fields: {
            network_id: '  L_999  ',
            comment: '  note  ',
            rules: '[]',
            syslog_default_rule: true,
          },
        },
      ]).canvas,
    )
    expect(specs[0].networkId).toBe('L_999')
    expect(specs[0].comment).toBe('note')
    expect(specs[0].syslogDefaultRule).toBe(true)
  })
})

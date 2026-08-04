import { buildNatRuleFieldsBody, listAllNatRules, snapshotLive } from '../deploy'
import type { LiveNatRule, NatRuleSpec } from '../validate'
import type { CheckpointClient } from '../../../lib/checkpointApi'

describe('snapshotLive', () => {
  it('captures only writable set-nat-rule fields, resolving members to plain names', () => {
    const snapshot = snapshotLive({
      uid: 'uid-1',
      name: 'web-nat',
      type: 'nat-rule',
      method: 'static',
      'original-source': { uid: 'obj-1', name: 'Web Servers' },
      'translated-source': { uid: 'obj-2', name: 'Public IP' },
      enabled: false,
      comments: 'prior value',
    } as LiveNatRule)

    expect(snapshot).toEqual({
      name: 'web-nat',
      enabled: false,
      method: 'static',
      'original-source': 'Web Servers',
      'original-destination': 'Any',
      'original-service': 'Any',
      'translated-source': 'Public IP',
      'translated-destination': 'Original',
      'translated-service': 'Original',
      comments: 'prior value',
    })
    expect('uid' in snapshot).toBe(false)
  })

  it('defaults an absent method/enabled to a sane baseline', () => {
    const snapshot = snapshotLive({ name: 'bare' } as LiveNatRule)
    expect(snapshot.method).toBe('hide')
    expect(snapshot.enabled).toBe(true)
  })
})

describe('buildNatRuleFieldsBody', () => {
  const baseSpec: NatRuleSpec = {
    name: 'hide-outbound',
    package: 'Standard',
    enabled: true,
    method: 'hide',
    originalSource: '',
    originalDestination: '',
    originalService: '',
    translatedSource: '',
    translatedDestination: '',
    translatedService: '',
    position: 'bottom',
    positionAnchor: '',
    installOn: [],
    comments: '',
  }

  it('defaults blank match/translation fields to Any / Original so a deploy re-asserts them', () => {
    const body = buildNatRuleFieldsBody(baseSpec)
    expect(body['original-source']).toBe('Any')
    expect(body['translated-source']).toBe('Original')
  })

  it('passes through declared values untouched', () => {
    const body = buildNatRuleFieldsBody({ ...baseSpec, originalSource: 'web-servers', translatedSource: 'public-ip' })
    expect(body['original-source']).toBe('web-servers')
    expect(body['translated-source']).toBe('public-ip')
  })

  it('omits install-on and comments when not declared', () => {
    const body = buildNatRuleFieldsBody(baseSpec)
    expect('install-on' in body).toBe(false)
    expect('comments' in body).toBe(false)
  })
})

describe('listAllNatRules', () => {
  it('filters out automatic (object-derived) NAT rules and section headers', async () => {
    const calls: unknown[] = []
    const fakeClient = {
      call: async (_command: string, params: unknown) => {
        calls.push(params)
        return {
          ok: true,
          status: 200,
          message: 'OK',
          transportError: null,
          data: {
            rulebase: [
              { type: 'nat-rule', name: 'manual-1', 'auto-generated': false },
              { type: 'nat-rule', name: 'auto-1', 'auto-generated': true },
              { type: 'nat-section', name: 'Section A' },
            ],
            total: 3,
          },
        }
      },
    } as unknown as CheckpointClient

    const rules = await listAllNatRules(fakeClient, 'Standard')
    expect(rules).toHaveLength(1)
    expect(rules[0].name).toBe('manual-1')
    expect(calls).toHaveLength(1)
  })
})

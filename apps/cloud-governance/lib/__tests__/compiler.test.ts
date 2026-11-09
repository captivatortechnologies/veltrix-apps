import { compilePack, compilePolicy, scanFilters } from '../compiler'
import type { GovernancePolicy } from '../model/types'
import { NESTINGS, actionPolicy, makeException, makePolicy } from './fixtures'

const codes = (result: { errors: Array<{ code: string }> }) => result.errors.map((e) => e.code)
const doc = (result: ReturnType<typeof compilePolicy>) => result.document?.policies[0] as Record<string, unknown>

describe('compilePolicy output', () => {
  it('golden: stopped-ec2-older-than-30-days marks for stop in 7 days', () => {
    const result = compilePolicy(makePolicy())
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.actionClass).toBe('reversible')
    expect(result.yaml).toBe(
      [
        'policies:',
        '  - name: "stopped-ec2-older-than-30-days"',
        '    description: "Mark stopped instances older than 30 days"',
        '    resource: "aws.ec2"',
        '    mode:',
        '      type: "pull"',
        '    max-resources: 100',
        '    max-resources-percent: 10',
        '    tags:',
        '      - "veltrix:policy=stopped-ec2-older-than-30-days"',
        '      - "veltrix:enforcement=auto"',
        '    filters:',
        '      - type: "value"',
        '        key: "State.Name"',
        '        value: "stopped"',
        '      - type: "value"',
        '        key: "LaunchTime"',
        '        value_type: "age"',
        '        value: 30',
        '        op: "gt"',
        '    actions:',
        '      - type: "mark-for-op"',
        '        op: "stop"',
        '        days: 7',
        '',
      ].join('\n'),
    )
    expect(result.usedTypes).toEqual({ filters: ['value'], actions: ['mark-for-op'] })
  })

  it('emits only whitelisted keys and normalises the resource prefix', () => {
    const d = doc(compilePolicy(makePolicy({ resource: 'aws.ebs', ownerTagKeys: ['Owner'], gracePeriodDays: 3 })))
    expect(Object.keys(d)).toEqual([
      'name', 'description', 'resource', 'mode', 'max-resources', 'max-resources-percent', 'tags', 'filters', 'actions',
    ])
    expect(d.resource).toBe('aws.ebs')
  })

  it('always forces mode pull', () => {
    for (const enforcement of ['observe', 'notify', 'ask', 'auto'] as const) {
      expect(doc(compilePolicy(makePolicy({ enforcement }))).mode).toEqual({ type: 'pull' })
    }
  })

  it('merges user tags with veltrix tags and lets veltrix win', () => {
    const d = doc(compilePolicy(makePolicy({ tags: { team: 'sec', 'veltrix:policy': 'spoofed' } })))
    expect(d.tags).toEqual([
      'team=sec',
      'veltrix:policy=stopped-ec2-older-than-30-days',
      'veltrix:enforcement=auto',
    ])
  })

  it('omits empty filters', () => {
    expect(Object.keys(doc(compilePolicy(makePolicy({ filters: [] })))).includes('filters')).toBe(false)
  })

  it('does not mutate the model', () => {
    const model = makePolicy()
    const snapshot = JSON.stringify(model)
    compilePolicy(model, { exceptions: [makeException()] })
    expect(JSON.stringify(model)).toBe(snapshot)
  })
})

describe('enforcement and action stripping', () => {
  it.each(['observe', 'notify'] as const)('%s strips every action but still reports the authored class', (enforcement) => {
    const result = compilePolicy(makePolicy({ enforcement, actions: ['tag', { type: 'delete' }] }))
    expect(result.ok).toBe(true)
    expect(Object.keys(doc(result)).includes('actions')).toBe(false)
    expect(result.actionClass).toBe('irreversible')
    expect(result.usedTypes.actions).toEqual([])
    expect(result.yaml?.includes('delete')).toBe(false)
  })

  it.each(['ask', 'auto'] as const)('%s keeps actions', (enforcement) => {
    const result = compilePolicy(makePolicy({ enforcement, actions: [{ type: 'stop' }] }))
    expect(doc(result).actions).toEqual([{ type: 'stop' }])
    expect(result.actionClass).toBe('reversible')
  })

  it('reports none when there are no actions', () => {
    expect(compilePolicy(makePolicy({ actions: [] })).actionClass).toBe('none')
  })

  it('classifies snapshot-delete and irreversible', () => {
    expect(compilePolicy(actionPolicy(['snapshot', 'delete'])).actionClass).toBe('snapshot-delete')
    expect(compilePolicy(actionPolicy([{ type: 'terminate' }])).actionClass).toBe('irreversible')
  })
})

describe('resource caps', () => {
  it('injects defaults', () => {
    const d = doc(compilePolicy(makePolicy()))
    expect(d['max-resources']).toBe(100)
    expect(d['max-resources-percent']).toBe(10)
  })

  it('respects the caps the author chose', () => {
    const d = doc(compilePolicy(makePolicy({ maxResources: 7, maxResourcesPercent: 50 })))
    expect(d['max-resources']).toBe(7)
    expect(d['max-resources-percent']).toBe(50)
  })

  it('rejects out-of-range caps instead of emitting them', () => {
    expect(codes(compilePolicy(makePolicy({ maxResources: 0 })))).toContain('CAP_INVALID')
    expect(compilePolicy(makePolicy({ maxResourcesPercent: 500 })).ok).toBe(false)
  })
})

describe('exceptions', () => {
  const now = new Date('2026-06-01T00:00:00Z')

  it('adds a not filter on the resource id key for unexpired exceptions', () => {
    const result = compilePolicy(makePolicy(), { exceptions: [makeException()], now })
    const filters = doc(result).filters as unknown[]
    expect(filters[filters.length - 1]).toEqual({ not: [{ type: 'value', key: 'InstanceId', value: 'i-0abc123' }] })
    expect(result.warnings).toEqual([])
  })

  it('uses the per-resource id key', () => {
    const result = compilePolicy(makePolicy({ resource: 'ebs' }), { exceptions: [makeException({ resourceId: 'vol-1' })], now })
    const filters = doc(result).filters as unknown[]
    expect(filters[filters.length - 1]).toEqual({ not: [{ type: 'value', key: 'VolumeId', value: 'vol-1' }] })
  })

  it('emits one not filter per exception', () => {
    const exceptions = [makeException({ resourceId: 'i-1' }), makeException({ resourceId: 'i-2' })]
    const filters = doc(compilePolicy(makePolicy({ filters: [] }), { exceptions, now })).filters as unknown[]
    expect(filters).toHaveLength(2)
  })

  it('drops expired exceptions with a warning and no filter', () => {
    const result = compilePolicy(makePolicy({ filters: [] }), {
      exceptions: [makeException({ expiresAt: '2026-05-31' })],
      now,
    })
    expect(result.ok).toBe(true)
    expect(Object.keys(doc(result)).includes('filters')).toBe(false)
    expect(result.warnings.map((w) => w.code)).toEqual(['EXCEPTION_EXPIRED'])
  })

  it('treats an exception expiring exactly now as expired', () => {
    const result = compilePolicy(makePolicy({ filters: [] }), {
      exceptions: [makeException({ expiresAt: '2026-06-01T00:00:00Z' })],
      now,
    })
    expect(result.warnings).toHaveLength(1)
  })

  it('ignores exceptions that belong to other policies, even malformed ones', () => {
    const result = compilePolicy(makePolicy({ filters: [] }), {
      exceptions: [makeException({ policy: 'other' }), { policy: 'other' } as never],
      now,
    })
    expect(result.ok).toBe(true)
    expect(result.warnings).toEqual([])
    expect(Object.keys(doc(result)).includes('filters')).toBe(false)
  })

  it('fails closed on a malformed exception for this policy', () => {
    const result = compilePolicy(makePolicy(), { exceptions: [makeException({ expiresAt: 'soon' })], now })
    expect(result.ok).toBe(false)
    expect(result.errors[0].path).toBe('exceptions.0.expiresAt')
  })

  it('warns when an ARN cannot match the resource id key', () => {
    const result = compilePolicy(makePolicy(), { exceptions: [makeException({ resourceId: 'arn:aws:ec2:::i-1' })], now })
    expect(result.warnings.map((w) => w.code)).toEqual(['EXCEPTION_ARN_UNMATCHED'])
  })

  it('includes the exception filter type in usedTypes', () => {
    const result = compilePolicy(makePolicy({ filters: [{ type: 'instance-age', days: 3 }] }), {
      exceptions: [makeException()],
      now,
    })
    expect(result.usedTypes.filters).toEqual(['instance-age', 'value'])
  })
})

describe('deny list: filters (top level and nested in or/and/not)', () => {
  const cases: ReadonlyArray<readonly [string, string, Record<string, unknown> | string]> = [
    ['FILTER_VALUE_FROM', 'value_from', { type: 'value', key: 'tag:Owner', value_from: { url: 'file:///etc/passwd', format: 'txt' } }],
    ['FILTER_VALUE_FROM', 'value-from', { type: 'value', key: 'k', 'value-from': { url: 'http://169.254.169.254/latest', format: 'json' } }],
    ['FILTER_TYPE_NOT_ALLOWED', 'type', { type: 'event', key: 'detail.x', value: 1 }],
    ['FILTER_TYPE_NOT_ALLOWED', '', 'event'],
  ]

  for (const [code, , filter] of cases) {
    for (const [where, wrap, base] of NESTINGS) {
      it(`${code} rejected ${where}: ${typeof filter === 'string' ? filter : Object.keys(filter).join(',')}`, () => {
        const result = compilePolicy(makePolicy({ filters: wrap(filter as never) }))
        expect(result.ok).toBe(false)
        expect(result.document).toBeNull()
        expect(result.yaml).toBeNull()
        expect(codes(result)).toContain(code)
        expect(result.errors.some((e) => e.path.startsWith(base))).toBe(true)
      })
    }
  }

  it('reports the exact path of a nested value_from', () => {
    const result = compilePolicy(makePolicy({ filters: [{ or: [{ and: [{ type: 'value', key: 'a', value_from: { url: 'x' } }] }] }] }))
    expect(result.errors.map((e) => e.path)).toEqual(['filters.0.or.0.and.0.value_from'])
  })

  it('finds value_from buried inside a non-group filter', () => {
    const result = compilePolicy(
      makePolicy({ filters: [{ type: 'list-item', key: 'x', attrs: [{ type: 'value', value_from: { url: 'file:///x' } }] }] }),
    )
    expect(codes(result)).toContain('FILTER_VALUE_FROM')
  })

  it('rejects malformed filters instead of passing them through', () => {
    expect(codes(compilePolicy(makePolicy({ filters: [{ or: 'x' }] as never })))).toContain('FILTER_INVALID')
    expect(codes(compilePolicy(makePolicy({ filters: [{ key: 'orphan' }] as never })))).toContain('FILTER_INVALID')
  })

  it('keeps metrics and ordinary filters allowed', () => {
    const result = compilePolicy(makePolicy({ filters: [{ type: 'metrics', name: 'CPUUtilization', days: 7, value: 5, op: 'lt' }, 'ebs'] }))
    expect(result.ok).toBe(true)
  })

  it('scanFilters walks groups and collects types', () => {
    const { issues, types } = scanFilters([{ or: [{ type: 'a' }, { not: [{ type: 'b' }, 'c'] }] }])
    expect(issues).toEqual([])
    expect(types).toEqual(['a', 'b', 'c'])
  })

  it('scanFilters stops on pathological nesting', () => {
    let spec: Record<string, unknown> = { type: 'value' }
    for (let i = 0; i < 200; i += 1) spec = { not: [spec] }
    expect(scanFilters([spec]).issues.map((i) => i.code)).toContain('FILTER_TOO_DEEP')
  })
})

describe('deny list: actions', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['ACTION_WEBHOOK', 'webhook'],
    ['ACTION_INVOKE_LAMBDA', 'invoke-lambda'],
    ['ACTION_INVOKE_SFN', 'invoke-sfn'],
    ['ACTION_NOTIFY', 'notify'],
    ['UNKNOWN_ACTION_TYPE', 'frobnicate'],
    ['UNKNOWN_ACTION_TYPE', 'Stop'],
  ]

  for (const [code, type] of cases) {
    it(`${code} rejects object action "${type}"`, () => {
      const result = compilePolicy(actionPolicy([{ type, url: 'https://evil.example' }]))
      expect(result.ok).toBe(false)
      expect(codes(result)).toContain(code)
      expect(result.errors[0].path).toBe('actions.0.type')
    })

    it(`${code} rejects string action "${type}"`, () => {
      expect(codes(compilePolicy(actionPolicy(['tag', type])))).toContain(code)
    })

    it(`${code} rejects "${type}" even when enforcement strips actions`, () => {
      expect(compilePolicy(makePolicy({ enforcement: 'observe', actions: [{ type }] })).ok).toBe(false)
    })
  }

  it('rejects value_from inside an action', () => {
    const result = compilePolicy(actionPolicy([{ type: 'tag', tags: { a: 'b' }, value_from: { url: 'file:///x' } }]))
    expect(codes(result)).toContain('FILTER_VALUE_FROM')
  })

  it('rejects an action without a type', () => {
    expect(codes(compilePolicy(actionPolicy([{ days: 1 } as never])))).toContain('ACTION_INVALID')
  })
})

describe('deny list: policy shape', () => {
  it('MODE_NOT_ALLOWED when the author sets mode', () => {
    for (const mode of [{ type: 'pull' }, { type: 'periodic', schedule: 'rate(1 day)' }, 'pull']) {
      const result = compilePolicy({ ...makePolicy(), mode } as GovernancePolicy)
      expect(codes(result)).toContain('MODE_NOT_ALLOWED')
      expect(result.errors.find((e) => e.code === 'MODE_NOT_ALLOWED')?.path).toBe('mode')
    }
  })

  it('CONDITIONS_NOT_ALLOWED', () => {
    expect(codes(compilePolicy({ ...makePolicy(), conditions: [{ type: 'value' }] } as GovernancePolicy))).toContain('CONDITIONS_NOT_ALLOWED')
  })

  it('UNKNOWN_POLICY_KEY for anything else', () => {
    for (const key of ['execution-options', 'source', 'role', 'member-role', 'max-resources', 'comment']) {
      expect(codes(compilePolicy({ ...makePolicy(), [key]: 1 } as GovernancePolicy))).toContain('UNKNOWN_POLICY_KEY')
    }
  })

  it('RESOURCE_NOT_ALLOWED', () => {
    for (const resource of ['aws.ec3', 'azure.vm', 'gcp.instance', 'ec2 ; drop']) {
      expect(codes(compilePolicy(makePolicy({ resource })))).toContain('RESOURCE_NOT_ALLOWED')
    }
  })

  it('returns a non-union failure with every field present', () => {
    const result = compilePolicy(null as never)
    expect(result.ok).toBe(false)
    expect(result.document).toBeNull()
    expect(result.yaml).toBeNull()
    expect(result.warnings).toEqual([])
    expect(result.actionClass).toBe('none')
    expect(result.usedTypes).toEqual({ filters: [], actions: [] })
  })

  it('collects every violation in one pass', () => {
    const result = compilePolicy({
      ...makePolicy({ filters: [{ type: 'event' }], actions: [{ type: 'webhook' }] }),
      mode: {},
    } as GovernancePolicy)
    expect(codes(result).sort()).toEqual(['ACTION_WEBHOOK', 'FILTER_TYPE_NOT_ALLOWED', 'MODE_NOT_ALLOWED'])
  })
})

describe('compilePack', () => {
  const policies: Record<string, GovernancePolicy> = {
    'stopped-ec2': makePolicy({ name: 'stopped-ec2' }),
    'old-volumes': makePolicy({
      name: 'old-volumes',
      resource: 'ebs',
      filters: [{ type: 'value', key: 'State', value: 'available' }],
      actions: ['snapshot', 'delete'],
    }),
  }

  it('compiles members into one document in pack order', () => {
    const result = compilePack({ name: 'baseline', policies: ['old-volumes', 'stopped-ec2'] }, policies)
    expect(result.ok).toBe(true)
    expect(result.document?.policies.map((p) => p.name)).toEqual(['old-volumes', 'stopped-ec2'])
    expect(result.yaml?.startsWith('policies:\n  - name: "old-volumes"')).toBe(true)
    expect(result.actionClass).toBe('snapshot-delete')
    expect(result.usedTypes).toEqual({ filters: ['value'], actions: ['delete', 'mark-for-op', 'snapshot'] })
  })

  it('fails when a member is missing', () => {
    const result = compilePack({ name: 'baseline', policies: ['stopped-ec2', 'ghost'] }, policies)
    expect(result.ok).toBe(false)
    expect(result.document).toBeNull()
    expect(result.errors).toEqual([
      { path: 'policies.1', code: 'PACK_MEMBER_MISSING', message: 'Policy "ghost" is not available to compile' },
    ])
  })

  it('does not resolve prototype keys as members', () => {
    expect(codes(compilePack({ name: 'p', policies: ['constructor'] }, policies))).toEqual(['PACK_MEMBER_MISSING'])
  })

  it('fails the whole pack when one member is unsafe and prefixes the path', () => {
    const bad = { ...policies, 'stopped-ec2': makePolicy({ name: 'stopped-ec2', actions: [{ type: 'webhook' }] }) }
    const result = compilePack({ name: 'baseline', policies: ['old-volumes', 'stopped-ec2'] }, bad)
    expect(result.ok).toBe(false)
    expect(result.errors[0].path).toBe('policies.1.stopped-ec2.actions.0.type')
    expect(result.errors[0].code).toBe('ACTION_WEBHOOK')
  })

  it('applies exceptions per member and merges warnings', () => {
    const result = compilePack({ name: 'baseline', policies: ['stopped-ec2'] }, policies, {
      exceptions: [makeException({ policy: 'stopped-ec2', expiresAt: '2020-01-01' })],
      now: new Date('2026-06-01T00:00:00Z'),
    })
    expect(result.ok).toBe(true)
    expect(result.warnings.map((w) => w.code)).toEqual(['EXCEPTION_EXPIRED'])
  })

  it('rejects an invalid pack', () => {
    const result = compilePack({ name: 'BAD', policies: [] }, policies)
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('NAME_INVALID')
  })
})

describe('gracePeriodDays', () => {
  it('fills days on mark-for-op actions that lack it', () => {
    const result = compilePolicy(makePolicy({ gracePeriodDays: 14, actions: [{ type: 'mark-for-op', op: 'stop' }, 'mark-for-op'] }))
    expect(doc(result).actions).toEqual([
      { type: 'mark-for-op', op: 'stop', days: 14 },
      { type: 'mark-for-op', days: 14 },
    ])
    expect(result.warnings).toEqual([])
  })

  it('keeps an explicit days value', () => {
    const result = compilePolicy(makePolicy({ gracePeriodDays: 14 }))
    expect(doc(result).actions).toEqual([{ type: 'mark-for-op', op: 'stop', days: 7 }])
  })

  it('leaves actions untouched when gracePeriodDays is unset', () => {
    const result = compilePolicy(makePolicy({ actions: [{ type: 'mark-for-op', op: 'stop' }] }))
    expect(doc(result).actions).toEqual([{ type: 'mark-for-op', op: 'stop' }])
  })

  it('warns GRACE_PERIOD_UNUSED without a mark-for-op action', () => {
    const result = compilePolicy(makePolicy({ gracePeriodDays: 5, actions: [{ type: 'stop' }] }))
    expect(result.ok).toBe(true)
    expect(result.warnings).toEqual([
      { path: 'gracePeriodDays', code: 'GRACE_PERIOD_UNUSED', message: 'gracePeriodDays has no effect without a mark-for-op action' },
    ])
  })

  it('does not warn for observe policies that author mark-for-op, and never emits ownerTagKeys', () => {
    const result = compilePolicy(
      makePolicy({ gracePeriodDays: 5, enforcement: 'observe', actions: [{ type: 'mark-for-op', op: 'stop' }], ownerTagKeys: ['Owner'] }),
    )
    expect(result.warnings).toEqual([])
    expect(result.yaml?.includes('Owner')).toBe(false)
  })
})

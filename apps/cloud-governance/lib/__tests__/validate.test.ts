import {
  AWS_RESOURCES,
  ACTION_CLASS,
  classifyActionType,
  classifyActions,
  isAllowedResource,
  normalizeResource,
  resourceIdKey,
  validateException,
  validatePack,
  validatePolicy,
  validateSchedule,
  isValidCron,
} from '../model'
import { makeException, makePolicy } from './fixtures'

const codes = (errors: Array<{ code: string }>) => errors.map((e) => e.code)

describe('aws resource allow-list', () => {
  it('contains the curated phase 0 resources', () => {
    expect(AWS_RESOURCES).toHaveLength(40)
    for (const r of ['ec2', 'ebs', 's3', 'iam-role', 'ssm-parameter', 'secrets-manager']) {
      expect(isAllowedResource(r)).toBe(true)
    }
  })

  it('accepts the aws. prefix and normalises it away', () => {
    expect(isAllowedResource('aws.ec2')).toBe(true)
    expect(normalizeResource('aws.ec2')).toBe('ec2')
    expect(normalizeResource(' ec2 ')).toBe('ec2')
  })

  it('rejects unknown resources and other providers', () => {
    expect(isAllowedResource('azure.vm')).toBe(false)
    expect(isAllowedResource('ec3')).toBe(false)
    expect(isAllowedResource('')).toBe(false)
  })

  it('has an id key for every resource and a default for unknown ones', () => {
    for (const r of AWS_RESOURCES) expect(resourceIdKey(r).length).toBeGreaterThan(0)
    expect(resourceIdKey('ec2')).toBe('InstanceId')
    expect(resourceIdKey('aws.ebs')).toBe('VolumeId')
    expect(resourceIdKey('mystery')).toBe('id')
  })
})

describe('action classification table', () => {
  const reversible = [
    'tag', 'mark', 'mark-for-op', 'unmark', 'remove-tag', 'rename-tag', 'normalize-tag', 'tag-trim',
    'auto-tag-user', 'copy-related-tag', 'stop', 'start', 'modify-security-groups', 'remove-permissions',
    'detach', 'disassociate', 'set-retention', 'set-encryption', 'post-finding', 'put-metric',
    'set-versioning', 'set-anything',
  ]
  const irreversible = [
    'delete', 'terminate', 'remove', 'schedule-key-deletion', 'disable-key', 'release', 'deregister',
    'revoke', 'delete-bucket', 'delete-global-grants',
  ]

  it.each(reversible)('classifies %s as reversible', (type) => {
    expect(classifyActionType(type)).toBe('reversible')
  })

  it.each(irreversible)('classifies %s as irreversible', (type) => {
    expect(classifyActionType(type)).toBe('irreversible')
  })

  it('does not classify unknown action types', () => {
    for (const type of ['frobnicate', 'notify', 'webhook', 'set-', 'delete-', 'Stop', '__proto__', 'constructor']) {
      expect(classifyActionType(type)).toBeNull()
    }
    expect(Object.keys(ACTION_CLASS).includes('notify')).toBe(false)
  })

  it('reports none for an empty action list', () => {
    expect(classifyActions([])).toBe('none')
  })

  it('reports the most dangerous action in the list', () => {
    expect(classifyActions(['tag', { type: 'stop' }])).toBe('reversible')
    expect(classifyActions(['tag', { type: 'delete' }])).toBe('irreversible')
    expect(classifyActions([{ type: 'schedule-key-deletion' }, 'tag'])).toBe('irreversible')
  })

  it('treats snapshot followed by delete as snapshot-delete', () => {
    expect(classifyActions(['snapshot', 'delete'])).toBe('snapshot-delete')
    expect(classifyActions(['snapshot', { type: 'terminate' }])).toBe('snapshot-delete')
  })

  it('requires the snapshot to come before the delete', () => {
    expect(classifyActions(['delete', 'snapshot'])).toBe('irreversible')
  })

  it('treats delete with a snapshot flag as snapshot-delete', () => {
    expect(classifyActions([{ type: 'delete', snapshot: true }])).toBe('snapshot-delete')
    expect(classifyActions([{ type: 'delete', 'skip-snapshot': false }])).toBe('snapshot-delete')
    expect(classifyActions([{ type: 'delete', 'skip-snapshot': true }])).toBe('irreversible')
  })

  it('never softens non-delete irreversible actions with a snapshot', () => {
    expect(classifyActions(['snapshot', 'schedule-key-deletion'])).toBe('irreversible')
    expect(classifyActions(['snapshot', 'delete', 'release'])).toBe('irreversible')
  })
})

describe('validatePolicy', () => {
  it('accepts a valid policy and returns a normalised copy', () => {
    const { value, errors } = validatePolicy(makePolicy({ resource: 'aws.ec2' }))
    expect(errors).toEqual([])
    expect(value?.resource).toBe('ec2')
    expect(value?.name).toBe('stopped-ec2-older-than-30-days')
  })

  it('always returns both fields', () => {
    const bad = validatePolicy(null)
    expect(bad.value).toBeNull()
    expect(bad.errors).toHaveLength(1)
    const good = validatePolicy(makePolicy())
    expect(good.errors).toEqual([])
    expect(good.value === null).toBe(false)
  })

  it.each(['', 'UPPER', '-leading', 'has space', 'a'.repeat(65), 'under_score', 'x/y'])(
    'rejects name %j',
    (name) => {
      expect(codes(validatePolicy(makePolicy({ name })).errors)).toContain('NAME_INVALID')
    },
  )

  it('accepts boundary names', () => {
    expect(validatePolicy(makePolicy({ name: 'a' })).errors).toEqual([])
    expect(validatePolicy(makePolicy({ name: '9' + 'a'.repeat(63) })).errors).toEqual([])
  })

  it('requires provider aws', () => {
    const model = { ...makePolicy(), provider: 'azure' }
    expect(codes(validatePolicy(model).errors)).toContain('PROVIDER_INVALID')
  })

  it('rejects resources outside the allow-list', () => {
    expect(codes(validatePolicy(makePolicy({ resource: 'aws.ec3' })).errors)).toContain('RESOURCE_NOT_ALLOWED')
    expect(codes(validatePolicy({ ...makePolicy(), resource: undefined }).errors)).toContain('RESOURCE_REQUIRED')
  })

  it('requires filters and actions to be arrays of specs', () => {
    expect(codes(validatePolicy({ ...makePolicy(), filters: 'x' }).errors)).toContain('FILTERS_INVALID')
    expect(codes(validatePolicy({ ...makePolicy(), actions: {} }).errors)).toContain('ACTIONS_INVALID')
    expect(codes(validatePolicy({ ...makePolicy(), filters: [1] }).errors)).toContain('FILTERS_INVALID')
    expect(codes(validatePolicy({ ...makePolicy(), actions: [null] }).errors)).toContain('ACTIONS_INVALID')
  })

  it('validates the enforcement enum', () => {
    for (const enforcement of ['observe', 'notify', 'ask', 'auto'] as const) {
      expect(validatePolicy(makePolicy({ enforcement })).errors).toEqual([])
    }
    expect(codes(validatePolicy({ ...makePolicy(), enforcement: 'yolo' }).errors)).toContain('ENFORCEMENT_INVALID')
  })

  it('validates caps as positive integers with percent 1-100', () => {
    expect(validatePolicy(makePolicy({ maxResources: 5, maxResourcesPercent: 100 })).errors).toEqual([])
    for (const maxResources of [0, -1, 1.5, 10001]) {
      expect(codes(validatePolicy({ ...makePolicy(), maxResources }).errors)).toContain('CAP_INVALID')
    }
    for (const maxResourcesPercent of [0, 101, 2.5, -3]) {
      expect(codes(validatePolicy({ ...makePolicy(), maxResourcesPercent }).errors)).toContain('CAP_INVALID')
    }
    expect(codes(validatePolicy({ ...makePolicy(), maxResources: '5' }).errors)).toContain('CAP_INVALID')
  })

  it('validates gracePeriodDays 0-365', () => {
    expect(validatePolicy(makePolicy({ gracePeriodDays: 0 })).errors).toEqual([])
    expect(validatePolicy(makePolicy({ gracePeriodDays: 365 })).errors).toEqual([])
    for (const gracePeriodDays of [-1, 366, 1.5]) {
      expect(codes(validatePolicy({ ...makePolicy(), gracePeriodDays }).errors)).toContain('GRACE_PERIOD_INVALID')
    }
  })

  it('validates ownerTagKeys and tags', () => {
    expect(validatePolicy(makePolicy({ ownerTagKeys: ['Owner', 'Team'], tags: { env: 'prod' } })).errors).toEqual([])
    expect(codes(validatePolicy({ ...makePolicy(), ownerTagKeys: [1] }).errors)).toContain('OWNER_TAG_KEYS_INVALID')
    expect(codes(validatePolicy({ ...makePolicy(), ownerTagKeys: 'Owner' }).errors)).toContain('OWNER_TAG_KEYS_INVALID')
    expect(codes(validatePolicy({ ...makePolicy(), tags: { a: 1 } }).errors)).toContain('TAGS_INVALID')
    expect(codes(validatePolicy({ ...makePolicy(), tags: ['a'] }).errors)).toContain('TAGS_INVALID')
  })

  it('rejects mode, conditions and unknown keys', () => {
    expect(codes(validatePolicy({ ...makePolicy(), mode: { type: 'periodic' } }).errors)).toContain('MODE_NOT_ALLOWED')
    expect(codes(validatePolicy({ ...makePolicy(), conditions: [] }).errors)).toContain('CONDITIONS_NOT_ALLOWED')
    expect(codes(validatePolicy({ ...makePolicy(), 'max-resources': 1 }).errors)).toContain('UNKNOWN_POLICY_KEY')
    expect(codes(validatePolicy({ ...makePolicy(), execution_options: {} }).errors)).toContain('UNKNOWN_POLICY_KEY')
  })

  it('reports multiple problems at once with paths', () => {
    const { errors } = validatePolicy({ name: 'BAD', provider: 'aws', resource: 'nope', filters: [], actions: [], enforcement: 'x' })
    expect(errors.map((e) => e.path)).toEqual(['name', 'resource', 'enforcement'])
  })
})

describe('validateException', () => {
  it('accepts a valid exception', () => {
    const { value, errors } = validateException(makeException({ expiresAt: '2030-01-01T00:00:00Z' }))
    expect(errors).toEqual([])
    expect(value?.resourceId).toBe('i-0abc123')
  })

  it('requires every field', () => {
    for (const field of ['policy', 'resourceId', 'reason', 'approver', 'expiresAt'] as const) {
      const model = { ...makeException(), [field]: undefined }
      const { value, errors } = validateException(model)
      expect(value).toBeNull()
      expect(errors.map((e) => e.path)).toEqual([field])
    }
  })

  it('rejects malformed expiry dates', () => {
    for (const expiresAt of ['tomorrow', '2030-13-45', '30/01/2030', '', 20300101]) {
      expect(validateException({ ...makeException(), expiresAt }).value).toBeNull()
    }
  })

  it('rejects non-objects', () => {
    expect(validateException('x').value).toBeNull()
  })
})

describe('validateSchedule and cron', () => {
  it('accepts a valid schedule and normalises whitespace', () => {
    const { value, errors } = validateSchedule({ policy: 'p1', cron: ' 0   2 * * 1-5 ', enabled: true, enforcement: 'observe' })
    expect(errors).toEqual([])
    expect(value?.cron).toBe('0 2 * * 1-5')
  })

  it.each(['*/5 * * * *', '0 0 1,15 * *', '30 4 * 1-6 0', '0 */2 * * *', '* * * * *', '0 0 * * 7'])(
    'accepts cron %j',
    (cron) => {
      expect(isValidCron(cron)).toBe(true)
    },
  )

  it.each([
    '', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * 32 * *', '* * * 13 *', '* * * * 8',
    '*/0 * * * *', '5-3 * * * *', '@daily', 'a * * * *', '0 0 * * MON', '1,,2 * * * *', '$(rm) * * * *', '0 0 * * *;ls', '-1 * * * *',
  ])('rejects cron %j', (cron) => {
    expect(isValidCron(cron)).toBe(false)
  })

  it('rejects non-string cron and bad fields', () => {
    expect(isValidCron(5)).toBe(false)
    expect(codes(validateSchedule({ policy: 'p1', cron: 'x', enabled: 'yes', enforcement: 'bad' }).errors)).toEqual([
      'CRON_INVALID',
      'ENABLED_INVALID',
      'ENFORCEMENT_INVALID',
    ])
  })
})

describe('validatePack', () => {
  it('accepts a pack', () => {
    const { value, errors } = validatePack({ name: 'baseline', description: 'd', policies: ['a', 'b'] })
    expect(errors).toEqual([])
    expect(value?.policies).toEqual(['a', 'b'])
  })

  it('rejects empty, duplicate and invalid members', () => {
    expect(codes(validatePack({ name: 'p', policies: [] }).errors)).toContain('PACK_POLICIES_INVALID')
    expect(codes(validatePack({ name: 'p', policies: ['a', 'a'] }).errors)).toContain('PACK_POLICY_DUPLICATE')
    expect(codes(validatePack({ name: 'p', policies: ['BAD'] }).errors)).toContain('NAME_INVALID')
    expect(codes(validatePack({ name: 'BAD', policies: ['a'] }).errors)).toContain('NAME_INVALID')
    expect(validatePack(null).value).toBeNull()
  })
})

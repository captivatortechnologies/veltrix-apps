import validate from '../validate'
import { buildAccountRecord } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-soar',
    customerId: 'cust-1',
    configTypeId: 'automation-accounts',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-soar',
      entityType: 'automation-accounts',
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

describe('Splunk SOAR Automation Accounts', () => {
  it('validates a minimal automation account', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { username: 'svc_veltrix' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing username', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_ID')).toBe(true)
  })

  it('buildAccountRecord always fixes type to automation and never sends a password', () => {
    const spec = buildAccountRecord({ username: 'svc_veltrix', roles: ['Automation'] })
    expect(spec.body?.type).toBe('automation')
    expect(spec.body?.password).toBeUndefined()
  })

  it('buildAccountRecord includes optional fields only when set', () => {
    const spec = buildAccountRecord({ username: 'svc_veltrix' })
    expect(spec.body?.email).toBeUndefined()
    expect(spec.body?.default_tenant_id).toBeUndefined()
  })

  it('buildAccountRecord parses allowed_ips and roles as lists', () => {
    const spec = buildAccountRecord({ username: 'svc', allowed_ips: '10.10.0.0/16, 10.20.0.0/16', roles: ['Automation'] })
    expect(spec.body?.allowed_ips).toEqual(['10.10.0.0/16', '10.20.0.0/16'])
    expect(spec.body?.roles).toEqual(['Automation'])
  })

  it('buildAccountRecord includes default_tenant_id when provided', () => {
    const spec = buildAccountRecord({ username: 'svc', default_tenant_id: 5 })
    expect(spec.body?.default_tenant_id).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Field formats the canvas PROMISES.
//
// `allowed_ips`, `email` and `time_zone` each state a format in their helpText
// and none was enforced, so a typo was caught by SOAR at DEPLOY time — after the
// pipeline had started and, on a multi-account canvas, after earlier accounts
// had already been created. Half of these guard the other direction: a validator
// that rejects legitimate input is worse than one that accepts junk, because it
// blocks work that would have succeeded.
// ---------------------------------------------------------------------------

describe('allowed_ips accepts what SOAR accepts', () => {
  it.each([
    ['10.10.0.0/16', 'a CIDR block, the documented example'],
    ['192.168.1.1', 'a bare address — nobody should have to write /32'],
    ['0.0.0.0/0', 'the whole IPv4 space'],
    ['255.255.255.255/32', 'the upper bound of every octet and prefix'],
    ['2001:db8::1', 'an IPv6 address'],
    ['2001:db8::/32', 'an IPv6 CIDR'],
  ])('accepts %s (%s)', (value) => {
    const spec = buildAccountRecord({ username: 'svc', allowed_ips: [value] })
    expect(spec.error).toBeNull()
    expect(spec.body?.allowed_ips).toEqual([value])
  })

  it.each([
    ['10.10.0.0/33', 'a prefix wider than IPv4 allows'],
    ['999.1.1.1', 'an octet above 255'],
    ['10.0.0', 'too few octets'],
    ['not-an-ip', 'free text'],
    ['10.0.0.0/16/24', 'two prefixes'],
  ])('rejects %s (%s)', (value) => {
    const spec = buildAccountRecord({ username: 'svc', allowed_ips: [value] })
    expect(spec.error).toMatch(/Allowed IPs/)
    expect(spec.body).toBeNull()
  })

  it('names every offending entry, not just the first', () => {
    const spec = buildAccountRecord({
      username: 'svc',
      allowed_ips: ['10.0.0.0/8', 'bogus', '10.10.0.0/16', 'also-bogus'],
    })
    expect(spec.error).toMatch(/"bogus"/)
    expect(spec.error).toMatch(/"also-bogus"/)
  })

  it('accepts an empty list — the field is optional', () => {
    const spec = buildAccountRecord({ username: 'svc' })
    expect(spec.error).toBeNull()
  })
})

describe('email', () => {
  it('accepts an ordinary address', () => {
    const spec = buildAccountRecord({ username: 'svc', email: 'ops@example.com' })
    expect(spec.error).toBeNull()
    expect(spec.body?.email).toBe('ops@example.com')
  })

  it('accepts a plus-addressed mailbox, which a strict regex often rejects', () => {
    const spec = buildAccountRecord({ username: 'svc', email: 'ops+soar@example.co.uk' })
    expect(spec.error).toBeNull()
  })

  it('rejects an address with no domain dot', () => {
    const spec = buildAccountRecord({ username: 'svc', email: 'ops@localhost' })
    expect(spec.error).toMatch(/email/i)
  })

  it('rejects free text', () => {
    const spec = buildAccountRecord({ username: 'svc', email: 'not an email' })
    expect(spec.error).toMatch(/email/i)
  })

  it('stays optional — blank is not an error', () => {
    const spec = buildAccountRecord({ username: 'svc', email: '' })
    expect(spec.error).toBeNull()
    expect(spec.body?.email).toBeUndefined()
  })
})

describe('time_zone', () => {
  it.each(['America/Chicago', 'UTC', 'Europe/London', 'Etc/GMT+5'])('accepts %s', (value) => {
    // `UTC` and `Etc/GMT+5` are why this asks Intl rather than matching an
    // `Area/Location` pattern — both are real and both fail that pattern.
    const spec = buildAccountRecord({ username: 'svc', time_zone: value })
    expect(spec.error).toBeNull()
    expect(spec.body?.time_zone).toBe(value)
  })

  it('rejects a zone that does not exist', () => {
    const spec = buildAccountRecord({ username: 'svc', time_zone: 'Mars/Olympus_Mons' })
    expect(spec.error).toMatch(/time zone/i)
  })

  it('stays optional — blank is not an error', () => {
    const spec = buildAccountRecord({ username: 'svc', time_zone: '' })
    expect(spec.error).toBeNull()
  })
})

describe('validate surfaces the format errors', () => {
  it('fails the canvas, rather than letting deploy find out', async () => {
    const result = await validate(
      makeCtx([{ name: 'Account 1', fields: { username: 'svc', allowed_ips: ['bogus'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => /Allowed IPs/.test(e.message))).toBe(true)
  })

  it('still passes a well-formed account', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Account 1',
          fields: {
            username: 'svc',
            allowed_ips: ['10.10.0.0/16'],
            email: 'ops@example.com',
            time_zone: 'America/Chicago',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

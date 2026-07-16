import {
  mintToken,
  hashToken,
  expiryFrom,
  isTokenUsable,
  checkPasswordPolicy,
  buildActivationLink,
  buildActivationEmail,
  ACTIVATION_TTL_MS,
  MIN_PASSWORD_LENGTH,
} from '../activation'

describe('mintToken / hashToken', () => {
  it('returns a raw token plus its SHA-256 hash', () => {
    const { token, tokenHash } = mintToken()
    expect(token.length).toBeGreaterThan(20)
    expect(tokenHash).toBe(hashToken(token))
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('mints a distinct token each time', () => {
    expect(mintToken().token === mintToken().token).toBe(false)
  })

  it('hashToken is deterministic and does not reveal the token', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'))
    expect(hashToken('abc').includes('abc')).toBe(false)
  })
})

describe('expiryFrom', () => {
  it('is 24h after the given instant', () => {
    const now = 1_700_000_000_000
    expect(new Date(expiryFrom(now)).getTime()).toBe(now + ACTIVATION_TTL_MS)
  })
})

describe('isTokenUsable', () => {
  const now = 1_700_000_000_000
  const future = new Date(now + 60_000).toISOString()
  const past = new Date(now - 60_000).toISOString()

  it('true for a pending, unexpired token', () => {
    expect(isTokenUsable({ status: 'pending', expires_at: future }, now)).toBe(true)
  })
  it('false when consumed', () => {
    expect(isTokenUsable({ status: 'consumed', expires_at: future }, now)).toBe(false)
  })
  it('false when expired', () => {
    expect(isTokenUsable({ status: 'pending', expires_at: past }, now)).toBe(false)
  })
  it('false for null/undefined', () => {
    expect(isTokenUsable(null, now)).toBe(false)
    expect(isTokenUsable(undefined, now)).toBe(false)
  })
  it('accepts a Date expires_at', () => {
    expect(isTokenUsable({ status: 'pending', expires_at: new Date(now + 60_000) }, now)).toBe(true)
  })
})

describe('checkPasswordPolicy', () => {
  it('rejects short passwords', () => {
    expect(checkPasswordPolicy('short').ok).toBe(false)
    expect(checkPasswordPolicy('a'.repeat(MIN_PASSWORD_LENGTH - 1)).ok).toBe(false)
  })
  it('accepts a 15+ char password', () => {
    expect(checkPasswordPolicy('a-strong-passphrase-2026').ok).toBe(true)
  })
  it('rejects common passwords', () => {
    expect(checkPasswordPolicy('changeme').ok).toBe(false)
    expect(checkPasswordPolicy('PASSWORD').ok).toBe(false)
  })
  it('rejects all-whitespace and overly long', () => {
    expect(checkPasswordPolicy(' '.repeat(20)).ok).toBe(false)
    expect(checkPasswordPolicy('a'.repeat(300)).ok).toBe(false)
  })
})

describe('buildActivationLink', () => {
  it('builds the app activate URL and encodes the token', () => {
    const link = buildActivationLink('https://app.veltrixsecops.com/', 'tok en+/')
    expect(link).toBe('https://app.veltrixsecops.com/apps/splunk-enterprise/activate?token=tok%20en%2B%2F')
  })
})

describe('buildActivationEmail', () => {
  const email = buildActivationEmail({
    environmentName: 'Acme Prod',
    adminUser: 'admin',
    link: 'https://app.veltrixsecops.com/apps/splunk-enterprise/activate?token=xyz',
    expiresAtIso: new Date(1_700_000_000_000).toISOString(),
  })

  it('names the environment in the subject', () => {
    expect(email.subject).toContain('Acme Prod')
  })
  it('contains the link in both text and html', () => {
    expect(email.text).toContain('activate?token=xyz')
    expect(email.html).toContain('activate?token=xyz')
  })
  it('never contains a password field', () => {
    expect(/password:\s*\S/.test(email.text.toLowerCase())).toBe(false)
  })
})

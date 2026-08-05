import { base32Decode, hotp, generateTotp } from '../totp'

describe('hotp (RFC 4226 HOTP)', () => {
  // Official RFC 4226 Appendix D test vectors: secret = ASCII
  // "12345678901234567890" (20 bytes), digits = 6.
  const secret = Buffer.from('12345678901234567890', 'ascii')
  const vectors = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ]

  it.each(vectors.map((expected, counter) => [counter, expected]))(
    'counter %s produces %s',
    (counter: number, expected: string) => {
      expect(hotp(secret, counter, 6)).toBe(expected)
    },
  )
})

describe('base32Decode', () => {
  it('decodes a known base32 string to its ASCII bytes', () => {
    // "JBSWY3DPEHPK3PXP" is the well-known base32 encoding of "Hello!\xde\x8a" —
    // spot-check the first 5 decoded bytes spell "Hello".
    const decoded = base32Decode('JBSWY3DPEHPK3PXP')
    expect(decoded.subarray(0, 5).toString('ascii')).toBe('Hello')
  })

  it('ignores separators and lowercase input', () => {
    const upper = base32Decode('JBSWY3DP')
    const lowerWithDashes = base32Decode('jbsw-y3dp')
    expect(lowerWithDashes.equals(upper)).toBeTruthy()
  })
})

describe('generateTotp', () => {
  it('produces a 6-digit numeric code', () => {
    const code = generateTotp('JBSWY3DPEHPK3PXP', { timestampMs: 1_700_000_000_000 })
    expect(code).toHaveLength(6)
    expect(/^\d{6}$/.test(code)).toBeTruthy()
  })

  it('is deterministic for the same secret and timestamp', () => {
    const a = generateTotp('JBSWY3DPEHPK3PXP', { timestampMs: 1_700_000_000_000 })
    const b = generateTotp('JBSWY3DPEHPK3PXP', { timestampMs: 1_700_000_000_000 })
    expect(a).toBe(b)
  })

  it('changes once the 30-second window elapses', () => {
    const a = generateTotp('JBSWY3DPEHPK3PXP', { timestampMs: 1_700_000_000_000 })
    const b = generateTotp('JBSWY3DPEHPK3PXP', { timestampMs: 1_700_000_030_000 })
    expect(a === b).toBeFalsy()
  })
})

import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

/** The live object points at a DIFFERENT wildcard — the case drift detection
 *  exists to catch, since it silently widens or narrows what a policy matches. */
export const fixture: ConfigFixture = {
  id: 'firewall-wildcard-fqdns',
  objectPath: '/obj/firewall/wildcard-fqdn/custom',
  checkName: 'fmg-firewall-wildcard-fqdn',
  name: 'cdn-wildcard',
  item: {
    id: 'item-1',
    name: 'cdn-wildcard',
    fields: { name: 'cdn-wildcard', wildcardFqdn: '*.cdn.example.com', comment: 'CDN edge' },
  },
  body: { name: 'cdn-wildcard', 'wildcard-fqdn': '*.cdn.example.com', comment: 'CDN edge' },
  livePrior: { name: 'cdn-wildcard', 'wildcard-fqdn': '*.old-cdn.example.com', comment: 'CDN edge' },
  priorSnapshot: { name: 'cdn-wildcard', 'wildcard-fqdn': '*.old-cdn.example.com', comment: 'CDN edge' },
  liveInSync: { name: 'cdn-wildcard', 'wildcard-fqdn': '*.cdn.example.com', comment: 'CDN edge' },
  driftField: 'cdn-wildcard.wildcard-fqdn',
  deploySuccess: 'Deployed 1 wildcard FQDN(s)',
  deployFailurePrefix: 'Some wildcard FQDNs failed',
  rollbackPrefix: 'Rolled back wildcard FQDNs',
}

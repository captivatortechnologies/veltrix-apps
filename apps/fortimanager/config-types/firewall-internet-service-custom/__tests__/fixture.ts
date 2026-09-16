import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

export const fixture: ConfigFixture = {
  id: 'firewall-internet-service-custom',
  objectPath: '/obj/firewall/internet-service-custom',
  checkName: 'fmg-firewall-internet-service-custom',
  name: 'partner-saas',
  item: {
    id: 'item-1',
    name: 'partner-saas',
    fields: {
      name: 'partner-saas',
      comment: 'Partner SaaS ranges',
      reputation: 5,
      masterServiceId: 65536,
      entry: '[{"id":1,"protocol":6,"port-range":[{"id":1,"start-port":443,"end-port":443}]}]',
    },
  },
  body: {
    name: 'partner-saas',
    comment: 'Partner SaaS ranges',
    reputation: 5,
    'master-service-id': 65536,
    entry: [{ id: 1, protocol: 6, 'port-range': [{ id: 1, 'start-port': 443, 'end-port': 443 }] }],
  },
  livePrior: {
    name: 'partner-saas',
    comment: 'Partner SaaS ranges',
    reputation: 2,
    'master-service-id': 65536,
  },
  priorSnapshot: {
    name: 'partner-saas',
    comment: 'Partner SaaS ranges',
    reputation: 2,
    'master-service-id': 65536,
  },
  liveInSync: {
    name: 'partner-saas',
    comment: 'Partner SaaS ranges',
    reputation: 5,
    'master-service-id': 65536,
  },
  driftField: 'partner-saas.reputation',
  deploySuccess: 'Deployed 1 custom internet service(s)',
  deployFailurePrefix: 'Some custom internet services failed',
  rollbackPrefix: 'Rolled back custom internet services',
}

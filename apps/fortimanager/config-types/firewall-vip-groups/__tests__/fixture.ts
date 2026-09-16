import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

export const fixture: ConfigFixture = {
  id: 'firewall-vip-groups',
  objectPath: '/obj/firewall/vipgrp',
  checkName: 'fmg-firewall-vipgrp',
  name: 'edge-vips',
  item: {
    id: 'item-1',
    name: 'edge-vips',
    fields: { name: 'edge-vips', members: 'vip-web, vip-mail', interface: 'port1', comment: 'Edge VIP set' },
  },
  body: { name: 'edge-vips', member: ['vip-web', 'vip-mail'], interface: 'port1', comments: 'Edge VIP set' },
  livePrior: { name: 'edge-vips', member: [{ name: 'vip-web' }], interface: 'port1', comments: 'Edge VIP set' },
  priorSnapshot: { name: 'edge-vips', member: ['vip-web'], interface: 'port1', comments: 'Edge VIP set' },
  liveInSync: { name: 'edge-vips', member: ['vip-web', 'vip-mail'], interface: 'port1', comments: 'Edge VIP set' },
  driftField: 'edge-vips.member',
  deploySuccess: 'Deployed 1 firewall VIP group(s)',
  deployFailurePrefix: 'Some VIP groups failed',
  rollbackPrefix: 'Rolled back firewall VIP groups',
}

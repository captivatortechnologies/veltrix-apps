// Cribl Notification Targets config type — where alert notifications are sent
// (Webhook, PagerDuty, Slack, SNS, SMTP), over /api/v1/notification-targets.
// Shares the SAME engine as Sources/Destinations (lib/criblSystemEntities),
// since a Notification Target is also one flat { id, type, ...conf } object —
// but UNLIKE Sources/Destinations, this collection is NOT Worker-Group-scoped;
// it is a single global list, so `groupScoped: false` skips the /m/<group>
// path segment entirely (see EntityDescriptor).

import type { EntityDescriptor } from '../../lib/criblSystemEntities'

/** The Cribl notification-targets collection this config type manages. */
export const NOTIFICATION_TARGET: EntityDescriptor = {
  resource: 'notification-targets',
  kind: 'notification target',
  Kind: 'Notification Target',
  groupScoped: false,
}

export { buildEntityBody, type SystemEntity } from '../../lib/criblSystemEntities'

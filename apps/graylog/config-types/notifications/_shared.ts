// Shared helpers for the Graylog Notifications (event notifications) config
// type (validate + deploy + rollback + drift). Shapes follow the Graylog REST
// API (/api/events/notifications):
//   • POST body  = CreateEntityRequest<NotificationDto> { entity: { title,
//                  description, config }, share_request: null }
//   • PUT  body  = NotificationDto { id, title, description, config } — id
//                  MUST equal the URL's {notificationId}
//   • GET  response = `{ notifications: [NotificationDto] }` (deprecated bare
//                  list; used here for its simplicity)
// `config` is a typed, discriminated blob — `config.type` selects the
// notification implementation and its own fields, e.g. "email-notification-v1"
// (EmailEventNotificationConfig) or "http-notification-v2"
// (HTTPEventNotificationConfigV2). Source:
// org.graylog.events.rest.EventNotificationsResource,
// org.graylog.events.notifications.NotificationDto,
// org.graylog.security.shares.CreateEntityRequest (@ 6.1).

import { asString, parseJsonObject } from '../../lib/coerce'

/** Well-known notification config type discriminators bundled with Graylog. */
export const EMAIL_NOTIFICATION_TYPE = 'email-notification-v1'
export const HTTP_NOTIFICATION_TYPE = 'http-notification-v2'

/** One notification as returned by GET /api/events/notifications (NotificationDto). */
export interface GraylogNotification {
  id?: string
  title?: string
  description?: string
  config?: Record<string, unknown>
  [key: string]: unknown
}

/** GET /api/events/notifications envelope: `{ notifications: [...] }`. */
interface NotificationsListResponse {
  notifications?: GraylogNotification[]
}

/** Entity body (no id) sent inside CreateEntityRequest on POST /api/events/notifications. */
export interface NotificationEntityBody {
  title: string
  description: string
  config: Record<string, unknown>
}

/** Unwrap GET /api/events/notifications into a flat array of notifications. */
export function notificationsFromList(list: unknown): GraylogNotification[] {
  if (Array.isArray(list)) return list as GraylogNotification[]
  const notifications = (list as NotificationsListResponse | null)?.notifications
  return Array.isArray(notifications) ? notifications : []
}

/** Find a live notification by title (the stable identity used for upsert + drift). */
export function findNotification(notifications: GraylogNotification[], title: string): GraylogNotification | null {
  const t = asString(title)
  if (!t) return null
  return notifications.find((n) => asString(n.title) === t) ?? null
}

export interface BuiltNotificationEntity {
  entity?: NotificationEntityBody
  error?: string
}

/** Build the NotificationDto entity body from canvas fields. */
export function buildNotificationEntity(fields: Record<string, unknown>): BuiltNotificationEntity {
  const { value: config, error } = parseJsonObject(fields.config)
  if (error) return { error: `config ${error}` }
  if (!asString(config.type)) return { error: 'config.type is required (e.g. "email-notification-v1" or "http-notification-v2")' }
  return {
    entity: {
      title: asString(fields.title),
      description: asString(fields.description),
      config,
    },
  }
}

/** Build a restore body from a live notification (rollback) — includes the id PUT requires. */
export function bodyFromLiveNotification(notification: GraylogNotification): GraylogNotification {
  return {
    id: asString(notification.id),
    title: asString(notification.title),
    description: asString(notification.description),
    config: (notification.config && typeof notification.config === 'object' ? notification.config : {}) as Record<string, unknown>,
  }
}

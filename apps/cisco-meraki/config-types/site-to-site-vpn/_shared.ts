import { getSiteToSiteVpn, putSiteToSiteVpn } from '../../lib/merakiApi'
import type { SingletonTransport } from '../../lib/merakiSingleton'

export interface MerakiSiteToSiteVpnSettings { mode?: string; hubs?: Array<{ hubId?: string; useDefaultRoute?: boolean }>; subnets?: Array<{ localSubnet?: string; useVpn?: boolean }>; subnet?: Record<string, unknown>; [key: string]: unknown }

export const transport: SingletonTransport<MerakiSiteToSiteVpnSettings> = { label: 'site-to-site VPN settings', get: getSiteToSiteVpn, put: putSiteToSiteVpn, validate(settings, field, errors) { if (settings.mode && !['none','spoke','hub'].includes(settings.mode)) errors.push({ field: `${field}.mode`, message: 'mode must be none, spoke or hub.', code: 'INVALID_MODE' }) } }

import { getContentFilteringSettings, putContentFilteringSettings } from '../../lib/merakiApi'
import type { SingletonTransport } from '../../lib/merakiSingleton'

export interface MerakiContentFilteringSettings { blockedUrlCategories?: string[]; blockedUrlPatterns?: string[]; allowedUrlPatterns?: string[]; urlCategoryListSize?: string; [key: string]: unknown }

export const transport: SingletonTransport<MerakiContentFilteringSettings> = { label: 'appliance content filtering settings', get: getContentFilteringSettings, put: putContentFilteringSettings, validate(settings, field, errors) { if (settings.urlCategoryListSize && !['topSites','fullList'].includes(settings.urlCategoryListSize)) errors.push({ field: `${field}.urlCategoryListSize`, message: 'urlCategoryListSize must be topSites or fullList.', code: 'INVALID_LIST_SIZE' }) } }

// =============================================================================
// Splunk Enterprise App — Client Entry Point
//
// Registers the app's pages and sidebar items. The platform dynamically
// loads this module when the app is enabled for a customer.
// =============================================================================

import React from 'react'

const IndexesPage = React.lazy(() => import('./pages/IndexesPage'))
const RolesPage = React.lazy(() => import('./pages/RolesPage'))
const BYOLPage = React.lazy(() => import('./pages/BYOLPage'))

export default {
  id: 'splunk-enterprise',
  pages: {
    IndexesPage,
    RolesPage,
    BYOLPage,
  },
  sidebarItems: [
    { path: '/apps/splunk-enterprise/indexes', label: 'Indexes', icon: 'database' },
    { path: '/apps/splunk-enterprise/roles', label: 'Roles', icon: 'shield' },
    { path: '/apps/splunk-enterprise/byol', label: 'BYOL Infrastructure', icon: 'server' },
  ],
}

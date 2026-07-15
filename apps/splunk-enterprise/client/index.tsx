// =============================================================================
// Splunk Enterprise App — Client Entry Point
//
// Registers the app's pages and sidebar items. The platform dynamically
// loads this module when the app is enabled for a customer.
// =============================================================================

import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const AccessServersPage = React.lazy(() => import('./pages/AccessServersPage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))
const BYOLPage = React.lazy(() => import('./pages/BYOLPage'))
const UpgradesPage = React.lazy(() => import('./pages/UpgradesPage'))

export default {
  id: 'splunk-enterprise',
  pages: {
    OverviewPage,
    SetupGuidePage,
    AccessServersPage,
    ConnectionsPage,
    BYOLPage,
    UpgradesPage,
  },
  sidebarItems: [
    { path: '/apps/splunk-enterprise/overview', label: 'Overview', icon: 'home' },
    { path: '/apps/splunk-enterprise/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/splunk-enterprise/access-servers', label: 'Access Servers', icon: 'shield' },
    { path: '/apps/splunk-enterprise/connections', label: 'Connections', icon: 'link' },
    { path: '/apps/splunk-enterprise/byol', label: 'BYOL Infrastructure', icon: 'server' },
    { path: '/apps/splunk-enterprise/upgrades', label: 'Upgrades', icon: 'refresh-cw' },
  ],
}

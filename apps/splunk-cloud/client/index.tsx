// =============================================================================
// Splunk Cloud Platform App — Client Entry Point
//
// Registers the app's pages and sidebar items. The platform dynamically
// loads this module when the app is enabled for a customer.
// =============================================================================

import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const AccessServersPage = React.lazy(() => import('./pages/AccessServersPage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'splunk-cloud',
  pages: {
    OverviewPage,
    SetupGuidePage,
    AccessServersPage,
    ConnectionsPage,
  },
  sidebarItems: [
    { path: '/apps/splunk-cloud/overview', label: 'Overview', icon: 'cloud' },
    { path: '/apps/splunk-cloud/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/splunk-cloud/access-servers', label: 'Access Servers', icon: 'shield' },
    { path: '/apps/splunk-cloud/connections', label: 'Connections', icon: 'link' },
  ],
}

import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'wazuh',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/wazuh/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/wazuh/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/wazuh/connections', label: 'Connections', icon: 'link' },
  ],
}

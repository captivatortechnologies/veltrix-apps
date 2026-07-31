import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))
const BYOLPage = React.lazy(() => import('./pages/BYOLPage'))

export default {
  id: 'wazuh',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage, BYOLPage },
  sidebarItems: [
    { path: '/apps/wazuh/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/wazuh/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/wazuh/connections', label: 'Connections', icon: 'link' },
    { path: '/apps/wazuh/byol', label: 'Infrastructure', icon: 'server' },
  ],
}

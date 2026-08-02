import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'cisco-meraki',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/cisco-meraki/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/cisco-meraki/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/cisco-meraki/connections', label: 'Connections', icon: 'link' },
  ],
}

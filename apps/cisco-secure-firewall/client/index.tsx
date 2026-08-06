import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'cisco-secure-firewall',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/cisco-secure-firewall/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/cisco-secure-firewall/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/cisco-secure-firewall/connections', label: 'Connections', icon: 'link' },
  ],
}

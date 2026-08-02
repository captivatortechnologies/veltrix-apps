import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'pfsense',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/pfsense/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/pfsense/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/pfsense/connections', label: 'Connections', icon: 'link' },
  ],
}

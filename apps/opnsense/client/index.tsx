import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'opnsense',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/opnsense/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/opnsense/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/opnsense/connections', label: 'Connections', icon: 'link' },
  ],
}

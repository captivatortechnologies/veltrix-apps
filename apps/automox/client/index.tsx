import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'automox',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/automox/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/automox/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/automox/connections', label: 'Connections', icon: 'link' },
  ],
}

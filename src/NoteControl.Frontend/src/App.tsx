import { Navigate, Route, Routes } from 'react-router-dom';

import { AuthProvider } from './auth/AuthContext';
import { RequireAuth } from './auth/RequireAuth';
import { LoginPage } from './pages/LoginPage';
import { VaultListPage } from './pages/VaultListPage';
import { FolderPage } from './pages/FolderPage';
import { EditorPage } from './pages/EditorPage';
import { DashboardPage } from './pages/DashboardPage';
import { StartpagePage } from './pages/StartpagePage';
import { TemplatesPage } from './pages/TemplatesPage';
import { AssignmentsPage } from './pages/AssignmentsPage';
import { VaultLayout } from './components/VaultLayout';
import { useAppliedAppearance } from './settings/appearance';

/**
 * Top-level route table.
 *
 *   /login                                       anonymous; sign-in form
 *   /vaults                                      authenticated; pick a vault
 *   /vaults/:vaultId                             authenticated; folder view (root or ?path=)
 *   /vaults/:vaultId/note?path=...               authenticated; editor for one note
 *   /vaults/:vaultId/dashboards/:dashboardId     authenticated; one dashboard's canvas
 *   /vaults/:vaultId/startpage                   legacy alias; redirects to the first dashboard
 *   /vaults/:vaultId/templates                   authenticated; manage templates for the vault
 *
 * Anything else redirects to /vaults (which itself bounces to /login
 * for anonymous users via RequireAuth).
 *
 * --- Layout route ---
 *
 * The folder + editor + dashboard routes live UNDER a shared layout
 * route that mounts <VaultLayout> once. This means navigating
 * between any of them (folder ↔ note ↔ dashboard ↔ another
 * dashboard) does NOT unmount the tree — its cached children,
 * expanded set, selection, and the dashboards data all persist.
 *
 * Templates page is intentionally left OUT of the shared layout —
 * it has its own header and no tree, so the shell would be wasted
 * space.
 *
 * The whole app is wrapped in .nc-app-frame — a centered band of
 * configurable width (1000–2400 px, default 1600). Outside that band,
 * the body background shows through with the user's chosen gradient
 * preset. Inside, layout proceeds as before (top bar + 3-column
 * shell). useAppliedAppearance() writes the current width + gradient
 * to CSS custom properties on documentElement.
 */
export default function App() {
  useAppliedAppearance();
  return (
    <AuthProvider>
      <div className="nc-app-frame">
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route
            path="/vaults"
            element={
              <RequireAuth>
                <VaultListPage />
              </RequireAuth>
            }
          />

          {/*
            Shared layout: VaultLayout wraps the folder view, the
            note editor, and every dashboard. Pages render via
            <Outlet /> inside the layout. Mounting once per vault
            session is what fixes the "tree reloads on every click"
            issue — and now also lets the tree-side dashboards list
            and the dashboard canvas share state without two
            independent fetches.
          */}
          <Route
            path="/vaults/:vaultId"
            element={
              <RequireAuth>
                <VaultLayout />
              </RequireAuth>
            }
          >
            {/* index = /vaults/:vaultId  → folder root view */}
            <Route index element={<FolderPage />} />
            {/* /vaults/:vaultId/note?path=... → note editor */}
            <Route path="note" element={<EditorPage />} />
            {/*
              Per-vault dashboards. The dashboardId in the URL
              picks which dashboard's canvas renders; the layout
              fetches the whole config once and provides it via
              the outlet context.
            */}
            <Route
              path="dashboards/:dashboardId"
              element={<DashboardPage />}
            />
            {/*
              Legacy /startpage URL kept as a redirect target so
              existing links (the tray's "open vault" menu, the
              vault list page's auto-redirect, user bookmarks)
              keep landing on something useful. StartpagePage is
              now a tiny redirect to the first dashboard.
            */}
            <Route path="startpage" element={<StartpagePage />} />
            {/*
              Per-vault Assignments page. Lives under the shared
              VaultLayout so the tree + topbar stay visible — the
              page itself is a 3-bucket list of assignment cards
              (Short Term / Long Term / Development) with a single
              add button at the bottom. The tree's "Assignments"
              row navigates here.
            */}
            <Route path="assignments" element={<AssignmentsPage />} />
          </Route>

          <Route
            path="/vaults/:vaultId/templates"
            element={
              <RequireAuth>
                <TemplatesPage />
              </RequireAuth>
            }
          />

          <Route path="*" element={<Navigate to="/vaults" replace />} />
        </Routes>
      </div>
    </AuthProvider>
  );
}

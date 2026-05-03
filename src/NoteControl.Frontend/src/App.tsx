import { Navigate, Route, Routes } from 'react-router-dom';

import { AuthProvider } from './auth/AuthContext';
import { RequireAuth } from './auth/RequireAuth';
import { LoginPage } from './pages/LoginPage';
import { VaultListPage } from './pages/VaultListPage';
import { FolderPage } from './pages/FolderPage';
import { EditorPage } from './pages/EditorPage';
import { StartpagePage } from './pages/StartpagePage';
import { TemplatesPage } from './pages/TemplatesPage';
import { VaultLayout } from './components/VaultLayout';
import { useAppliedAppearance } from './settings/appearance';

/**
 * Top-level route table.
 *
 *   /login                            anonymous; sign-in form
 *   /vaults                           authenticated; pick a vault
 *   /vaults/:vaultId                  authenticated; folder view (root or ?path=)
 *   /vaults/:vaultId/note?path=...    authenticated; editor for one note
 *   /vaults/:vaultId/templates        authenticated; manage templates for the vault
 *
 * Anything else redirects to /vaults (which itself bounces to /login
 * for anonymous users via RequireAuth).
 *
 * --- Layout route ---
 *
 * The folder + editor routes live UNDER a shared layout route that
 * mounts <VaultLayout> once. This means navigating from a folder
 * page to a note (or between notes) does NOT unmount the tree — its
 * cached children, expanded set, and selection all persist. Before
 * this change, every navigation re-mounted VaultLayout and forced a
 * full re-fetch of the root listing plus all previously-expanded
 * folders, causing a visible "waiting period" on every click.
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
            Shared layout: VaultLayout wraps both the folder view and
            the note editor. Pages render via <Outlet /> inside the
            layout. Mounting once per vault session is what fixes the
            "tree reloads on every folder click" issue.
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
              /vaults/:vaultId/startpage → per-vault startpage.
              Step 39: shell only. Step 40 turns this into the RSS
              reader grid. The route lives under the shared layout
              so the tree (with the pinned Startpage row at top)
              stays in view.
            */}
            <Route path="startpage" element={<StartpagePage />} />
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

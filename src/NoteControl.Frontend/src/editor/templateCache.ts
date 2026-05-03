import { ApiError, templatesApi, type TemplateSummaryDto } from '../api/client';

/**
 * Cache of fetched templates per vault, keyed by vaultId. The slash
 * menu reads from this cache synchronously (the suggestion plugin's
 * items() callback isn't async).
 *
 * The editor calls refresh() on mount and after the user saves a
 * template via the manage-templates page. If the cache is empty
 * for a vault when the slash menu queries, the item list just
 * doesn't include any templates — the standard items still work.
 */
const cacheByVault = new Map<string, TemplateSummaryDto[]>();

export function getCachedTemplates(vaultId: string): TemplateSummaryDto[] {
  return cacheByVault.get(vaultId) ?? [];
}

/**
 * Fetch the latest list of templates for this vault and update the
 * cache. Call on editor mount and after any template CRUD.
 *
 * Errors are swallowed — a template fetch failure shouldn't block
 * the editor; it just means the slash menu won't show templates
 * until the next refresh succeeds.
 */
export async function refreshTemplates(vaultId: string): Promise<void> {
  try {
    const list = await templatesApi.list(vaultId);
    cacheByVault.set(vaultId, list);
  } catch (e) {
    if (e instanceof ApiError) {
      // Most likely 401 because the user isn't logged in yet, or
      // the vault hasn't fully loaded. Swallow and let the next
      // refresh handle it.
      return;
    }
    // Unexpected: log so we notice.
    // eslint-disable-next-line no-console
    console.warn('Template refresh failed:', e);
  }
}

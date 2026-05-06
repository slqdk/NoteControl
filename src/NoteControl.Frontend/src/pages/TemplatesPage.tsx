import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

import {
  ApiError,
  templatesApi,
  vaultsApi,
  type TemplateDto,
  type TemplateSummaryDto,
} from '../api/client';
import type { VaultDto } from '../api/types';
import { TemplateEditor } from '../components/TemplateEditor';
import { TopBar } from '../components/TopBar';
import { refreshTemplates } from '../editor/templateCache';
import { formatNoteTimestamp } from '../utils/time';

/**
 * Templates management page.
 *
 *   /vaults/:vaultId/templates
 *
 * Two-column layout:
 *   left  — list of existing templates with a "+ New template" button
 *   right — editor for the currently-selected template (name + body)
 *
 * Save semantics: name + body are committed via Save button. No
 * autosave here — templates are infrequently edited and an explicit
 * commit avoids the "I half-typed and the save fired" surprise.
 */
export function TemplatesPage() {
  const { vaultId } = useParams<{ vaultId: string }>();
  const navigate = useNavigate();

  const [vault, setVault] = useState<VaultDto | null>(null);
  const [templates, setTemplates] = useState<TemplateSummaryDto[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [draft, setDraft] = useState<TemplateDto | null>(null);

  // The "loaded copy" — set when an existing template is fetched, so
  // we can compare the live draft against it for dirty-tracking. For
  // brand-new drafts this is null (there's nothing to compare against
  // — see the dirty predicate below).
  const [originalForCompare, setOriginalForCompare] = useState<TemplateDto | null>(null);

  // For new (unsaved) templates we don't have a loaded copy; we flip
  // create-vs-update at save time based on this flag.
  const [isNew, setIsNew] = useState(false);

  // True when the Save/Create button should be enabled.
  //
  // Two cases, because new drafts and edits compare differently:
  //
  //   - New draft (isNew + originalForCompare === null):
  //       enabled as soon as the name field is non-empty. The body
  //       can be empty — an empty-body template is legal and the
  //       server allows it. We deliberately don't require body
  //       changes; "name is filled in" is the user-meaningful
  //       trigger for "ready to create".
  //
  //   - Existing template (isNew=false, originalForCompare set):
  //       enabled only when the draft differs from the loaded copy
  //       (rename or body edit). Saving an unchanged template is a
  //       no-op we don't bother sending.
  //
  // Pre-fix (Ship 11a-fix10): the predicate required
  // originalForCompare !== null in both branches, but startNew()
  // sets it to null, so the button stayed disabled forever for new
  // drafts. The split below restores the intended behaviour.
  const dirty =
    draft !== null &&
    (isNew
      ? draft.name.trim().length > 0
      : originalForCompare !== null &&
        (draft.name !== originalForCompare.name ||
          draft.body !== originalForCompare.body));

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ------------------------------------------------------------ load list

  const loadList = useCallback(async () => {
    if (!vaultId) return;
    try {
      const list = await templatesApi.list(vaultId);
      setTemplates(list);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load templates.');
    }
  }, [vaultId]);

  useEffect(() => {
    if (!vaultId) return;
    let cancelled = false;
    (async () => {
      try {
        const vaults = await vaultsApi.list();
        if (cancelled) return;
        setVault(vaults.find((v) => v.id === vaultId) ?? null);
      } catch {
        /* ignore — vault rendering still works without the name */
      }
    })();
    void loadList();
    return () => {
      cancelled = true;
    };
  }, [vaultId, loadList]);

  // ------------------------------------------------------------ select

  async function selectTemplate(name: string) {
    if (!vaultId) return;
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setError(null);
    setIsNew(false);
    try {
      const dto = await templatesApi.get(vaultId, name);
      setSelectedName(name);
      setDraft(dto);
      setOriginalForCompare(dto);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load template.');
    }
  }

  function startNew() {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setError(null);
    setIsNew(true);
    setSelectedName(null);
    const fresh: TemplateDto = {
      name: '',
      body: '',
      lastModified: new Date().toISOString(),
    };
    setDraft(fresh);
    setOriginalForCompare(null);    // any keystroke = dirty
  }

  // ------------------------------------------------------------ save

  async function save() {
    if (!vaultId || !draft) return;
    if (!draft.name.trim()) {
      setError('Name is required.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      let saved: TemplateDto;
      if (isNew) {
        saved = await templatesApi.create(vaultId, {
          name: draft.name.trim(),
          body: draft.body,
        });
      } else if (selectedName) {
        saved = await templatesApi.update(vaultId, selectedName, {
          name: draft.name.trim(),
          body: draft.body,
        });
      } else {
        // Shouldn't happen — guard anyway.
        return;
      }

      await loadList();
      // Keep the editor on the saved template (in case of rename).
      setIsNew(false);
      setSelectedName(saved.name);
      setDraft(saved);
      setOriginalForCompare(saved);
      // Tell the slash-menu cache the list changed.
      void refreshTemplates(vaultId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save template.');
    } finally {
      setSaving(false);
    }
  }

  // ------------------------------------------------------------ delete

  async function deleteSelected() {
    if (!vaultId || !selectedName) return;
    if (!window.confirm(`Delete template "${selectedName}"?`)) return;
    try {
      await templatesApi.delete(vaultId, selectedName);
      await loadList();
      void refreshTemplates(vaultId);
      setSelectedName(null);
      setDraft(null);
      setOriginalForCompare(null);
      setIsNew(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not delete template.');
    }
  }

  // ------------------------------------------------------------ render

  if (!vaultId) return null;

  return (
    <>
      <TopBar vault={vault ?? undefined} />

      <div className="nc-templates-page">
        <div className="nc-templates-header">
          <h1 className="nc-page-title">Templates</h1>
          <button
            type="button"
            className="nc-btn"
            onClick={() => navigate(`/vaults/${vaultId}`)}
          >
            ← Back to vault
          </button>
        </div>

        <p className="nc-templates-help">
          Templates are markdown skeletons stored in
          <code> .notesapp/templates/</code> inside this vault. Type
          <code> /</code> in the editor and pick a template by name to
          insert its content at the cursor.
        </p>

        <div className="nc-templates-body">
          {/* Left rail: list */}
          <aside className="nc-templates-list">
            <button
              type="button"
              className="nc-btn nc-btn-primary nc-templates-new"
              onClick={startNew}
            >
              + New template
            </button>
            {templates.length === 0 ? (
              <p className="nc-empty">No templates yet.</p>
            ) : (
              <ul>
                {templates.map((tpl) => (
                  <li key={tpl.name}>
                    <button
                      type="button"
                      className={
                        selectedName === tpl.name
                          ? 'nc-templates-row nc-templates-row-active'
                          : 'nc-templates-row'
                      }
                      onClick={() => selectTemplate(tpl.name)}
                    >
                      <span className="nc-templates-row-name">{tpl.name}</span>
                      <span className="nc-templates-row-time">
                        {formatNoteTimestamp(tpl.lastModified)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          {/* Right pane: editor */}
          <main className="nc-templates-editor">
            {!draft && (
              <p className="nc-empty">
                Pick a template on the left, or click <em>+ New template</em>.
              </p>
            )}
            {draft && (
              <>
                <label className="nc-templates-field">
                  <span className="nc-templates-field-label">Name</span>
                  <input
                    type="text"
                    className="nc-templates-name"
                    value={draft.name}
                    placeholder="e.g. Daily, Meeting, Bug Report"
                    onChange={(e) =>
                      setDraft((d) => (d ? { ...d, name: e.target.value } : d))
                    }
                  />
                </label>

                {/*
                  Body field is a <div>, NOT a <label>. A <label>
                  wrapping the rich editor causes every click inside
                  the editor area to bounce focus to the first
                  nested <input> — which, for any template that
                  contains a code block, is the code block's title
                  input. Result: clicking anywhere in the body warps
                  the cursor to the code-title field. The Name field
                  above stays a <label> because that's a real
                  one-control association and works as intended.
                */}
                <div className="nc-templates-field nc-templates-field-grow">
                  <span className="nc-templates-field-label">Body (markdown)</span>
                  {/*
                    Rich editor for the template body. The `key` is
                    deliberate: TemplateEditor's TipTap instance is
                    created once and not refreshed on prop changes
                    (see the long comment in TemplateEditor about
                    why useEditor has no deps array). To switch the
                    editor's content when the user picks a different
                    template, we force a remount via React key.

                    For unsaved-new templates we use a sentinel
                    "__new__" so that clicking "+ New template" also
                    remounts to a clean blank editor, even if the
                    previous selection happened to also have empty
                    body.

                    onChange writes the latest markdown into draft
                    via the same pattern the textarea used; the
                    save-on-click flow is unchanged. Note that
                    onChange fires on every keystroke (TipTap
                    onUpdate semantics) but `dirty` is computed from
                    the current draft vs the loaded original, so
                    we still light up the Save button correctly.
                  */}
                  <TemplateEditor
                    key={isNew ? '__new__' : selectedName ?? '__none__'}
                    vaultId={vaultId}
                    initialBody={
                      // For new templates, start blank. For an
                      // existing template, use the loaded body —
                      // NOT draft.body, because draft.body churns
                      // on every keystroke and the editor's
                      // useEditor has no deps array (intentional —
                      // see TemplateEditor's comment). The editor
                      // is mounted once per selection and managed
                      // via the React `key` above.
                      isNew ? '' : originalForCompare?.body ?? ''
                    }
                    onChange={(md) =>
                      setDraft((d) => (d ? { ...d, body: md } : d))
                    }
                  />
                </div>

                {error && <div className="nc-form-error">{error}</div>}

                <div className="nc-templates-actions">
                  <button
                    type="button"
                    className="nc-btn nc-btn-primary"
                    disabled={saving || !dirty}
                    onClick={() => void save()}
                  >
                    {saving ? 'Saving…' : isNew ? 'Create' : 'Save'}
                  </button>
                  {!isNew && selectedName && (
                    <button
                      type="button"
                      className="nc-btn nc-btn-danger"
                      onClick={() => void deleteSelected()}
                    >
                      🗑 Delete
                    </button>
                  )}
                </div>
              </>
            )}
          </main>
        </div>
      </div>
    </>
  );
}

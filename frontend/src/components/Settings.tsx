import { useEffect, useState } from 'react'
import { api, type ConfigPayload, type ProjectEntry, type RawConfig } from '../api'
import FolderPicker from './FolderPicker'

interface Props {
  onClose: () => void
  onSaved: () => void
}

type Tab = 'form' | 'yaml'

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

function folderName(path: string): string {
  const base = path.split(/[\\/]/).filter(Boolean).pop() ?? ''
  return base.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '')
}

export default function Settings({ onClose, onSaved }: Props) {
  const [payload, setPayload] = useState<ConfigPayload | null>(null)
  const [raw, setRaw] = useState<RawConfig>({})
  const [yamlText, setYamlText] = useState('')
  const [tab, setTab] = useState<Tab>('form')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [picking, setPicking] = useState<number | null>(null)

  const load = (p: ConfigPayload) => {
    setPayload(p)
    setRaw(clone(p.raw))
    setYamlText(p.yaml)
    setDirty(false)
  }

  useEffect(() => {
    api.config().then(load).catch((e) => setError(e.message))
  }, [])

  const edit = (fn: (draft: RawConfig) => void) => {
    setRaw((prev) => {
      const draft = clone(prev)
      fn(draft)
      return draft
    })
    setDirty(true)
    setNotice(null)
  }

  const projects = raw.projects ?? []
  const preview = raw.preview ?? {}
  const editProject = (i: number, patch: Partial<ProjectEntry>) =>
    edit((d) => {
      const p = { ...d.projects![i], ...patch }
      // Drop empty optional values so the YAML stays clean
      for (const k of ['assets_dir', 'preview_port'] as const) if (p[k] === '' || p[k] == null) delete p[k]
      d.projects![i] = p
    })

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const result = await api.saveConfig(tab === 'yaml' ? { yaml: yamlText } : { raw })
      load(result)
      setNotice('Saved and applied.')
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const discard = () => {
    if (payload) load(payload)
    setError(null)
  }

  return (
    <div className="modal-backdrop">
      <div className="modal settings">
        <div className="modal-header">
          <h2>Settings</h2>
          <div className="tabs">
            {(['form', 'yaml'] as Tab[]).map((t) => (
              <button
                key={t}
                className={tab === t ? 'active' : ''}
                disabled={dirty && tab !== t}
                title={dirty && tab !== t ? 'Save or discard your changes first' : undefined}
                onClick={() => setTab(t)}
              >
                {t === 'form' ? 'Projects' : 'YAML'}
              </button>
            ))}
          </div>
          <button className="close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {!payload && !error && <p className="muted">Loading…</p>}

          {payload && payload.errors.length > 0 && (
            <div className="form-warning">
              <b>Some projects could not be loaded and are currently skipped:</b>
              <ul>{payload.errors.map((e) => <li key={e}>{e}</li>)}</ul>
              Fix their folder (or remove them) and save.
            </div>
          )}

          {payload && tab === 'form' && (
            <>
              <section>
                <h3>Projects</h3>
                <table className="projects-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Folder (contains mkdocs.yml)</th>
                      <th title="Relative to docs_dir">Image folder</th>
                      <th>Preview port</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((p, i) => (
                      <tr key={i}>
                        <td>
                          <input value={p.name ?? ''} onChange={(e) => editProject(i, { name: e.target.value })} />
                        </td>
                        <td className="path-cell">
                          <input value={p.path ?? ''} onChange={(e) => editProject(i, { path: e.target.value })} />
                          <button onClick={() => setPicking(i)}>Browse…</button>
                        </td>
                        <td>
                          <input
                            placeholder="assets/images"
                            value={p.assets_dir ?? ''}
                            onChange={(e) => editProject(i, { assets_dir: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            placeholder="auto"
                            value={p.preview_port ?? ''}
                            onChange={(e) =>
                              editProject(i, { preview_port: e.target.value ? Number(e.target.value) : null })
                            }
                          />
                        </td>
                        <td>
                          <button
                            className="danger"
                            title="Remove project (files on disk are not touched)"
                            onClick={() => edit((d) => d.projects!.splice(i, 1))}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  onClick={() => {
                    edit((d) => (d.projects = [...(d.projects ?? []), { name: '', path: '' }]))
                    setPicking(projects.length)
                  }}
                >
                  + Add project
                </button>
              </section>

              <section className="grid-form">
                <h3>Preview</h3>
                <label>
                  <input
                    type="checkbox"
                    checked={preview.enabled ?? true}
                    onChange={(e) => edit((d) => (d.preview = { ...d.preview, enabled: e.target.checked }))}
                  />
                  Run <code>mkdocs serve</code> for each project
                </label>
                <label>
                  First preview port
                  <input
                    type="number"
                    value={preview.base_port ?? 8100}
                    onChange={(e) => edit((d) => (d.preview = { ...d.preview, base_port: Number(e.target.value) }))}
                  />
                </label>
                <label>
                  Preview hostname
                  <input
                    placeholder="same as this page"
                    value={preview.host ?? ''}
                    onChange={(e) =>
                      edit((d) => {
                        d.preview = { ...d.preview, host: e.target.value || undefined }
                        if (!e.target.value) delete d.preview.host
                      })
                    }
                  />
                </label>
                <p className="hint">
                  In Docker, every preview port must be published (e.g. <code>8100-8119:8100-8119</code>).
                </p>
              </section>

              <section className="grid-form">
                <h3>Editor</h3>
                <label>
                  Autosave delay (seconds)
                  <input
                    type="number"
                    step="0.5"
                    min="0.2"
                    value={raw.autosave_delay ?? 1}
                    onChange={(e) => edit((d) => (d.autosave_delay = Number(e.target.value)))}
                  />
                </label>
                <p className="hint">
                  Allowed folders: {payload.allowedRoots.length ? payload.allowedRoots.join(', ') : 'unrestricted'}{' '}
                  (set <code>allowed_roots</code> in the YAML tab).
                </p>
              </section>
            </>
          )}

          {payload && tab === 'yaml' && (
            <>
              <p className="hint">
                Editing <code>{payload.configPath}</code>. Comments are kept when saving from this tab
                (saving from the Projects tab rewrites the file without them).
              </p>
              <textarea
                className="yaml-editor"
                spellCheck={false}
                value={yamlText}
                onChange={(e) => {
                  setYamlText(e.target.value)
                  setDirty(true)
                  setNotice(null)
                }}
              />
            </>
          )}
        </div>

        <div className="modal-footer">
          {error && <div className="form-error">{error}</div>}
          {notice && <div className="form-notice">{notice}</div>}
          <span className="spacer" />
          <button disabled={!dirty || saving} onClick={discard}>Discard</button>
          <button className="primary" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save & apply'}
          </button>
        </div>
      </div>

      {picking !== null && (
        <FolderPicker
          start={projects[picking]?.path ?? ''}
          onClose={() => setPicking(null)}
          onPick={(path) => {
            const i = picking
            editProject(i, { path, ...(projects[i]?.name ? {} : { name: folderName(path) }) })
            setPicking(null)
          }}
        />
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { api, type FsListing } from '../api'

interface Props {
  start: string
  onPick: (path: string) => void
  onClose: () => void
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.endsWith(sep) ? dir + name : dir + sep + name
}

export default function FolderPicker({ start, onPick, onClose }: Props) {
  const [listing, setListing] = useState<FsListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [siteName, setSiteName] = useState('')

  const open = (path: string) =>
    api.browse(path).then((l) => {
      setListing(l)
      setError(null)
    }).catch((e) => setError(e.message))

  useEffect(() => {
    // Start in the parent of the current value so the selected folder is visible in the list.
    api.browse(start).then(
      (l) => (l.parent != null && l.mkdocs ? open(l.parent) : setListing(l)),
      () => open(''),
    )
  }, [start])

  const createProject = async () => {
    if (!listing?.path || !newName.trim()) return
    try {
      const { path } = await api.initMkdocs(joinPath(listing.path, newName.trim()), siteName || newName.trim())
      onPick(path)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose() }}>
      <div className="modal picker" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Choose project folder</h2>
          <button className="close" onClick={onClose}>×</button>
        </div>
        <div className="picker-path">
          <button disabled={listing?.parent == null} onClick={() => listing?.parent != null && open(listing.parent)}>
            ↑ Up
          </button>
          <code>{listing?.path || 'Allowed folders'}</code>
        </div>
        {error && <div className="form-error">{error}</div>}
        <ul className="picker-list">
          {listing?.dirs.map((d) => (
            <li key={d.path} onDoubleClick={() => open(d.path)}>
              <span className="picker-name" onClick={() => open(d.path)}>📁 {d.name}</span>
              {d.mkdocs && <span className="tag">mkdocs</span>}
              {d.mkdocs && <button className="primary small" onClick={() => onPick(d.path)}>Use</button>}
            </li>
          ))}
          {listing && listing.dirs.length === 0 && <li className="muted">No sub-folders</li>}
        </ul>
        <div className="picker-footer">
          {listing?.mkdocs && (
            <button className="primary" onClick={() => onPick(listing.path)}>Use this folder</button>
          )}
          {listing?.path && (
            <details>
              <summary>Create a new MkDocs project here…</summary>
              <div className="inline-form">
                <input placeholder="folder-name" value={newName} onChange={(e) => setNewName(e.target.value)} />
                <input placeholder="Site name (optional)" value={siteName} onChange={(e) => setSiteName(e.target.value)} />
                <button className="primary" disabled={!newName.trim()} onClick={createProject}>Create</button>
              </div>
              <p className="hint">
                Creates <code>{newName ? joinPath(listing.path, newName) : '…'}</code> with a minimal
                mkdocs.yml (Material theme) and docs/index.md. Use an existing empty folder's name to initialise it.
              </p>
            </details>
          )}
        </div>
      </div>
    </div>
  )
}

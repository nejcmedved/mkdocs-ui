import { useCallback, useEffect, useState } from 'react'
import { api, type ProjectInfo, type TreeNode } from './api'
import { loadUser, saveUser, type User } from './user'
import FileTree from './components/FileTree'
import Editor from './components/Editor'
import Preview from './components/Preview'
import Settings from './components/Settings'

const POLL_MS = 5000

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1))
  return { project: params.get('project'), file: params.get('file') }
}

function writeHash(project: string | null, file: string | null) {
  const params = new URLSearchParams()
  if (project) params.set('project', project)
  if (file) params.set('file', file)
  history.replaceState(null, '', '#' + params.toString())
}

function containsFile(nodes: TreeNode[], path: string): boolean {
  return nodes.some((n) => n.path === path || (n.children ? containsFile(n.children, path) : false))
}

export default function App() {
  const [user, setUser] = useState<User | null>(loadUser)
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [projectName, setProjectName] = useState<string | null>(() => readHash().project)
  const [file, setFile] = useState<string | null>(() => readHash().file)
  const [tree, setTree] = useState<TreeNode[]>([])
  const [active, setActive] = useState<Record<string, number>>({})
  const [showPreview, setShowPreview] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  const project = projects.find((p) => p.name === projectName) ?? null

  const loadProjects = useCallback(() => {
    api.projects().then((list) => {
      setProjects(list)
      setProjectName((current) => {
        if (list.some((p) => p.name === current)) return current
        setFile(null)
        return list[0]?.name ?? null
      })
    }).catch((e) => setError(e.message))
  }, [])

  useEffect(loadProjects, [loadProjects])

  useEffect(() => writeHash(projectName, file), [projectName, file])

  const refresh = useCallback(async () => {
    if (!projectName) return
    try {
      const [t, a] = await Promise.all([api.tree(projectName), api.active(projectName)])
      setTree(t)
      setActive(a)
      return t
    } catch (e) {
      setError((e as Error).message)
    }
  }, [projectName])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    }
    await refresh()
  }

  const handleCreate = (dir: string, type: 'file' | 'dir') => {
    const label = type === 'file' ? 'New file name (e.g. page.md)' : 'New folder name'
    let name = prompt(label)?.trim()
    if (!name || !projectName) return
    if (type === 'file' && !name.includes('.')) name += '.md'
    const path = dir ? `${dir}/${name}` : name
    run(async () => {
      const res = await api.create(projectName, path, type)
      if (type === 'file') setFile(res.path)
    })
  }

  const handleRename = (path: string) => {
    const newPath = prompt('Rename / move to (path inside docs/)', path)?.trim()
    if (!newPath || newPath === path || !projectName) return
    run(async () => {
      const res = await api.rename(projectName, path, newPath)
      if (file === path) setFile(res.path)
      else if (file?.startsWith(path + '/')) setFile(res.path + file.slice(path.length))
    })
  }

  const handleDelete = (path: string, type: 'file' | 'dir') => {
    const what = type === 'dir' ? `folder "${path}" and everything in it` : `"${path}"`
    if (!projectName || !confirm(`Delete ${what}? This cannot be undone.`)) return
    run(async () => {
      await api.remove(projectName, path)
      if (file === path || file?.startsWith(path + '/')) setFile(null)
    })
  }

  const handleConnectionClosed = useCallback(async () => {
    const t = await refresh()
    // Functional update: a concurrent rename may already have pointed us at the new path.
    if (t) setFile((cur) => (cur && !containsFile(t, cur) ? null : cur))
  }, [refresh])

  if (!user) return <NamePrompt onSubmit={(name) => setUser(saveUser(name))} />

  return (
    <div className={`app ${showPreview ? 'with-preview' : ''}`}>
      <header className="topbar">
        <span className="logo">MkDocs UI</span>
        <select
          value={projectName ?? ''}
          onChange={(e) => {
            setProjectName(e.target.value)
            setFile(null)
          }}
        >
          {projects.map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>
        <span className="spacer" />
        <button className="icon-button" title="Settings: projects & config" onClick={() => setShowSettings(true)}>
          ⚙
        </button>
        <label className="toggle">
          <input type="checkbox" checked={showPreview} onChange={(e) => setShowPreview(e.target.checked)} /> Preview
        </label>
        <button
          className="user-chip"
          style={{ borderColor: user.color }}
          title="Change name"
          onClick={() => {
            const name = prompt('Your display name', user.name)?.trim()
            if (name) setUser(saveUser(name))
          }}
        >
          <span className="dot" style={{ background: user.color }} /> {user.name}
        </button>
      </header>

      {error && (
        <div className="error-bar" onClick={() => setError(null)}>
          {error} <span className="dismiss">×</span>
        </div>
      )}

      <aside className="sidebar">
        {projectName && (
          <FileTree
            project={projectName}
            tree={tree}
            selected={file}
            active={active}
            onOpen={setFile}
            onCreate={handleCreate}
            onRename={handleRename}
            onDelete={handleDelete}
          />
        )}
      </aside>

      <main className="main">
        {projectName && file ? (
          <Editor
            key={`${projectName}/${file}`}
            project={projectName}
            path={file}
            user={user}
            onConnectionClosed={handleConnectionClosed}
          />
        ) : (
          <div className="placeholder">
            {projects.length === 0 ? (
              <>
                No projects configured yet. <button onClick={() => setShowSettings(true)}>Open settings</button>
              </>
            ) : (
              'Select a file to start editing.'
            )}
          </div>
        )}
      </main>

      {showPreview && project && <Preview project={project} file={file} />}

      {showSettings && <Settings onClose={() => setShowSettings(false)} onSaved={loadProjects} />}
    </div>
  )
}

function NamePrompt({ onSubmit }: { onSubmit: (name: string) => void }) {
  const [name, setName] = useState('')
  return (
    <div className="name-prompt">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) onSubmit(name.trim())
        }}
      >
        <h1>MkDocs UI</h1>
        <p>Enter your name. Other editors will see it next to your cursor.</p>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
        <button type="submit" disabled={!name.trim()}>Start editing</button>
      </form>
    </div>
  )
}

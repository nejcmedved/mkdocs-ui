import { useEffect, useState } from 'react'
import { api, previewUrl, type ProjectInfo } from '../api'

interface Props {
  project: ProjectInfo
  file: string | null
}

export default function Preview({ project, file }: Props) {
  const url = previewUrl(project, file)
  const [nonce, setNonce] = useState(0)
  const [showLogs, setShowLogs] = useState(false)
  const [logs, setLogs] = useState<{ status: string; logs: string[] } | null>(null)

  useEffect(() => {
    if (!showLogs) return
    let cancelled = false
    const load = () => api.previewLogs(project.name).then((l) => !cancelled && setLogs(l)).catch(() => {})
    load()
    const timer = setInterval(load, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [showLogs, project.name])

  if (!url) {
    return <div className="preview empty">Preview is disabled for this project.</div>
  }

  return (
    <div className="preview">
      <div className="preview-header">
        <span>Preview</span>
        <span className="spacer" />
        <button title="Reload preview" onClick={() => setNonce((n) => n + 1)}>⟳</button>
        <button title="mkdocs serve output" className={showLogs ? 'on' : ''} onClick={() => setShowLogs(!showLogs)}>
          Logs
        </button>
        <a href={url} target="_blank" rel="noreferrer" title="Open in new tab">↗</a>
      </div>
      {showLogs ? (
        <div className="logs">
          <div className="logs-bar">
            Status: <b>{logs?.status ?? '…'}</b>
            <button onClick={() => api.restartPreview(project.name).then(() => setNonce((n) => n + 1))}>
              Restart mkdocs
            </button>
          </div>
          <pre>{logs?.logs.join('\n')}</pre>
        </div>
      ) : (
        <iframe key={`${url}#${nonce}`} src={url} title="MkDocs preview" />
      )}
    </div>
  )
}

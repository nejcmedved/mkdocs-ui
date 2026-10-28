import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import { EditorState } from '@codemirror/state'
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars,
} from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { api, wsUrl } from '../api'
import type { User } from '../user'
import Toolbar from './Toolbar'

type Status = 'connecting' | 'connected' | 'disconnected'

interface Props {
  project: string
  path: string
  user: User
  /** Called when the server drops the connection (e.g. the file was renamed or deleted). */
  onConnectionClosed: () => void
}

export default function Editor({ project, path, user, onConnectionClosed }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<EditorView | null>(null)
  const [status, setStatus] = useState<Status>('connecting')
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [peers, setPeers] = useState<User[]>([])
  const [error, setError] = useState<string | null>(null)
  // Bumped to rebuild the session from scratch after a disconnect (see below).
  const [generation, setGeneration] = useState(0)
  const closedRef = useRef(onConnectionClosed)
  closedRef.current = onConnectionClosed

  useEffect(() => {
    // Every connection gets a fresh Y.Doc. The server re-seeds a room from disk when it
    // is recreated (e.g. after a restart), so reusing an old doc would duplicate content.
    const ydoc = new Y.Doc()
    const provider = new WebsocketProvider(wsUrl(project), path, ydoc, { disableBc: true })
    const ytext = ydoc.getText('content')
    const meta = ydoc.getMap('meta')
    const undoManager = new Y.UndoManager(ytext)

    provider.awareness.setLocalStateField('user', { name: user.name, color: user.color, colorLight: user.color + '33' })

    const updatePeers = () => {
      const list: User[] = []
      provider.awareness.getStates().forEach((state, clientId) => {
        if (clientId !== ydoc.clientID && state.user) list.push(state.user)
      })
      setPeers(list)
    }
    provider.awareness.on('change', updatePeers)
    meta.observe(() => setSavedAt((meta.get('savedAt') as number) ?? null))

    let disposed = false
    let wasConnected = false
    provider.on('status', ({ status }) => {
      setStatus(status)
      if (status === 'connected') wasConnected = true
    })
    provider.on('connection-close', () => {
      if (disposed) return
      disposed = true
      setStatus('disconnected')
      if (wasConnected) closedRef.current()
      setTimeout(() => setGeneration((g) => g + 1), 1000)
    })

    const editor = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          bracketMatching(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of([...yUndoManagerKeymap, ...defaultKeymap, ...searchKeymap, indentWithTab]),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          EditorView.lineWrapping,
          yCollab(ytext, provider.awareness, { undoManager }),
          EditorView.domEventHandlers({
            paste: (event, view) => {
              const files = imageFiles(event.clipboardData?.files)
              if (!files.length) return false
              event.preventDefault()
              files.forEach((f) => uploadInto(view, f))
              return true
            },
            drop: (event, view) => {
              const files = imageFiles(event.dataTransfer?.files)
              if (!files.length) return false
              event.preventDefault()
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
              if (pos != null) view.dispatch({ selection: { anchor: pos } })
              files.forEach((f) => uploadInto(view, f))
              return true
            },
          }),
        ],
      }),
    })
    setView(editor)
    setSavedAt(null)
    setError(null)

    async function uploadInto(view: EditorView, file: File) {
      const placeholder = `![Uploading ${file.name || 'image'} (${Math.random().toString(36).slice(2, 8)})…]()`
      const { from, to } = view.state.selection.main
      view.dispatch({ changes: { from, to, insert: placeholder }, selection: { anchor: from + placeholder.length } })
      let replacement = ''
      try {
        const { link } = await api.upload(project, path, file)
        replacement = `![](${link})`
      } catch (e) {
        setError(`Image upload failed: ${(e as Error).message}`)
      }
      // Collaborators may have edited around the placeholder meanwhile, so look it up again.
      const at = view.state.doc.toString().indexOf(placeholder)
      if (at >= 0) view.dispatch({ changes: { from: at, to: at + placeholder.length, insert: replacement } })
    }

    return () => {
      disposed = true
      editor.destroy()
      provider.destroy()
      ydoc.destroy()
      setView(null)
    }
  }, [project, path, user, generation])

  const uploadFromPicker = async (files: FileList | null) => {
    if (!view) return
    for (const file of imageFiles(files)) {
      const { from, to } = view.state.selection.main
      try {
        const { link } = await api.upload(project, path, file)
        const text = `![](${link})`
        view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
      } catch (e) {
        setError(`Image upload failed: ${(e as Error).message}`)
      }
    }
    view.focus()
  }

  return (
    <div className="editor">
      <div className="editor-header">
        <span className="file-path" title={path}>{path}</span>
        <Toolbar view={view} onImages={uploadFromPicker} />
        <div className="presence">
          {peers.map((p, i) => (
            <span key={i} className="avatar" style={{ background: p.color }} title={p.name}>
              {p.name.slice(0, 1).toUpperCase()}
            </span>
          ))}
        </div>
        <span className={`status status-${status}`}>
          {status === 'connected'
            ? savedAt ? `Saved ${new Date(savedAt * 1000).toLocaleTimeString()}` : 'Connected'
            : status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
        </span>
      </div>
      {error && (
        <div className="error-bar" onClick={() => setError(null)}>
          {error} <span className="dismiss">×</span>
        </div>
      )}
      <div className="editor-body" ref={hostRef} />
    </div>
  )
}

function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith('image/'))
}

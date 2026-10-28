import { useRef } from 'react'
import type { EditorView } from '@codemirror/view'

interface Props {
  view: EditorView | null
  onImages: (files: FileList | null) => void
}

function wrap(view: EditorView, before: string, after = before, placeholder = 'text') {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to) || placeholder
  view.dispatch({
    changes: { from, to, insert: before + selected + after },
    selection: { anchor: from + before.length, head: from + before.length + selected.length },
  })
  view.focus()
}

function prefixLines(view: EditorView, prefix: string) {
  const { from, to } = view.state.selection.main
  const changes = []
  for (let pos = from; pos <= to; ) {
    const line = view.state.doc.lineAt(pos)
    changes.push({ from: line.from, insert: prefix })
    pos = line.to + 1
  }
  view.dispatch({ changes })
  view.focus()
}

function insertBlock(view: EditorView, text: string) {
  const { from } = view.state.selection.main
  const line = view.state.doc.lineAt(from)
  const insert = (line.length ? '\n\n' : '') + text
  const at = line.to
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length } })
  view.focus()
}

export default function Toolbar({ view, onImages }: Props) {
  const fileInput = useRef<HTMLInputElement>(null)
  const act = (fn: (v: EditorView) => void) => () => view && fn(view)

  return (
    <div className="toolbar">
      <button title="Bold (wraps selection)" onClick={act((v) => wrap(v, '**'))}><b>B</b></button>
      <button title="Italic" onClick={act((v) => wrap(v, '*'))}><i>I</i></button>
      <button title="Inline code" onClick={act((v) => wrap(v, '`', '`', 'code'))}>{'</>'}</button>
      <button title="Heading" onClick={act((v) => prefixLines(v, '## '))}>H</button>
      <button title="Bullet list" onClick={act((v) => prefixLines(v, '- '))}>•</button>
      <button title="Link" onClick={act((v) => wrap(v, '[', '](https://)', 'link text'))}>🔗</button>
      <button
        title="Admonition"
        onClick={act((v) => insertBlock(v, '!!! note "Title"\n    Content\n'))}
      >!</button>
      <button title="Insert image (or paste / drop one into the editor)" onClick={() => fileInput.current?.click()}>
        🖼
      </button>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          onImages(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

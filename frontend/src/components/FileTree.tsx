import { useState } from 'react'
import type { TreeNode } from '../api'

interface Props {
  project: string
  tree: TreeNode[]
  selected: string | null
  active: Record<string, number>
  onOpen: (path: string) => void
  onCreate: (dir: string, type: 'file' | 'dir') => void
  onRename: (path: string) => void
  onDelete: (path: string, type: 'file' | 'dir') => void
}

const EDITABLE = /\.(md|markdown|yml|yaml|txt|css|js|html|json)$/i

export default function FileTree(props: Props) {
  return (
    <div className="tree">
      <div className="tree-root-actions">
        <span>docs/</span>
        <span className="actions">
          <button title="New file" onClick={() => props.onCreate('', 'file')}>+📄</button>
          <button title="New folder" onClick={() => props.onCreate('', 'dir')}>+📁</button>
        </span>
      </div>
      <NodeList nodes={props.tree} depth={0} {...props} />
    </div>
  )
}

function NodeList({ nodes, depth, ...props }: Props & { nodes: TreeNode[]; depth: number }) {
  return (
    <ul>
      {nodes.map((n) => (
        <Node key={n.path} node={n} depth={depth} {...props} />
      ))}
    </ul>
  )
}

function Node({ node, depth, ...props }: Props & { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1 || props.selected?.startsWith(node.path + '/'))
  const isDir = node.type === 'dir'
  const editable = !isDir && EDITABLE.test(node.name)
  const users = props.active[node.path]

  const onClick = () => {
    if (isDir) setOpen(!open)
    else if (editable) props.onOpen(node.path)
    else window.open(`/api/projects/${encodeURIComponent(props.project)}/raw/${node.path}`, '_blank')
  }

  return (
    <li>
      <div
        className={`tree-item ${props.selected === node.path ? 'selected' : ''} ${editable || isDir ? '' : 'muted'}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={onClick}
      >
        <span className="icon">{isDir ? (open ? '▾' : '▸') : node.name.endsWith('.md') ? '📝' : '📄'}</span>
        <span className="name">{node.name}</span>
        {users ? <span className="badge" title={`${users} editing`}>{users}</span> : null}
        <span className="actions" onClick={(e) => e.stopPropagation()}>
          {isDir && (
            <>
              <button title="New file here" onClick={() => props.onCreate(node.path, 'file')}>+📄</button>
              <button title="New folder here" onClick={() => props.onCreate(node.path, 'dir')}>+📁</button>
            </>
          )}
          <button title="Rename / move" onClick={() => props.onRename(node.path)}>✎</button>
          <button title="Delete" onClick={() => props.onDelete(node.path, node.type)}>🗑</button>
        </span>
      </div>
      {isDir && open && node.children && <NodeList nodes={node.children} depth={depth + 1} {...props} />}
    </li>
  )
}


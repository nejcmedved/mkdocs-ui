export interface ProjectInfo {
  name: string
  previewPort: number | null
  previewHost: string | null
  useDirectoryUrls: boolean
  previewStatus: string | null
}

export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: TreeNode[]
}

export interface ProjectEntry {
  name: string
  path: string
  assets_dir?: string
  preview_port?: number | null
  [key: string]: unknown
}

export interface RawConfig {
  projects?: ProjectEntry[]
  preview?: { enabled?: boolean; base_port?: number; host?: string | null; [key: string]: unknown }
  autosave_delay?: number
  allowed_roots?: string[]
  [key: string]: unknown
}

export interface ConfigPayload {
  raw: RawConfig
  yaml: string
  configPath: string
  allowedRoots: string[]
  /** Projects skipped at startup (e.g. folder missing after a mount change). */
  errors: string[]
}

export interface FsListing {
  path: string
  parent: string | null
  dirs: { name: string; path: string; mkdocs: boolean }[]
  mkdocs?: boolean
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    let detail = res.statusText
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* not JSON */
    }
    throw new Error(detail)
  }
  return res.json()
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const p = (project: string) => `/api/projects/${encodeURIComponent(project)}`

export const api = {
  projects: () => request<ProjectInfo[]>('/api/projects'),
  tree: (project: string) => request<TreeNode[]>(`${p(project)}/tree`),
  active: (project: string) => request<Record<string, number>>(`${p(project)}/active`),
  create: (project: string, path: string, type: 'file' | 'dir') =>
    request<{ path: string }>(`${p(project)}/files`, json({ path, type })),
  rename: (project: string, path: string, newPath: string) =>
    request<{ path: string }>(`${p(project)}/rename`, json({ path, new_path: newPath })),
  remove: (project: string, path: string) =>
    request(`${p(project)}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  previewLogs: (project: string) =>
    request<{ status: string; logs: string[] }>(`${p(project)}/preview/logs`),
  restartPreview: (project: string) => request(`${p(project)}/preview/restart`, { method: 'POST' }),
  config: () => request<ConfigPayload>('/api/config'),
  saveConfig: (update: { raw?: RawConfig; yaml?: string }) =>
    request<ConfigPayload>('/api/config', { ...json(update), method: 'PUT' }),
  browse: (path: string) => request<FsListing>(`/api/fs?path=${encodeURIComponent(path)}`),
  initMkdocs: (path: string, siteName: string) =>
    request<{ path: string }>('/api/fs/init', json({ path, site_name: siteName })),
  upload: (project: string, document: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    form.append('document', document)
    return request<{ path: string; link: string }>(`${p(project)}/upload`, { method: 'POST', body: form })
  },
}

export function wsUrl(project: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws/${encodeURIComponent(project)}`
}

/** URL of the rendered page for a docs file, served by the project's `mkdocs serve`. */
export function previewUrl(project: ProjectInfo, file: string | null): string | null {
  if (!project.previewPort) return null
  const base = `${location.protocol}//${project.previewHost || location.hostname}:${project.previewPort}/`
  if (!file || !file.endsWith('.md')) return base
  let page = file.slice(0, -3)
  const name = page.split('/').pop()!
  if (name === 'index' || name.toLowerCase() === 'readme') {
    page = page.slice(0, -name.length)
  } else {
    page = project.useDirectoryUrls ? `${page}/` : `${page}.html`
  }
  return base + page.split('/').map(encodeURIComponent).join('/')
}

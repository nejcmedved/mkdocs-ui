export interface User {
  name: string
  color: string
}

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0aa5a5', '#d6338a', '#808000']
const KEY = 'mkdocs-ui-user'

export function loadUser(): User | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function saveUser(name: string): User {
  const user = { name, color: COLORS[Math.floor(Math.random() * COLORS.length)] }
  try {
    localStorage.setItem(KEY, JSON.stringify(user))
  } catch {
    /* storage unavailable: keep the user for this session only */
  }
  return user
}

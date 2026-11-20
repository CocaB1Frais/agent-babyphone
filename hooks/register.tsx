import type { EngineInterface, Register } from 'claude-code'

// Writes this session's state to ~/.claude/agent-babyphone/sessions/<id>.json, read by the
// Agent Babyphone widget (app/, installed by scripts/launch.js). Permission asks and questions go through
// scripts/permission-wait.js; the widget asks a stop by writing stop/<id>.
const BS = String.fromCharCode(92)
const SEP = new RegExp('[/' + BS + BS + ']')
const MAX_STEPS = 80
const ROOT_MARKERS = ['.git', 'package.json', 'default.project.json', 'pyproject.toml', 'Cargo.toml', '.claude-plugin', 'go.mod']

type Kind = 'msg' | 'read' | 'edit' | 'cmd' | 'search' | 'web' | 'agent' | 'other' | 'done'
type Agent = { id: string; desc: string; action: string }
type Step = { t: number; text: string; kind: Kind; agent?: string }
type Task = { text: string; status: 'pending' | 'in_progress' | 'completed' }
type Terminal = { command: string; output: string; running: boolean }
type Session = {
  id: string; title: string; isTitled: boolean; project: string; cwd: string
  status: 'working' | 'idle'; action: string; since: number; updated: number
  agents: Agent[]; steps: Step[]; tasks: Task[]; terminal?: Terminal
  usage?: { percent?: number; usd?: number }
}

const str = (input: Record<string, unknown>, k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
const norm = (p: string) => p.split(BS).join('/').replace(/\/+$/, '')
const base = (p: string) => norm(p).split('/').pop() || p
const isAbs = (p: string) => /^([a-zA-Z]:)?\//.test(norm(p))

// Drops leading `cd somewhere &&` / `cd somewhere;` so the real command shows.
export function stripCd(cmd: string): string {
  return cmd.replace(/^\s*(cd|Set-Location|pushd)\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;|\|\|)\s*/i, '').trim()
}
export function cdTarget(cmd: string): string {
  const m = /^\s*(?:cd|Set-Location|pushd)\s+("([^"]*)"|'([^']*)'|(\S+))/i.exec(cmd)
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : ''
}

// A plain-French line for a shell command, for people who don't read shell.
export function describeCommand(raw: string): string {
  const cmd = stripCd(raw)
  const w = cmd.split(/\s+/)
  const [a = '', b = '', c = ''] = w
  const lc = a.toLowerCase().replace(/\.exe$/, '')
  const npmRun = (s: string) => `Lance le script « ${s} »`
  if (/^(npm|pnpm|yarn|bun)$/.test(lc)) {
    if (/^(i|install|add|ci)$/.test(b)) return c && !c.startsWith('-') ? `Installe ${c}` : 'Installe les dépendances'
    if (b === 'run') return npmRun(c)
    if (b === 'test') return 'Lance les tests'
    if (b === 'start' || b === 'dev') return "Démarre l'application"
    if (b === 'build') return 'Construit le projet'
    return `${a} ${b}`
  }
  if (lc === 'npx' || lc === 'bunx') {
    const tool = w.slice(1).find(x => !x.startsWith('-')) ?? ''
    if (/^(tsc|typescript)/.test(tool) || cmd.includes(' tsc')) return 'Vérifie les types TypeScript'
    if (/vitest|jest|playwright/.test(tool)) return 'Lance les tests'
    if (/hyperframes|remotion/.test(tool)) return `Rend la vidéo (${tool.replace(/@.*$/, '')})`
    return `Lance l'outil ${tool.replace(/@[\d.]+$/, '')}`
  }
  if (lc === 'node' || lc === 'bun' || lc === 'deno') return b === '-e' || b === '--eval' ? 'Exécute un petit script' : `Exécute ${base(b)}`
  if (/^python3?$|^py$/.test(lc)) return b === '-c' ? 'Exécute un petit script Python' : b === '-m' ? `Lance ${c}` : `Exécute ${base(b)}`
  if (lc === 'pip' || lc === 'uv') return 'Installe des paquets Python'
  if (lc === 'git') {
    const map: Record<string, string> = {
      status: "Regarde l'état du dépôt", diff: 'Compare les changements', log: "Lit l'historique", add: 'Prépare des fichiers',
      commit: 'Enregistre un commit', push: 'Envoie sur GitHub', pull: 'Récupère les changements', clone: 'Clone un dépôt',
      checkout: 'Change de branche', switch: 'Change de branche', branch: 'Gère les branches', merge: 'Fusionne une branche',
      stash: 'Met des changements de côté', restore: 'Restaure des fichiers', init: 'Crée un dépôt git',
    }
    return map[b] ?? `git ${b}`
  }
  if (lc === 'gh') return b === 'pr' ? 'Gère une pull request' : 'Utilise GitHub'
  if (lc === 'ffmpeg') return 'Traite une vidéo ou un son'
  if (lc === 'ffprobe') return 'Analyse un fichier vidéo'
  if (/^(ls|dir|get-childitem|tree)$/.test(lc)) return 'Liste des fichiers'
  if (/^(cat|type|get-content|head|tail|less|more)$/.test(lc)) return 'Affiche un fichier'
  if (/^(grep|rg|findstr|select-string|find)$/.test(lc)) return 'Cherche dans les fichiers'
  if (/^(rm|del|remove-item|rmdir)$/.test(lc)) return 'Supprime des fichiers'
  if (/^(mkdir|new-item|md)$/.test(lc)) return 'Crée un dossier'
  if (/^(cp|copy|copy-item|robocopy|xcopy)$/.test(lc)) return 'Copie des fichiers'
  if (/^(mv|move|move-item|ren|rename-item)$/.test(lc)) return 'Déplace des fichiers'
  if (/^(curl|wget|invoke-webrequest|iwr)$/.test(lc)) return 'Télécharge depuis internet'
  if (/^(echo|write-output|printf)$/.test(lc)) return 'Affiche un message'
  if (/^(cargo|go|dotnet|make|cmake|msbuild)$/.test(lc)) return `${a} ${b}`.trim()
  if (/^(rojo|wally|selene|stylua)$/.test(lc)) return `Outil Roblox : ${a} ${b}`.trim()
  if (lc === 'claude') return 'Utilise Claude Code en ligne de commande'
  return cmd.length > 50 ? `${cmd.slice(0, 50)}…` : cmd
}

export function summarize(tool: string, input: Record<string, unknown>): { text: string; kind: Kind } {
  const s = (k: string) => str(input, k)
  if (tool === 'Bash' || tool === 'PowerShell') {
    // the agent's own description is the clearest line when it wrote one
    const said = s('description')
    return { text: said || describeCommand(s('command')), kind: 'cmd' }
  }
  const file = base(s('file_path') || s('path') || s('notebook_path'))
  if (tool === 'Read' && file) return { text: `Lit ${file}`, kind: 'read' }
  if ((tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') && file)
    return { text: `${tool === 'Write' ? 'Écrit' : 'Modifie'} ${file}`, kind: 'edit' }
  if (tool === 'Grep' || tool === 'Glob') return { text: `Cherche « ${s('pattern').slice(0, 40)} »`, kind: 'search' }
  if (tool === 'Agent' || tool === 'Task') return { text: `Lance un sous-agent : ${s('description')}`, kind: 'agent' }
  if (tool === 'WebSearch') return { text: `Cherche sur le web : ${s('query').slice(0, 50)}`, kind: 'web' }
  if (tool === 'WebFetch') return { text: 'Lit une page web', kind: 'web' }
  if (tool === 'AskUserQuestion') return { text: 'Te pose une question', kind: 'msg' }
  if (tool === 'Skill') return { text: `Utilise le skill ${s('skill')}`, kind: 'other' }
  if (tool.startsWith('mcp__')) {
    const [, server = '', name = ''] = tool.split('__')
    return { text: `${server.replace(/_/g, ' ')} : ${name.replace(/_/g, ' ')}`, kind: 'other' }
  }
  return { text: file ? `${tool} ${file}` : tool, kind: 'other' }
}

const STATUSES = ['pending', 'in_progress', 'completed'] as const
const asStatus = (v: unknown): Task['status'] => (STATUSES as readonly unknown[]).includes(v) ? (v as Task['status']) : 'pending'

// Reads the agent's own task list: TodoWrite (CLI) or the desktop app's update_plan.
export function nextTasks(tool: string, input: Record<string, unknown>, tasks: Task[]): Task[] | undefined {
  const list = (v: unknown, key: string) => Array.isArray(v)
    ? v.map(x => ({ text: String((x as Record<string, unknown>)[key] ?? ''), status: asStatus((x as Record<string, unknown>).status) }))
    : undefined
  if (tool === 'TodoWrite') return list(input.todos, 'content')
  if (!tool.endsWith('update_plan')) return undefined
  if (Array.isArray(input.items)) return list(input.items, 'content')
  let out = tasks.map(t => ({ ...t }))
  if (input.advance === true) {
    const cur = out.findIndex(t => t.status === 'in_progress')
    if (cur >= 0) out[cur]!.status = 'completed'
    const nxt = out.findIndex(t => t.status === 'pending')
    if (nxt >= 0) out[nxt]!.status = 'in_progress'
  }
  if (Array.isArray(input.done)) for (const n of input.done) if (out[Number(n) - 1]) out[Number(n) - 1]!.status = 'completed'
  if (typeof input.start === 'number' && out[input.start - 1]) {
    out = out.map(t => (t.status === 'in_progress' ? { ...t, status: 'pending' } : t))
    out[input.start - 1]!.status = 'in_progress'
  }
  return out
}

let me: Session | undefined
let root = ''
let turnId: string | undefined
let firstPrompt = ''
let toolCount = 0
const rootCache = new Map<string, string>()

async function save($: EngineInterface, patch: Partial<Session>, step?: { text: string; kind: Kind }, agent?: string): Promise<void> {
  if (!me) return
  const steps = step ? [...me.steps, { t: Date.now(), ...step, ...(agent ? { agent } : {}) }].slice(-MAX_STEPS) : me.steps
  me = { ...me, ...patch, steps, updated: Date.now() }
  await $.fs.write(`${root}/sessions/${me.id}.json`, JSON.stringify(me))
}

// The project a path belongs to: the first folder under the session's cwd, else the
// nearest parent holding a project marker (.git, package.json, ...), else its folder.
async function projectOf($: EngineInterface, path: string, isDir: boolean): Promise<string> {
  const p = norm(path), cwd = norm(me?.cwd ?? '')
  if (cwd && p.toLowerCase().startsWith(cwd.toLowerCase() + '/')) return p.slice(cwd.length + 1).split('/')[0] || base(cwd)
  if (cwd && p.toLowerCase() === cwd.toLowerCase()) return base(cwd)
  const parts = p.split('/')
  let dir = isDir ? p : parts.slice(0, -1).join('/')
  const start = dir
  const hit = rootCache.get(start)
  if (hit) return hit
  for (let i = 0; i < 6 && dir.includes('/'); i++) {
    for (const m of ROOT_MARKERS) {
      if (await $.fs.exists(`${dir}/${m}`)) { rootCache.set(start, base(dir)); return base(dir) }
    }
    dir = dir.split('/').slice(0, -1).join('/')
  }
  rootCache.set(start, base(start))
  return base(start)
}

async function trackProject($: EngineInterface, tool: string, input: Record<string, unknown>): Promise<void> {
  if (!me) return
  const cmd = str(input, 'command')
  const target = cmd ? cdTarget(cmd) : ''
  const file = str(input, 'file_path') || str(input, 'notebook_path') || (tool === 'Read' ? '' : '')
  const path = target && isAbs(target) ? target : file && isAbs(file) ? file : ''
  if (!path || norm(path).includes('/.claude/')) return
  const project = await projectOf($, path, path === target)
  if (project && project !== me.project) await save($, { project })
}

async function makeTitle($: EngineInterface, prompt: string, answer: string): Promise<void> {
  const r = await $.model.complete({
    model: 'haiku', maxTokens: 30, timeoutMs: 20000,
    system: 'Tu nommes des conversations de travail. Réponds uniquement par le titre.',
    prompt: `Demande de la personne :\n${prompt.slice(0, 600)}\n\nDébut de la réponse de l'agent :\n${answer.slice(0, 600)}\n\nDonne un titre de 2 à 5 mots en français qui décrit la tâche (comme un nom de projet ou de mission), sans guillemets ni point final.`,
  })
  if (!r.isAnswered || !me) return
  const title = r.text.trim().replace(/^["'«\s]+|["'»\s.]+$/g, '').slice(0, 48)
  if (title) await save($, { title, isTitled: true })
}

async function checkStop($: EngineInterface): Promise<void> {
  if (!me) return
  await $.fs.write(`${root}/stop/${me.id}`, '') // an empty flag is ignored by the poll
  if (turnId) await $.turn.abort({ turnId })
  await save($, { status: 'idle', action: '' }, { text: 'Arrêté depuis le babyphone', kind: 'done' })
}

// A message typed in the widget: delivered to this session as a message from the plugin.
async function checkInbox($: EngineInterface): Promise<void> {
  if (!me) return
  const file = `${root}/inbox/${me.id}.json`
  let text = ''
  try { text = String(JSON.parse(await $.fs.read(file)).text ?? '') } catch { return }
  await $.fs.write(file, '{}') // consumed: an empty message is skipped next time
  if (!text.trim()) return
  await save($, {}, { text: `Ton message : ${text.slice(0, 80)}`, kind: 'msg' })
  await $.session.send({ to: { sessionId: me.id }, text: `Message de l'utilisateur envoyé depuis Agent Babyphone : ${text}` })
}

async function trackUsage($: EngineInterface): Promise<void> {
  if (!me) return
  const u = await $.session.usage()
  await save($, { usage: { percent: u.context.percent, usd: u.cost?.usd } })
}

// Installs/starts the widget in the background; never blocks the session.
async function launchWidget($: EngineInterface, show: boolean): Promise<boolean> {
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/scripts/launch.js`, ...(show ? ['--show'] : [])], { timeoutMs: 8000 })
    return r.exitCode === 0
  } catch { return false }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
    root = `${norm(home)}/.claude/agent-babyphone`
    const cwd = norm(await $.session.cwd())
    firstPrompt = ''
    me = {
      id: await $.session.id(), title: 'Nouvelle conversation', isTitled: false, project: base(cwd), cwd,
      status: 'idle', action: '', since: Date.now(), updated: Date.now(), agents: [], steps: [], tasks: [],
    }
    await save($, {}, { text: 'Session ouverte', kind: 'msg' })
    $.clock.every(1500, () => {
      void $.fs.read(`${root}/stop/${me?.id}`).then(t => (t === 'stop' ? checkStop($) : undefined), () => undefined)
      void checkInbox($).catch(() => undefined)
    })
    await $.command.register({ name: 'babyphone', description: 'Affiche le widget Agent Babyphone (le relance ou l’installe au besoin)' })
    if (!(await launchWidget($, false))) $.ui.log('Agent Babyphone : le widget a besoin de Node.js (https://nodejs.org) pour démarrer.')
    return ran
  })

  on('command.run', { command: 'babyphone' }, async $ => {
    const ok = await launchWidget($, true)
    return { text: ok
      ? 'Agent Babyphone démarre (au tout premier lancement, l’installation prend une minute). Raccourci : Ctrl+Alt+H.'
      : 'Impossible de lancer le widget : installe Node.js (https://nodejs.org) puis relance /babyphone.' }
  })

  on('turn.start', async ($, e, next) => {
    const ran = await next(e)
    if (!e.agentId) turnId = ran.turnId
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    if (me && !e.isMeta) {
      if (!firstPrompt) firstPrompt = e.text
      const cwd = norm(await $.session.cwd()) // the session may have moved since it started
      const moved = cwd !== me.cwd ? { cwd, project: base(cwd) } : {}
      const title = me.isTitled ? {} : { title: e.text.replace(/\s+/g, ' ').slice(0, 40) }
      await save($, { ...moved, ...title, status: 'working', action: 'Réfléchit…', since: Date.now(), tasks: [] },
        { text: `Message : ${e.text.slice(0, 80)}`, kind: 'msg' })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (!e.agentId) {
      turnId = undefined
      await save($, { status: 'idle', action: '', agents: [] }, { text: e.isAborted ? 'Interrompu' : 'Terminé', kind: 'done' })
      if (me && !me.isTitled && firstPrompt) void makeTitle($, firstPrompt, e.answer).catch(() => undefined)
      await trackUsage($).catch(() => undefined)
    }
    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    const agent = { id: e.tool_use_id, desc: e.description || e.subagentType, action: '' }
    await save($, { agents: [...(me?.agents ?? []), agent] })
    try { return await next(e) } finally {
      await save($, { agents: (me?.agents ?? []).filter(a => a.id !== agent.id) }, { text: `Sous-agent fini : ${agent.desc}`, kind: 'agent' })
    }
  })

  on('tool.call', async ($, e, next) => {
    const { tool, tool_use_id, agentId, ...input } = e as unknown as Record<string, unknown> & { tool: string; agentId?: string }
    const tasks = me ? nextTasks(tool, input, me.tasks) : undefined
    if (tasks) {
      await save($, { tasks })
      return next(e)
    }
    await trackProject($, tool, input).catch(() => undefined)
    const what = summarize(tool, input)
    const isCmd = what.kind === 'cmd'
    const command = stripCd(str(input, 'command'))
    if (agentId && me?.agents.length) {
      // shortcut: loop ids don't map to spawn ids, so a subagent's action goes on the newest agent row
      const last = me.agents[me.agents.length - 1]!
      await save($, { agents: me.agents.map(a => (a === last ? { ...a, action: what.text } : a)) }, what, last.desc)
    } else {
      await save($, { status: 'working', action: what.text, ...(isCmd ? { terminal: { command, output: '', running: true } } : {}) }, what)
    }
    const ran = await next(e)
    if (isCmd && !agentId && me) {
      const out = typeof ran.text === 'string' ? ran.text : ran.deny ?? ''
      await save($, { terminal: { command, output: out.slice(-600), running: false } })
    }
    if (!agentId && ++toolCount % 6 === 0) await trackUsage($).catch(() => undefined)
    return ran
  })

  on('session.end', async ($, e, next) => {
    await save($, { status: 'idle', action: '' }, { text: 'Session fermée', kind: 'done' })
    return next(e)
  })
}

// Agent Babyphone: a small always-on-top window that reads ~/.claude/agent-babyphone (written
// by the plugin's mod and hook script) and writes decisions, messages and stops back.
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, globalShortcut, Notification } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

const DIR = path.join(os.homedir(), '.claude', 'agent-babyphone')
const HIDE_MS = 12 * 60 * 60_000
const PENDING_MS = 130_000
const MARGIN = 16
const IDLE_OPACITY = 0.55
const PREFS = () => path.join(app.getPath('userData'), 'prefs.json')

app.setAppUserModelId('Agent Babyphone')
app.setName('Agent Babyphone')
if (!app.requestSingleInstanceLock()) app.exit(0)

let win, tray
let prefs = { locked: true, sound: true, autostart: true, autoOpacity: true, x: null, y: null }
let seenPending = new Set()
let opacity = 1, opacityTarget = 1, opacityTimer = null

function loadPrefs() { try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(PREFS(), 'utf8')) } } catch {} }
function savePrefs() { try { fs.writeFileSync(PREFS(), JSON.stringify(prefs)) } catch {} }

function readJsonDir(dir) {
  const full = path.join(DIR, dir)
  let names = []
  try { names = fs.readdirSync(full) } catch { return [] }
  const out = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try { out.push(JSON.parse(fs.readFileSync(path.join(full, n), 'utf8'))) } catch { /* mid-write */ }
  }
  return out
}

function readState() {
  const now = Date.now()
  const sessions = readJsonDir('sessions')
    .filter(s => s && s.id && now - s.updated < HIDE_MS)
    .sort((a, b) => b.updated - a.updated)
  const pending = readJsonDir('pending').filter(p => p && p.id && now - p.created < PENDING_MS)
  const screenH = win ? screen.getDisplayMatching(win.getBounds()).workArea.height : 900
  return { now, sessions, pending, prefs, screenH }
}

// Resize keeping the top-right corner where it is, so the widget grows down and left.
function resizeAnchored(w, h) {
  const b = win.getBounds()
  const right = b.x + b.width
  const area = screen.getDisplayMatching(b).workArea
  const x = Math.max(area.x, Math.min(right - w, area.x + area.width - w))
  const y = Math.max(area.y, Math.min(b.y, area.y + area.height - h))
  win.setBounds({ x, y, width: Math.round(w), height: Math.round(h) })
}

function toCorner() {
  const a = screen.getPrimaryDisplay().workArea, b = win.getBounds()
  win.setBounds({ ...b, x: a.x + a.width - b.width - MARGIN, y: a.y + MARGIN })
}

function toggle() { if (win.isVisible()) win.hide(); else { win.showInactive(); setOpacity(1) } }

// Fades between full and idle opacity instead of jumping.
function setOpacity(target) {
  opacityTarget = target
  if (opacityTimer) return
  opacityTimer = setInterval(() => {
    opacity += (opacityTarget - opacity) * 0.35
    if (Math.abs(opacityTarget - opacity) < 0.02) { opacity = opacityTarget; clearInterval(opacityTimer); opacityTimer = null }
    if (!win.isDestroyed()) win.setOpacity(opacity)
  }, 16)
}

function applyAutostart() {
  if (process.platform === 'linux') {
    const file = path.join(os.homedir(), '.config', 'autostart', 'agent-babyphone.desktop')
    try {
      if (prefs.autostart) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Agent Babyphone\nExec="${process.execPath}" "${__dirname}"\nX-GNOME-Autostart-enabled=true\n`)
      } else fs.rmSync(file, { force: true })
    } catch {}
    return
  }
  // Windows joins args into one command line: quote the folder for homes with spaces
  const dir = process.platform === 'win32' && __dirname.includes(' ') ? `"${__dirname}"` : __dirname
  app.setLoginItemSettings({ openAtLogin: !!prefs.autostart, path: process.execPath, args: [dir] })
}

function trayIcon() {
  // 16x16 lime robot drawn by hand, so the app ships no image file.
  const size = 16, buf = Buffer.alloc(size * size * 4)
  for (let y = 2; y < 14; y++) for (let x = 2; x < 14; x++) {
    const i = (y * size + x) * 4, eye = y >= 6 && y <= 8 && (x === 5 || x === 6 || x === 9 || x === 10)
    buf[i] = eye ? 20 : 26; buf[i + 1] = eye ? 20 : 255; buf[i + 2] = eye ? 20 : 198; buf[i + 3] = 255 // BGRA
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

function buildTray() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Afficher / masquer   Ctrl+Alt+H', click: toggle },
    { label: 'Remettre en haut à droite', click: toCorner },
    { type: 'separator' },
    { label: 'Lancer au démarrage', type: 'checkbox', checked: !!prefs.autostart, click: m => { prefs.autostart = m.checked; savePrefs(); applyAutostart() } },
    { label: 'Transparent quand rien ne se passe', type: 'checkbox', checked: !!prefs.autoOpacity, click: m => { prefs.autoOpacity = m.checked; savePrefs(); if (!m.checked) setOpacity(1) } },
    { type: 'separator' },
    { label: 'Quitter Agent Babyphone', click: () => app.quit() },
  ]))
}

function notifyNew(pending, sessions) {
  const ids = new Set(pending.map(p => p.id))
  const fresh = pending.filter(p => !seenPending.has(p.id))
  seenPending = ids
  if (!fresh.length || win.isVisible() || !Notification.isSupported()) return
  for (const p of fresh) {
    const s = sessions.find(x => x.id === p.sessionId)
    const who = s ? (s.project ? `${s.project} · ${s.title}` : s.title) : 'Un agent'
    const n = new Notification({
      title: `${who} ${p.type === 'question' ? 'te pose une question' : 'demande la permission'}`,
      body: p.type === 'question' ? (p.questions?.[0]?.question || '') : p.summary, silent: !prefs.sound,
    })
    n.on('click', () => { win.showInactive(); setOpacity(1) })
    n.show()
  }
}

app.on('second-instance', (_e, argv) => {
  if (argv.includes('--updated')) { app.relaunch({ args: [__dirname] }); app.exit(0); return }
  if (argv.includes('--show') && win) { win.showInactive(); setOpacity(1) }
})

app.whenReady().then(() => {
  loadPrefs()
  fs.mkdirSync(DIR, { recursive: true })
  const area = screen.getPrimaryDisplay().workArea
  const w = 260, h = 120
  const onScreen = prefs.x !== null && screen.getAllDisplays().some(d => {
    const a = d.workArea
    return prefs.x > a.x && prefs.x <= a.x + a.width && prefs.y >= a.y && prefs.y < a.y + a.height
  })
  win = new BrowserWindow({
    width: w, height: h,
    x: onScreen ? prefs.x - w : area.x + area.width - w - MARGIN, y: onScreen ? prefs.y : area.y + MARGIN,
    frame: false, transparent: true, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, hasShadow: false, maximizable: false, fullscreenable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true)
  win.loadFile(path.join(__dirname, 'index.html'))
  win.once('ready-to-show', () => win.showInactive())
  win.on('blur', () => win.webContents.send('collapse'))
  win.on('moved', () => { const b = win.getBounds(); prefs.x = b.x + b.width; prefs.y = b.y; savePrefs() })

  const push = () => {
    if (win.isDestroyed()) return
    const state = readState()
    notifyNew(state.pending, state.sessions)
    win.webContents.send('state', state)
    try { fs.writeFileSync(path.join(DIR, 'alive'), String(Date.now())) } catch {} // the hook waits for a click only while this is fresh
  }
  win.webContents.on('did-finish-load', push)
  setInterval(push, 1000)

  globalShortcut.register('CommandOrControl+Alt+H', toggle)
  globalShortcut.register('CommandOrControl+Alt+A', () => win.webContents.send('hotkey', 'allow'))
  globalShortcut.register('CommandOrControl+Alt+D', () => win.webContents.send('hotkey', 'deny'))

  tray = new Tray(trayIcon())
  tray.setToolTip('Agent Babyphone')
  tray.on('click', toggle)
  buildTray()
  applyAutostart()
})

app.on('will-quit', () => { globalShortcut.unregisterAll(); try { fs.rmSync(path.join(DIR, 'alive'), { force: true }) } catch {} })

const safeId = id => typeof id === 'string' && /^[\w.-]+$/.test(id)
const writeJson = (dir, id, data) => {
  fs.mkdirSync(path.join(DIR, dir), { recursive: true })
  fs.writeFileSync(path.join(DIR, dir, `${id}.json`), JSON.stringify(data))
}

ipcMain.on('resize', (_e, { w, h }) => resizeAnchored(w, h))
ipcMain.on('prefs', (_e, p) => { prefs = { ...prefs, locked: !!p.locked, sound: !!p.sound }; savePrefs() })
ipcMain.on('hide', () => win.hide())
ipcMain.on('open', () => shell.openExternal('claude://'))
ipcMain.on('activity', (_e, { active, hovered }) => setOpacity(!prefs.autoOpacity || active || hovered ? 1 : IDLE_OPACITY))
ipcMain.on('decide', (_e, { id, decision }) => { if (safeId(id) && decision && typeof decision === 'object') writeJson('decisions', id, decision) })
ipcMain.on('message', (_e, { id, text }) => {
  if (safeId(id) && typeof text === 'string' && text.trim()) writeJson('inbox', id, { text: text.slice(0, 4000), t: Date.now() })
})
ipcMain.on('stop', (_e, { id }) => {
  if (!safeId(id)) return
  fs.mkdirSync(path.join(DIR, 'stop'), { recursive: true })
  fs.writeFileSync(path.join(DIR, 'stop', id), 'stop')
})

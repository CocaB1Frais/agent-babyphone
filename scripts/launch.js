#!/usr/bin/env node
// Installs (first run or new version) and starts the Agent Babyphone widget.
// Called by the plugin at each session start and by /babyphone. It detaches at once so the
// session never waits; the widget itself refuses to run twice (single-instance lock).
//   node launch.js            -> detach, then install if needed and start the widget
//   node launch.js --show     -> same, and bring the widget to the front
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn, spawnSync } = require('child_process')

const PLUGIN_APP = path.join(__dirname, '..', 'app')
const HOME = path.join(os.homedir(), '.agent-babyphone')
const APP = path.join(HOME, 'app')
const LOG = path.join(HOME, 'launch.log')
const show = process.argv.includes('--show')

fs.mkdirSync(HOME, { recursive: true })
const log = msg => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`) } catch {} }

if (!process.argv.includes('--child')) {
  const child = spawn(process.execPath, [__filename, '--child', ...process.argv.slice(2)], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  process.exit(0)
}

function appVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version } catch { return null }
}

// Copy the app out of the plugin folder: the plugin cache changes path at every update,
// and node_modules (Electron, ~250 MB) must survive updates.
function syncApp() {
  fs.mkdirSync(APP, { recursive: true })
  const fresh = appVersion(PLUGIN_APP) !== appVersion(APP) || process.argv.includes('--force')
  for (const f of fs.readdirSync(PLUGIN_APP)) {
    const src = path.join(PLUGIN_APP, f), dst = path.join(APP, f)
    if (fs.statSync(src).isFile() && (fresh || !fs.existsSync(dst))) fs.copyFileSync(src, dst)
  }
  return fresh
}

function electronBinary() {
  try {
    const rel = fs.readFileSync(path.join(APP, 'node_modules', 'electron', 'path.txt'), 'utf8').trim()
    const bin = path.join(APP, 'node_modules', 'electron', 'dist', rel)
    return fs.existsSync(bin) ? bin : null
  } catch { return null }
}

function installElectron() {
  log('installing electron (first run, ~100 MB download)…')
  // one fixed string through the shell: npm is a .cmd script on Windows
  const r = spawnSync('npm install --no-audit --no-fund --omit=dev', { cwd: APP, stdio: 'ignore', shell: true, windowsHide: true })
  if (r.status !== 0) log(`npm install exited ${r.status}`)
  // Some npm setups skip install scripts: fetch the Electron binary ourselves then.
  if (!electronBinary() && fs.existsSync(path.join(APP, 'node_modules', 'electron', 'install.js'))) {
    spawnSync(process.execPath, ['install.js'], { cwd: path.join(APP, 'node_modules', 'electron'), stdio: 'ignore', windowsHide: true })
  }
  // Electron's own unzip silently extracts almost nothing on recent Node versions; the
  // download is in its cache by then, so unpack it with the system's tool.
  if (!electronBinary()) extractFromCache()
  return electronBinary()
}

const BINARY = { win32: 'electron.exe', darwin: 'Electron.app/Contents/MacOS/Electron', linux: 'electron' }

function findZip(dir, name, depth = 0) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const e of entries) if (e.isFile() && e.name === name) return path.join(dir, e.name)
  if (depth < 2) for (const e of entries) if (e.isDirectory()) { const hit = findZip(path.join(dir, e.name), name, depth + 1); if (hit) return hit }
  return null
}

function extractFromCache() {
  const pkg = path.join(APP, 'node_modules', 'electron')
  let version
  try { version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version } catch { return }
  const name = `electron-v${version}-${process.platform}-${process.arch}.zip`
  const caches = [process.env.electron_config_cache, process.env.ELECTRON_CACHE,
    process.platform === 'win32' && path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache'),
    process.platform === 'darwin' && path.join(os.homedir(), 'Library', 'Caches', 'electron'),
    path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'electron')].filter(Boolean)
  const zip = caches.map(c => findZip(c, name)).find(Boolean)
  if (!zip) { log(`no cached ${name} to unpack`); return }
  const dist = path.join(pkg, 'dist')
  fs.rmSync(dist, { recursive: true, force: true })
  fs.mkdirSync(dist, { recursive: true })
  const r = process.platform === 'linux'
    ? spawnSync('unzip', ['-q', '-o', zip, '-d', dist], { stdio: 'ignore' })
    // Windows' own bsdtar reads zip files; a Git-for-Windows tar earlier on PATH does not
    : spawnSync(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar',
      ['-xf', zip, '-C', dist], { stdio: 'ignore', windowsHide: true })
  if (r.status !== 0) { log(`unpacking ${name} failed (${r.status})`); return }
  fs.writeFileSync(path.join(pkg, 'path.txt'), BINARY[process.platform] || 'electron')
  log(`unpacked ${name} from the cache`)
}

function startWidget(bin, updated) {
  // --updated tells a widget that is already running to restart on the new code
  const args = [APP, '--from-claude', ...(show ? ['--show'] : []), ...(updated ? ['--updated'] : [])]
  if (process.platform === 'win32') {
    // A process started from a Claude Code session dies with it on Windows. Explorer starts
    // the widget outside the session's job, through a shortcut that carries the arguments.
    const lnk = path.join(HOME, 'Agent Babyphone.lnk')
    const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}');` +
      `$s.TargetPath='${bin.replace(/'/g, "''")}';$s.Arguments='${args.map(a => `"${a}"`).join(' ').replace(/'/g, "''")}';` +
      `$s.WorkingDirectory='${APP.replace(/'/g, "''")}';$s.Save()`
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true })
    spawn('explorer.exe', [lnk], { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn(bin, args, { detached: true, stdio: 'ignore' }).unref()
  }
}

try {
  const updated = syncApp()
  let bin = electronBinary()
  if (!bin) bin = installElectron()
  if (!bin) { log('electron is missing: widget not started. Is Node.js/npm installed and online?'); process.exit(1) }
  if (updated) log(`app updated to ${appVersion(APP)}`)
  startWidget(bin, updated)
} catch (err) {
  log(`launch failed: ${err && err.stack || err}`)
  process.exit(1)
}

const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('huddle', {
  onState: fn => ipcRenderer.on('state', (_e, s) => fn(s)),
  onCollapse: fn => ipcRenderer.on('collapse', () => fn()),
  onHotkey: fn => ipcRenderer.on('hotkey', (_e, k) => fn(k)),
  resize: (w, h) => ipcRenderer.send('resize', { w, h }),
  decide: (id, decision) => ipcRenderer.send('decide', { id, decision }),
  message: (id, text) => ipcRenderer.send('message', { id, text }),
  stop: id => ipcRenderer.send('stop', { id }),
  activity: (active, hovered) => ipcRenderer.send('activity', { active, hovered }),
  prefs: p => ipcRenderer.send('prefs', p),
  hide: () => ipcRenderer.send('hide'),
  open: () => ipcRenderer.send('open'),
})

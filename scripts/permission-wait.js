// Classic hook for PermissionRequest (any tool) and PreToolUse (AskUserQuestion):
// parks the ask in ~/.claude/agent-watch/pending where Agent Huddle shows it, then waits for
// a decision there. No answer in time, or "Répondre dans le chat" -> exit silently and the
// normal dialog in the chat takes over.
const fs = require('fs')
const path = require('path')
const os = require('os')

const root = path.join(os.homedir(), '.claude', 'agent-babyphone')
const WAIT_MS = 110_000 // under the hook timeout (120 s) in hooks/hooks.json
const ALIVE_MS = 6_000

// Wait for a click only while the widget runs (it touches `alive` every second);
// otherwise the chat shows its usual dialog right away.
function widgetAlive() {
  try { return Date.now() - Number(fs.readFileSync(path.join(root, 'alive'), 'utf8')) < ALIVE_MS } catch { return false }
}

function summarize(tool, input = {}) {
  if (tool === 'Bash' || tool === 'PowerShell') return `${tool}: ${String(input.command || '').slice(0, 160)}`
  const file = input.file_path || input.path || input.notebook_path
  if (file) return `${tool} ${file}`
  return tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' / ') : tool
}

function reply(event, d, input) {
  if (event === 'PreToolUse') {
    // AskUserQuestion: hand the answers in as if the dialog had collected them.
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input, answers: d.answers } } }
  }
  const decision = { behavior: d.behavior }
  if (d.behavior === 'deny') decision.message = 'Refusé depuis Agent Huddle.'
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }
}

let raw = ''
process.stdin.on('data', d => (raw += d)).on('end', () => {
  let e
  try { e = JSON.parse(raw) } catch { process.exit(0) }
  const event = e.hook_event_name
  const isQuestion = e.tool_name === 'AskUserQuestion'
  if (event === 'PreToolUse' && !isQuestion) process.exit(0)
  if (event === 'PermissionRequest' && isQuestion) process.exit(0) // handled at PreToolUse
  if (!widgetAlive()) process.exit(0)
  const input = e.tool_input || {}

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const pending = path.join(root, 'pending', `${id}.json`)
  const decisionFile = path.join(root, 'decisions', `${id}.json`)
  fs.mkdirSync(path.dirname(pending), { recursive: true })
  fs.mkdirSync(path.dirname(decisionFile), { recursive: true })
  fs.writeFileSync(pending, JSON.stringify({
    id, sessionId: e.session_id, tool: e.tool_name, created: Date.now(),
    type: isQuestion ? 'question' : 'permission',
    summary: isQuestion ? 'Question' : summarize(e.tool_name, input),
    ...(isQuestion ? { questions: input.questions || [] } : {}),
  }))
  const cleanup = () => { for (const f of [pending, decisionFile]) try { fs.unlinkSync(f) } catch {} }
  process.on('SIGTERM', () => { cleanup(); process.exit(0) })

  const start = Date.now()
  const timer = setInterval(() => {
    let d
    try { d = JSON.parse(fs.readFileSync(decisionFile, 'utf8')) } catch {}
    const done = d && (d.behavior === 'chat' || (isQuestion ? d.answers && typeof d.answers === 'object' : ['allow', 'deny'].includes(d.behavior)))
    if (done) {
      clearInterval(timer)
      cleanup()
      if (d.behavior !== 'chat') process.stdout.write(JSON.stringify(reply(event, d, input)))
      process.exit(0)
    }
    if (Date.now() - start > WAIT_MS || !widgetAlive()) { clearInterval(timer); cleanup(); process.exit(0) }
  }, 400)
})

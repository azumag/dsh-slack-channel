#!/usr/bin/env node
// Health check for a Linux install made by deploy/linux/setup.sh. Never opens the Slack socket
// (that would take events away from a bot still running elsewhere) and never prints a secret.
//
//   node check.mjs [--no-model|--all-routes] --dsh F --dsh-version V --repo D --slack-file F --keys-file F
//                  --slack-patch F --check-home D --workdir D --port N --running yes|no
//
// The model check runs one-shot `dsh --profile headless` turns in a separate DSH home (--check-home),
// one per provider of the Slack fallback chain by default, every route with --all-routes.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const opts = {}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--no-model' || args[i] === '--all-routes') opts[args[i].slice(2)] = true
  else if (args[i].startsWith('--')) opts[args[i].slice(2)] = args[++i]
}

let failures = 0
const ok = (label, detail = '') => console.log('✓ ' + label + (detail ? ' — ' + detail : ''))
const bad = (label, detail = '') => { failures++; console.log('✗ ' + label + (detail ? ' — ' + detail : '')) }
const note = (label, detail = '') => console.log('· ' + label + (detail ? ' — ' + detail : ''))
const proxied = ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'].some((name) => process.env[name])
const errText = (error) => {
  const cause = error?.cause
  // Node's fetch through a proxy that answers CONNECT with anything but 200 (407, 403, …) fails as
  // "Request was cancelled." with code 0.
  if (cause?.code === 0 && proxied) return (error?.message ?? String(error)) + ' (the proxy refused the tunnel — run setup.sh netcheck)'
  return (error?.message ?? String(error)) + (cause ? ' (' + (cause.code ?? cause.message) + ')' : '')
}
/** A tool's error line without URLs, user:pass@, host:port or token-looking strings. */
const scrub = (text) => String(text ?? '').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').replace(/\S+@\S+/g, '<…>')
  .replace(/\b[\w.-]+:\d{2,5}\b/g, '<host:port>').replace(/\b(xox[a-z]|xapp|gh[opsu]|nvapi|oc_sk|sk|gsk)[-_][A-Za-z0-9_-]{6,}/g, '$1-<hidden>').slice(0, 220)

async function slackCall(method, token) {
  const res = await fetch('https://slack.com/api/' + method, { method: 'POST', headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(20000) })
  return res.json()
}

/** The routes of the Slack channel: primary provider/model, then the fallbacks, from the overlay. */
function chainRoutes(file) {
  const text = readFileSync(file, 'utf8')
  const primary = { provider: text.match(/^ {8}provider:\s*(\S+)/m)?.[1], model: text.match(/^ {8}model:\s*(\S+)/m)?.[1] }
  const fallbacks = [...text.matchAll(/^\s*-\s*\{\s*provider:\s*([^,\s]+),\s*model:\s*([^,}\s]+)/gm)].map((m) => ({ provider: m[1], model: m[2] }))
  return [primary, ...fallbacks].filter((route) => route.provider && route.model)
}

/** One route per provider, the first "flash" model where there is one (NVIDIA's GLM-5.3 takes minutes). */
function onePerProvider(routes) {
  const picked = new Map()
  for (const route of routes) {
    const have = picked.get(route.provider)
    if (!have || (!/flash/.test(have.model) && /flash/.test(route.model))) picked.set(route.provider, route)
  }
  return [...picked.values()]
}

/** One headless turn on a route. Resolves { ok, secs, text, error }. */
function headlessTurn(route, timeoutMs) {
  const work = join(opts['check-home'], 'work')
  mkdirSync(work, { recursive: true })
  const overlay = join(opts['check-home'], 'route.patch.yml')
  writeFileSync(overlay, '- id: agent-default-model\n  config:\n    provider: ' + route.provider + '\n    model: ' + route.model + '\n')
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [opts.dsh, '--profile', 'headless', '--patch', overlay, '--json',
      'This is a connectivity check. Reply with exactly the word OK and nothing else. Do not use any tools.'],
    { cwd: work, env: { ...process.env, DSH_HOME: opts['check-home'] }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const secs = Math.round((Date.now() - started) / 1000)
      const events = out.split('\n').flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
      const final = events.findLast((e) => e.type === 'final')
      const text = String(final?.text ?? final?.answer ?? final?.content ?? '').trim()
      const errorLine = err.split('\n').filter((line) => /^dsh: /.test(line) && !/^dsh: reasoning/.test(line)).at(-1)
        ?? events.findLast((e) => e.type === 'error')?.message
      resolve({ ok: code === 0 && /\bOK\b/.test(text), secs, text, error: signal ? 'timed out after ' + secs + ' s' : errorLine, code })
    })
  })
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer().once('error', () => resolve(false)).once('listening', () => server.close(() => resolve(true)))
    server.listen(Number(port), '127.0.0.1')
  })
}

// ---------------------------------------------------------------- runtime

ok('node', process.version + ' (' + process.execPath + ')')
try {
  const version = execFileSync(process.execPath, [opts.dsh, '--version'], { encoding: 'utf8', timeout: 60000 }).trim()
  if (version === opts['dsh-version']) ok('dsh CLI', version)
  else bad('dsh CLI', version + ' ≠ ' + opts['dsh-version'])
} catch (error) {
  bad('dsh CLI', scrub(error.stderr || error.message))
}
const proxyNames = Object.keys(process.env).filter((name) => /^(https?|all|no)_proxy$/i.test(name))
if (proxyNames.length === 0) note('network', 'no proxy settings: direct connections')
else note('network', 'proxy settings: ' + proxyNames.join(', ') + (process.env.NODE_USE_ENV_PROXY === '1' ? ' (NODE_USE_ENV_PROXY=1)' : ' (Node ignores them without NODE_USE_ENV_PROXY=1)'))
note('DSH home', process.env.DSH_HOME + (process.env.DSH_AGENTS_HOME ? ', agents root ' + process.env.DSH_AGENTS_HOME : ''))
if (existsSync(opts.workdir)) ok('working directory', opts.workdir)
else bad('working directory', opts.workdir + ' does not exist')

// The bash tool runs every command confined (permissionPreset workspace-write). On Linux DSH takes
// bwrap, else Landlock, probed the way dsh-sandbox-local does, and refuses to run commands when
// neither works ("no sandbox backend is usable").
const bwrap = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', 'true'],
  { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] })
const bwrapWhy = bwrap.error?.code === 'ENOENT' ? 'bwrap not installed' : bwrap.status === 0 ? '' : 'bwrap: ' + scrub(bwrap.error?.message || bwrap.stderr?.trim().split('\n')[0] || 'exit ' + bwrap.status)
let landlock = 'unusable', landlockWhy = ''
try {
  const addon = createRequire(opts.dsh).resolve('@deepseek-ai/node-addon-system/landlock-run')
  const { launcherPath, probe } = await import(pathToFileURL(addon).href)
  landlock = probe(launcherPath(), { timeoutMs: 5000 })
  if (landlock === 'unusable') landlockWhy = scrub(spawnSync(launcherPath(), ['--probe'], { timeout: 5000, encoding: 'utf8' }).stderr?.trim().split('\n')[0] || 'probe failed')
} catch (error) {
  landlockWhy = scrub(error.message)
}
if (!bwrapWhy) ok('command sandbox', 'bwrap (the bash tool runs commands in it)')
else if (landlock !== 'unusable') ok('command sandbox', 'Landlock, ' + (landlock === 'partial' ? 'partially enforced (older kernel ABI)' : 'fully enforced') + ' (' + bwrapWhy + ')')
else bad('command sandbox', 'none usable, so the bash tool would refuse every command — ' + bwrapWhy + '; Landlock: ' + landlockWhy + '. Install bubblewrap (as root: apt-get install -y bubblewrap)')

// ---------------------------------------------------------------- configuration

try {
  await import(join(opts.repo, 'src', 'index.js'))
  ok('Slack channel plugin', 'loads on this Node (' + join(opts.repo, 'src', 'index.js') + ')')
} catch (error) {
  bad('Slack channel plugin', scrub(error.message))
}
try {
  // Composes profile + home patch + overlay without booting; the output (it may carry evaluated
  // values) is only searched, never printed.
  const dump = execFileSync(process.execPath, [opts.dsh, '--profile', 'slack', '--patch', opts['slack-patch'], '--dump-config'],
    { encoding: 'utf8', cwd: opts.workdir, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] })
  const has = (id) => dump.includes(id)
  if (has('slack-channel') && has('mcp-github')) ok('DSH config', 'profile "slack" composes with the Slack channel overlay')
  else bad('DSH config', 'composed config lacks ' + ['slack-channel', 'mcp-github'].filter((id) => !has(id)).join(', '))
} catch (error) {
  bad('DSH config', 'dsh --dump-config failed: ' + scrub(String(error.stderr || error.message).split('\n').find((line) => line.trim())))
}

let slack
try {
  slack = JSON.parse(readFileSync(opts['slack-file'], 'utf8'))
  if (slack.botToken?.startsWith('xoxb-') && slack.appToken?.startsWith('xapp-')) ok('Slack tokens', opts['slack-file'] + ' (values not shown)')
  else { bad('Slack tokens', opts['slack-file'] + ' lacks botToken (xoxb-) or appToken (xapp-)'); slack = undefined }
} catch {
  bad('Slack tokens', opts['slack-file'] + ' missing — run setup.sh keygen + import')
}
const keyNames = existsSync(opts['keys-file'])
  ? readFileSync(opts['keys-file'], 'utf8').split('\n').map((line) => line.match(/^([A-Z0-9_]+)=./)?.[1]).filter(Boolean)
  : []
const routes = chainRoutes(opts['slack-patch'])
const needKey = { nvidia: 'NVIDIA_API_KEY', 'opencode-go': 'OPENCODE_GO_API_KEY', 'deepseek-official': 'DEEPSEEK_API_KEY' }
const missing = [...new Set(routes.map((route) => needKey[route.provider]).filter((name) => name && !keyNames.includes(name)))]
if (missing.length === 0) ok('model API keys', keyNames.join(', ') + ' in ' + opts['keys-file'] + ' (values not shown)')
else bad('model API keys', 'missing ' + missing.join(', ') + ' in ' + opts['keys-file'])
note('model chain', routes.map((route) => route.provider + '/' + route.model).join(' → '))

// ---------------------------------------------------------------- Slack (Web API only)

if (slack) {
  try {
    const auth = await slackCall('auth.test', slack.botToken)
    if (auth.ok) ok('Slack bot token', 'bot ' + auth.user + ' (' + auth.user_id + ') in ' + auth.team)
    else bad('Slack bot token', 'auth.test: ' + auth.error)
    const conn = await slackCall('apps.connections.open', slack.appToken)
    if (conn.ok) ok('Slack app token', 'Socket Mode URL issued (not connected)')
    else bad('Slack app token', 'apps.connections.open: ' + conn.error)
    // The socket's host over plain HTTPS, by the same route the WebSocket takes (no session, no ticket).
    const socketHost = conn.ok ? new URL(conn.url).host : 'wss-primary.slack.com'
    try {
      const res = await fetch('https://' + socketHost + '/', { signal: AbortSignal.timeout(20000) })
      ok('Slack socket host', socketHost + ' reachable (HTTP ' + res.status + ')')
    } catch (error) {
      bad('Slack socket host', socketHost + ': ' + errText(error))
    }
  } catch (error) {
    bad('Slack Web API', errText(error))
  }
}

// ---------------------------------------------------------------- GitHub

try {
  const login = execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim()
  note('GitHub CLI', 'logged in as ' + login + ' — the bot acts on GitHub as this account')
  try {
    execFileSync('gh', ['auth', 'token'], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 20000 })
    ok('GitHub MCP token', '`gh auth token` works (value not shown)')
  } catch {
    bad('GitHub MCP token', '`gh auth token` failed — the mcp__github__ tools will not work')
  }
} catch (error) {
  if (error.code === 'ENOENT') bad('GitHub CLI', 'gh not found on PATH — the bot cannot use GitHub')
  else bad('GitHub CLI', 'gh api user failed (exit ' + (error.status ?? error.code) + ': ' + scrub(String(error.stderr).split('\n').find((line) => line.trim())) + ') — not logged in, or no network through the proxy')
}
for (const [key, envName] of [['user.name', 'GIT_AUTHOR_NAME'], ['user.email', 'GIT_AUTHOR_EMAIL']]) {
  if (process.env[envName]) { note('git ' + key, process.env[envName] + ' (bot env)'); continue }
  try {
    execFileSync('git', ['config', '--global', key], { stdio: 'ignore' })
    note('git ' + key, 'set in ~/.gitconfig')
  } catch {
    note('git ' + key, 'not set — commits by the bot will fail (setup.sh git-identity)')
  }
}

// ---------------------------------------------------------------- service

if (opts.running === 'yes') note('service', 'running')
else if (await portFree(opts.port)) ok('service', 'not running; 127.0.0.1:' + opts.port + ' is free for DSH\'s local web server')
else bad('service', 'not running, but 127.0.0.1:' + opts.port + ' is taken — set DSK_PORT and run setup.sh install again')

// ---------------------------------------------------------------- models

if (!opts['no-model']) {
  const tested = opts['all-routes'] ? routes : onePerProvider(routes)
  for (const route of tested) {
    const label = 'model ' + route.provider + '/' + route.model
    const result = await headlessTurn(route, /glm-5\.3$/.test(route.model) ? 600000 : 240000)
    if (result.ok) ok(label, 'answered OK in ' + result.secs + ' s (dsh headless)')
    else bad(label, (result.error ? scrub(result.error) : 'exit ' + result.code + ', reply "' + scrub(result.text).slice(0, 60) + '"') + ' after ' + result.secs + ' s')
  }
  if (!opts['all-routes']) note('model check', 'one route per provider; setup.sh check --all-routes tries every route (GLM-5.3 takes minutes)')
  rmSync(join(opts['check-home'], 'route.patch.yml'), { force: true })
}

console.log(failures === 0 ? '\nall checks passed' : '\n' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)

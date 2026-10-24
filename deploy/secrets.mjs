#!/usr/bin/env node
// Hand the DSH Slack bot's secrets to another machine through a chat (Slack) without
// ever posting them in plain text: X25519 + HKDF-SHA256 + AES-256-GCM.
//
//   on the target:  node deploy/secrets.mjs keygen <keyFile>
//                   → prints a one-line public key (dsk-pub1:…); the private key stays in <keyFile> (600)
//   on the source:  node deploy/secrets.mjs seal <dsk-pub1:…> [--dsh-home ~/.dsh] [--keys NAME,NAME…]
//                   → reads the Slack tokens from the slack-channel row of <dsh-home>/cordis.patch.yml and the
//                     API keys from the refs of <dsh-home>/.credentials.yaml (default keys: the ones the Linux
//                     kit's templates use), prints a one-line sealed blob (dsk-sealed1:…)
//   on the target:  node deploy/secrets.mjs open <keyFile> <dsk-sealed1:…> --slack-out FILE --env-out FILE
//                   → writes the Slack tokens as JSON to --slack-out and sets NAME="key" lines in --env-out
//                     (DSH reads API keys from $DSH_HOME/.env), both 600, then deletes <keyFile>
//                     (one key per handoff)
//
// No secret value is ever written to stdout/stderr; only names and counts.

import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const PUB_PREFIX = 'dsk-pub1:'
const SEALED_PREFIX = 'dsk-sealed1:'
const INFO = Buffer.from('dsh-slack-channel secrets handoff v1')
// What deploy/linux/templates use: NVIDIA for every model of the Slack chain, DeepSeek's key for
// web search/fetch only (the owner's choice for the Linux bot, 2026-10-25).
const DEFAULT_KEYS = ['NVIDIA_API_KEY', 'DEEPSEEK_API_KEY']

function die(message, code = 1) {
  process.stderr.write('error: ' + message + '\n')
  process.exit(code)
}

function expand(path) {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/** Write a file only the owner can read, atomically. */
function writePrivate(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = path + '.tmp-' + process.pid
  writeFileSync(tmp, text, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

function publicKeyFromX(x) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' })
}

function deriveKey(shared, ephX, recipientX) {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.from(ephX + '.' + recipientX), INFO, 32))
}

function parseArgs(argv) {
  const positional = []
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const name = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      const value = argv[++i]
      if (value === undefined) die('missing value for ' + arg, 2)
      options[name] = value
    } else positional.push(arg)
  }
  return { positional, options }
}

/** A YAML scalar as written by DSH or by hand: plain, 'single' or "double" quoted. */
function unquote(raw) {
  const value = raw.trim()
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value)
  return value.replace(/\s+#.*$/, '')
}

/** botToken/appToken of the one slack-channel row in a DSH patch file. */
function readSlackTokens(patchFile) {
  const text = readFileSync(patchFile, 'utf8')
  const pick = (name, prefix) => {
    const found = [...text.matchAll(new RegExp('^\\s*' + name + ':\\s*(.+)$', 'gm'))].map((m) => unquote(m[1])).filter((v) => v.startsWith(prefix))
    if (found.length !== 1) die(patchFile + ': expected exactly one ' + name + ' (' + prefix + '…), found ' + found.length)
    return found[0]
  }
  return { botToken: pick('botToken', 'xoxb-'), appToken: pick('appToken', 'xapp-') }
}

/** NAME → value from the `refs:` map of DSH's credential store file. */
function readCredentialRefs(file) {
  const refs = {}
  let inRefs = false
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\S/.test(line)) { inRefs = /^refs:\s*$/.test(line); continue }
    const m = inRefs && line.match(/^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/)
    if (m) refs[m[1]] = unquote(m[2])
  }
  return refs
}

/** Set NAME="value" lines in an env file, replacing earlier lines for the same names. */
function setEnvLines(path, entries) {
  const names = Object.keys(entries)
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((line) => line && !names.some((name) => line.startsWith(name + '='))) : []
  for (const name of names) lines.push(name + '="' + entries[name] + '"')
  writePrivate(path, lines.join('\n') + '\n')
}

function keygen(keyFile) {
  if (!keyFile) die('usage: secrets.mjs keygen <keyFile>', 2)
  keyFile = expand(keyFile)
  const { privateKey } = generateKeyPairSync('x25519')
  const jwk = privateKey.export({ format: 'jwk' })
  writePrivate(keyFile, JSON.stringify(jwk) + '\n')
  process.stdout.write(PUB_PREFIX + jwk.x + '\n')
}

function seal(pub, options) {
  if (!pub?.startsWith(PUB_PREFIX)) die('usage: secrets.mjs seal <' + PUB_PREFIX + '…> [--dsh-home ~/.dsh] [--keys NAME,NAME…]', 2)
  const recipientX = pub.slice(PUB_PREFIX.length).trim()
  const dshHome = expand(options.dshHome ?? '~/.dsh')
  const payload = { v: 1, slack: readSlackTokens(join(dshHome, 'cordis.patch.yml')), keys: {} }
  const refs = readCredentialRefs(join(dshHome, '.credentials.yaml'))
  const names = options.keys ? options.keys.split(',').map((name) => name.trim()).filter(Boolean) : DEFAULT_KEYS
  for (const name of names) {
    const value = refs[name]
    if (!value) die(name + ' is not among the refs of ' + join(dshHome, '.credentials.yaml'))
    // It goes into an env file read by DSH and by the shell: keep it to characters neither interprets.
    if (/["'\\$`\s]/.test(value)) die(name + ' has quotes, backslashes, $, backticks or spaces')
    payload.keys[name] = value
  }

  const recipient = publicKeyFromX(recipientX)
  const { privateKey: ephPrivate, publicKey: ephPublic } = generateKeyPairSync('x25519')
  const ephX = ephPublic.export({ format: 'jwk' }).x
  const key = deriveKey(diffieHellman({ privateKey: ephPrivate, publicKey: recipient }), ephX, recipientX)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  const blob = Buffer.concat([Buffer.from(ephX, 'base64url'), iv, cipher.getAuthTag(), body]).toString('base64url')
  process.stdout.write(SEALED_PREFIX + blob + '\n')
  process.stderr.write('sealed: slack tokens + ' + names.join(', ') + '\n')
}

function open(keyFile, sealed, options) {
  if (!keyFile || !sealed?.startsWith(SEALED_PREFIX)) die('usage: secrets.mjs open <keyFile> <' + SEALED_PREFIX + '…> --slack-out FILE --env-out FILE', 2)
  if (!options.slackOut || !options.envOut) die('give --slack-out <file> and --env-out <file>', 2)
  keyFile = expand(keyFile)
  if (!existsSync(keyFile)) die(keyFile + ' not found — run keygen on this machine first (the key is deleted after one successful open)')
  const jwk = JSON.parse(readFileSync(keyFile, 'utf8'))
  const raw = Buffer.from(sealed.slice(SEALED_PREFIX.length).replace(/\s+/g, ''), 'base64url')
  if (raw.length < 32 + 12 + 16 + 1) die('sealed blob is truncated')
  const ephX = raw.subarray(0, 32).toString('base64url')
  const iv = raw.subarray(32, 44)
  const tag = raw.subarray(44, 60)
  const body = raw.subarray(60)
  const key = deriveKey(diffieHellman({ privateKey: createPrivateKey({ key: jwk, format: 'jwk' }), publicKey: publicKeyFromX(ephX) }), ephX, jwk.x)
  let payload
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    payload = JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'))
  } catch {
    die('cannot open the blob: it was sealed for a different key, or was changed/truncated when copied')
  }

  writePrivate(expand(options.slackOut), JSON.stringify(payload.slack, null, 2) + '\n')
  setEnvLines(expand(options.envOut), payload.keys)
  rmSync(keyFile, { force: true })
  process.stdout.write('slack tokens → ' + options.slackOut + '\n' + Object.keys(payload.keys).join(', ') + ' → ' + options.envOut + '\nhandoff key deleted\n')
}

const [command, ...rest] = process.argv.slice(2)
const { positional, options } = parseArgs(rest)
if (command === 'keygen') keygen(positional[0])
else if (command === 'seal') seal(positional[0], options)
else if (command === 'open') open(positional[0], positional[1], options)
else die('usage: secrets.mjs keygen|seal|open … (see the header of this file)', 2)

// Best-effort masking of secret-looking values in text the channel shows a
// human: the command an approval prompt asks about (and the reason beside
// it). A command is model-written and lands in a shared Slack thread, so a
// key it carries inline (`GH_TOKEN=… gh api …`, `curl -H "Authorization: …"`)
// must not be repeated there. Two kinds of hit:
// - values whose shape is a known secret (Slack, GitHub, NVIDIA, sk- keys…),
//   kept with their prefix so the reader still sees which kind it was;
// - values given to a secret-named variable, key, flag or header.
// A reference stays readable (`TOKEN=$(cat ~/.token)`, `--token "$GH_TOKEN"`):
// it names where the secret comes from, which is what an approver needs.

export const REDACTED = '<redacted>'

/** Known secret shapes: group 1 is the prefix that stays visible. */
const SHAPES = [
  /\b(xox[a-z]-)[A-Za-z0-9-]{8,}/g,
  /\b(xapp-)\d+-[A-Za-z0-9-]{8,}/g,
  /\b(gh[pousr]_)[A-Za-z0-9]{20,}/g,
  /\b(github_pat_)[A-Za-z0-9_]{20,}/g,
  /\b(glpat-)[A-Za-z0-9_-]{20,}/g,
  /\b(nvapi-)[A-Za-z0-9_-]{16,}/g,
  // OpenAI, DeepSeek, Anthropic (sk-ant-…), OpenRouter (sk-or-…)
  /\b(sk-)[A-Za-z0-9_-]{16,}/g,
  /\b(hf_)[A-Za-z0-9]{30,}/g,
  /\b(gsk_)[A-Za-z0-9]{20,}/g,
  /\b(AIza)[0-9A-Za-z_-]{30,}/g,
  /\b((?:AKIA|ASIA))[0-9A-Z]{16}\b/g,
  // JWT (header.payload.signature)
  /\b(eyJ)[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
]

/** A name that says its value is a secret (variables, JSON keys, flags). */
const SECRET_NAME = '[A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_-]*'

/** One shell word or quoted string. */
const VALUE = '("[^"\\n]*"|\'[^\'\\n]*\'|[^\\s"\',;&|)}]+)'

/** NAME=value, "name": "value", name: value. */
const ASSIGNMENT = new RegExp('\\b(' + SECRET_NAME + ')(["\']?\\s*[=:]\\s*)' + VALUE, 'gi')

/** --token value, -password value (the = spelling is an ASSIGNMENT). */
const FLAG = new RegExp('(^|\\s)(--?' + SECRET_NAME + ')(\\s+)' + VALUE, 'gi')

/** Authorization: Bearer value (also Proxy-Authorization, Basic, token). */
const AUTH_HEADER = /\b((?:Proxy-)?Authorization\s*:\s*)((?:Bearer|Basic|Token|Digest)\s+)?([^\s"'\\]+)/gi

/** curl -u user:password / --user user:password. */
const USER_FLAG = /((?:^|\s)(?:-u|--user)(?:\s+|=)["']?)([^\s:"']+):([^\s"']+)/g

/** scheme://user:password@host */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+):([^\s@/"']+)@/gi

/** A PEM private key, body and all. */
const PRIVATE_KEY = /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g

/** Whether a named secret's value is worth masking (not a reference, not a flag, not a plain number). */
function secretValue(raw) {
  const value = raw.replace(/^["']|["']$/g, '')
  if (value.length < 4) return false
  if (/^[$<-]/.test(value)) return false
  if (/^\d+$/.test(value)) return false
  if (/^(?:true|false|null|none|undefined)$/i.test(value)) return false
  return true
}

/** Keep a quoted value's quotes around the mask, so the command still reads as shell. */
function mask(raw) {
  const quote = /^["']/.test(raw) ? raw[0] : ''
  return quote + REDACTED + (quote !== '' && raw.endsWith(quote) && raw.length > 1 ? quote : '')
}

/**
 * Mask what looks like a secret in `text`; unchanged text is returned as is.
 * Best effort by design — it keeps the shown command readable and cannot
 * promise to catch a secret with no telling shape or name.
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text.replace(PRIVATE_KEY, '$1\n' + REDACTED + '\n$2')
  for (const shape of SHAPES) out = out.replace(shape, '$1' + REDACTED)
  out = out.replace(URL_CREDENTIALS, '$1:' + REDACTED + '@')
  out = out.replace(AUTH_HEADER, (whole, head, scheme = '', value) => (
    value.includes(REDACTED) || value.startsWith('$') ? whole : head + scheme + REDACTED
  ))
  out = out.replace(USER_FLAG, (whole, head, user, password) => (
    password.includes(REDACTED) || password.startsWith('$') ? whole : head + user + ':' + REDACTED
  ))
  out = out.replace(ASSIGNMENT, (whole, name, sep, value) => (
    /(?:file|path|dir)$/i.test(name) || !secretValue(value) || value.includes(REDACTED) ? whole : name + sep + mask(value)
  ))
  out = out.replace(FLAG, (whole, lead, flag, gap, value) => (
    /(?:file|path|dir)$/i.test(flag) || !secretValue(value) || value.includes(REDACTED) ? whole : lead + flag + gap + mask(value)
  ))
  return out
}

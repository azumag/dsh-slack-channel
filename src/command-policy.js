// What happens to a command an approval asks about, when the channel answers
// approvals by rule (autoAllowCommands):
//   deny  — rejected at once, no prompt;
//   ask   — the Slack prompt as before, showing the command and the rule;
//   allow — allowed once at once, no prompt.
//
// Patterns are regular expressions tested against the whole command text.
// This is a guard rail for an agent that means well, not a sandbox: `bash -c`,
// scripts and aliases can hide a command from any text match. The lists a
// config gives are added to these built-in ones.

/** Never from a channel turn: taking the machine down. */
export const DEFAULT_DENY = [
  '\\bsystemctl\\s+(stop|disable|mask|kill|restart|poweroff|reboot|halt)\\b',
  '\\b(shutdown|reboot|poweroff|halt)\\b',
  '\\bmkfs(\\.\\w+)?\\b',
]

/** Hard to undo or visible to others: a person decides, seeing the command. */
export const DEFAULT_ASK = [
  // History rewrites and pushes straight to a default branch.
  '\\bgit\\s+push\\b[^\\n]*(\\s--force\\b|\\s-f\\b|\\s--force-with-lease\\b|\\s--mirror\\b|\\s--delete\\b|\\s:\\S)',
  '\\bgit\\s+push\\b[^\\n]*\\s(origin\\s+)?(HEAD:)?(main|master)\\b',
  // Merging, closing or deleting on GitHub.
  '\\bgh\\s+pr\\s+(merge|close)\\b',
  '\\bgh\\s+(repo|release)\\s+delete\\b',
  '\\bgh\\s+api\\b[^\\n]*(-X|--method)\\s*DELETE\\b',
  '\\bsudo\\b',
]

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A recursive rm that names a path outside the workspace and /tmp: an absolute
 * path, the home directory, a parent directory or a bare glob. Relative paths
 * (node_modules, ./build) and paths under the workspace run without asking.
 * @param cwd - the workspace root, absolute (or undefined: only /tmp is spared).
 * @param home - the home directory, for ~/ and $HOME/ spellings of the workspace.
 */
export function recursiveRmRule(cwd, home) {
  const absolute = ['tmp/']
  const tilde = []
  if (typeof cwd === 'string' && cwd.startsWith('/') && cwd.length > 1) {
    const root = cwd.replace(/\/+$/, '')
    absolute.push(escapeRegex(root.slice(1)) + '/')
    if (typeof home === 'string' && home.length > 1 && root.startsWith(home.replace(/\/+$/, '') + '/')) {
      tilde.push(escapeRegex(root.slice(home.replace(/\/+$/, '').length + 1)) + '/')
    }
  }
  const notUnder = (list) => (list.length === 0 ? '' : '(?!' + list.join('|') + ')')
  return '\\brm\\b(?=[^\\n;&|]*\\s-[a-zA-Z]*[rR])[^\\n;&|]*\\s["\']?(' +
    '/' + notUnder(absolute) +
    '|~' + notUnder(tilde.map((rel) => '/' + rel)) +
    '|(\\$\\{HOME\\}|\\$HOME\\b)' + notUnder(tilde.map((rel) => '/' + rel)) +
    '|\\.\\.(/|\\s|$|["\'])|\\*)'
}

function compile(list) {
  const out = []
  for (const source of list ?? []) {
    try {
      out.push(new RegExp(source, 'i'))
    } catch {
      /* the schema reports a bad pattern; it is skipped here */
    }
  }
  return out
}

/** Invalid patterns in a config list, as "pattern: error" lines. */
export function invalidPatterns(list) {
  const bad = []
  for (const source of list ?? []) {
    try {
      new RegExp(source, 'i')
    } catch (error) {
      bad.push(source + ': ' + error.message)
    }
  }
  return bad
}

/**
 * @param options.cwd / options.home - for the recursive-rm rule.
 * @param options.denyCommands / options.askCommands - patterns added to the built-in lists.
 * @returns (command) => { decision: 'deny' | 'ask' | 'allow', pattern?: string }
 */
export function createCommandPolicy({ cwd, home, denyCommands = [], askCommands = [] } = {}) {
  const deny = compile([...DEFAULT_DENY, ...denyCommands])
  const ask = compile([...DEFAULT_ASK, recursiveRmRule(cwd, home), ...askCommands])
  return function decide(command) {
    const text = String(command ?? '')
    for (const re of deny) if (re.test(text)) return { decision: 'deny', pattern: re.source }
    for (const re of ask) if (re.test(text)) return { decision: 'ask', pattern: re.source }
    return { decision: 'allow' }
  }
}

// Best-effort markdown → Slack mrkdwn conversion for agent replies.
//
// Slack's mrkdwn already uses triple-backtick fences and inline backticks,
// so code blocks pass through verbatim. The dangerous part is Slack's
// angle-bracket link syntax: raw "<https://…>" or "<@U123>" in model output
// would render as links/mentions — so <, >, and & are escaped OUTSIDE code
// spans, and every opened fence is closed per chunk.

/** Escape the characters Slack mrkdwn reserves outside code spans. */
export function escapeMrkdwn(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

const FENCE = '```'

/**
 * Convert one reply chunk to Slack mrkdwn.
 * - Fenced blocks pass through (Slack renders them natively); an unbalanced
 *   final fence is closed so the chunk renders standalone.
 * - Inline backtick spans pass through; unbalanced inline backticks are
 *   escaped wholesale.
 * - Everything else gets & < > escaped so no accidental links or mentions,
 *   EXCEPT the user ids in options.mentionUserIds: those are restored as real
 *   <@U123> mentions. The allowlist is what lets an agent address a named
 *   teammate without letting it ping anyone it can name; with no allowlist
 *   (the default) every mention the model writes stays escaped text.
 */
export function toSlackMrkdwn(text, options) {
  const lines = text.split('\n')
  const out = []
  let inFence = false
  for (const line of lines) {
    if (line.trimStart().startsWith(FENCE)) {
      out.push(FENCE)
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    out.push(escapeInline(line))
  }
  if (inFence) out.push(FENCE)
  return allowMentions(out.join('\n'), options?.mentionUserIds)
}

/**
 * Restore the allowed <@U123> / <@U123|name> spellings that escaping turned
 * into text. Everything else stays escaped, so an id outside the allowlist —
 * or any other angle-bracket syntax — still cannot reach Slack as a link or a
 * mention. Ids are matched literally (regex metacharacters are quoted).
 */
function allowMentions(text, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return text
  let out = text
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) continue
    const quoted = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp('&lt;@' + quoted + '(\\|[^&<>]*)?&gt;', 'g')
    out = out.replace(pattern, (_, label) => '<@' + id + (label === undefined ? '' : label) + '>')
  }
  return out
}

/** Escape a line outside fences, passing inline code spans through. */
function escapeInline(line) {
  if (!line.includes('`')) return escapeMrkdwn(line)
  const parts = line.split('`')
  // Even segment count means unbalanced backticks: escape the line whole.
  if (parts.length % 2 === 0) return escapeMrkdwn(line)
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    out += i % 2 === 1 ? '`' + parts[i] + '`' : escapeMrkdwn(parts[i])
  }
  return out
}

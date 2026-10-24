// A Cordis plugin for the Linux service: prints DSH's log records (error, info, warn) to stdout, which
// the service appends to ~/.dsh-slack/logs/dsh.log. The CLI's web profile keeps them only in memory for
// its GUI, so without this a failing Slack channel or model route would leave no trace on a headless
// machine. Anything that looks like a token or API key is masked.
//
// It also logs each Socket Mode connection Slack accepts ("socket connected (num_connections=N)", from
// Slack's hello frame): the channel logs only failed and closed sockets, and `setup.sh start-saved`
// needs to tell a connected bot from one that keeps failing. Load it before the channel.

import { formatWithOptions } from 'node:util'

export const name = 'dsh-slack-log-stdout'

const SECRET = /\b(xox[a-z]|xapp|gh[opsu]|nvapi|oc_sk|sk|gsk)([-_])[A-Za-z0-9_-]{6,}/g
const mask = (text) => text.replace(SECRET, '$1$2<hidden>').replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1<hidden>')

export function apply(ctx, config = {}) {
  // Cordis levels: error 0, info 1, warn 2, debug 3; a record is exported when its level ≤ this.
  const level = config.level ?? 2
  const print = ({ ts, type, name, args }) => {
    const text = formatWithOptions({ colors: false, depth: 4, breakLength: Infinity }, ...args)
    process.stdout.write(new Date(ts).toISOString() + ' ' + type.toUpperCase() + ' [' + name + '] ' + mask(text).replace(/\n/g, '\n    ') + '\n')
  }
  // What was logged before this plugin loaded (the logger keeps the last 1000 records).
  for (const message of ctx.logger.buffer ?? []) if (message.level <= level) print(message)
  ctx.logger.exporter({ levels: { default: level }, export: print })
  watchSlackSockets(ctx, ctx.logger('slack-socket'))
}

/** Wrap globalThis.WebSocket (what the channel's socket loop constructs) to log Slack's hello frames. */
function watchSlackSockets(ctx, logger) {
  const Native = globalThis.WebSocket
  if (typeof Native !== 'function') return
  class SlackWatched extends Native {
    constructor(url, ...rest) {
      super(url, ...rest)
      if (!/^wss:\/\/[^/]*\bslack\.com\//.test(String(url))) return
      const onMessage = (event) => {
        let frame
        try { frame = JSON.parse(String(event.data)) } catch { return }
        if (frame?.type !== 'hello') return
        this.removeEventListener('message', onMessage)
        logger.info('socket connected (num_connections=' + frame.num_connections + ')')
      }
      this.addEventListener('message', onMessage)
    }
  }
  globalThis.WebSocket = SlackWatched
  ctx.effect(() => () => { if (globalThis.WebSocket === SlackWatched) globalThis.WebSocket = Native }, 'slack-socket-watch')
}

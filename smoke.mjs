// LIVE smoke test runner: real Slack, stub echo agent.
// Reads .env.local, mounts the plugin via apply(), logs every outbound post.
import fs from 'node:fs'
import { apply, Config } from './src/index.js'

const env = Object.fromEntries(
  fs.readFileSync(new URL('./.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)

// Capture outbound postMessage targets: reveals the channel id.
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const res = await originalFetch(url, init)
  if (String(url).includes('/chat.postMessage')) {
    const body = JSON.parse(init?.body ?? '{}')
    console.log('[postMessage] channel=' + body.channel + ' text=' + JSON.stringify(body.text) + ' thread=' + (body.thread_ts ?? '-'))
  }
  return res
}

const listeners = {}
const ctx = {
  logger: () => ({
    info: () => {},
    warn: (...a) => console.log('[warn]', ...a),
    error: (...a) => console.log('[error]', ...a),
  }),
  on(event, fn) { ;(listeners[event] ??= []).push(fn); return () => {} },
  effect() {},
  // Optional services the plugin consults (agent-default-model for an unset
  // route, permission/agent presets): undefined here, so the composition
  // defaults stand.
  get: () => undefined,
  agents: {
    async create(options) {
      const agent = {
        id: options.sessionId,
        session: { id: options.sessionId, header: { id: options.sessionId } },
        followups: [],
        followup(message) {
          this.followups.push(message)
          const text = message.content.find((b) => b.type === 'text')?.text ?? ''
          setTimeout(() => {
            const turn = 1
            agent.onEvent?.({ type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: 'echo: ' + text }] } } })
            agent.onEvent?.({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
          }, 400)
        },
        cancel() {},
        onEvent: undefined,
      }
      agent.onEvent = (event) => { for (const fn of listeners['session/event'] ?? []) fn(agent.session, event) }
      console.log('[agent created]', options.sessionId)
      return { agent, dispose: async () => {} }
    },
    async resume() { throw new Error('no persistence in smoke test') },
  },
}

const raw = {
  botToken: env.SLACK_BOT_TOKEN,
  appToken: env.SLACK_APP_TOKEN,
  allowedChannelIds: (env.ALLOWED_CHANNEL_IDS ?? '').split(',').filter((s) => s.length > 0),
  allowAllChannels: false,
  threadReplies: true,
  ackReaction: 'hourglass',
}
const validated = Config['~standard'].validate(raw)
if (validated.issues !== undefined) {
  console.log('CONFIG ISSUES', JSON.stringify(validated.issues))
  process.exit(1)
}
apply(ctx, validated.value)
console.log('[smoke] plugin live — post a message in the channel with deepseeker; reply will be "echo: <your text>"')

// Route the plugin's outbound postMessage channel ids into the log for discovery.
process.on('SIGINT', () => process.exit(0))
setInterval(() => {}, 1 << 30)

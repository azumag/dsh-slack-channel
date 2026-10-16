// Slack mrkdwn formatting tests.

import { test, assert, equal } from './_util.mjs'
import { escapeMrkdwn, toSlackMrkdwn } from '../src/format.js'

const NL = String.fromCharCode(10)
const FENCE = '```'

test('escapeMrkdwn escapes the reserved trio', () => {
  equal(escapeMrkdwn('a < b & c > d'), 'a &lt; b &amp; c &gt; d')
})

test('angle-bracket links are neutralized outside code', () => {
  equal(escapeMrkdwn('see <https://evil.example|click>'), 'see &lt;https://evil.example|click&gt;')
})

test('fenced blocks pass through verbatim', () => {
  const text = ['before', FENCE + 'js', 'const x = 1 < 2', FENCE, 'after'].join(NL)
  const out = toSlackMrkdwn(text)
  assert(out.includes('const x = 1 < 2'), 'code content untouched inside fences')
  equal((out.match(new RegExp(FENCE.replace(/```/, '\\\$&'), 'g')) ?? []).length, 2, 'two fences kept')
})

test('inline backtick spans pass through', () => {
  equal(toSlackMrkdwn('run `npm i` now'), 'run `npm i` now')
})

test('unbalanced inline backticks escape the whole line', () => {
  equal(toSlackMrkdwn('odd ` <usage>'), 'odd ` &lt;usage&gt;')
})

test('unbalanced fence still closes', () => {
  const out = toSlackMrkdwn(FENCE + NL + 'const x = 1')
  assert(out.trimEnd().endsWith(FENCE), 'closes fence at end')
})

test('plain lines are escaped', () => {
  equal(toSlackMrkdwn('a<b> & c'), 'a&lt;b&gt; &amp; c')
})

test('no allowlist keeps every agent-typed mention as text', () => {
  equal(toSlackMrkdwn('<@U123ABC> hi'), '&lt;@U123ABC&gt; hi')
  equal(toSlackMrkdwn('<@U123ABC> hi', { mentionUserIds: [] }), '&lt;@U123ABC&gt; hi')
})

test('an allowlisted id comes back as a real mention', () => {
  const options = { mentionUserIds: ['U123ABC'] }
  equal(toSlackMrkdwn('<@U123ABC> hi', options), '<@U123ABC> hi')
  equal(toSlackMrkdwn('ping <@U123ABC> now', options), 'ping <@U123ABC> now')
  equal(toSlackMrkdwn('<@U123ABC|hermes> hi', options), '<@U123ABC|hermes> hi')
  equal(toSlackMrkdwn('<@U123ABC>' + NL + 'body', options), '<@U123ABC>' + NL + 'body', 'leading line')
})

test('ids outside the allowlist stay escaped', () => {
  const options = { mentionUserIds: ['U123ABC'] }
  equal(toSlackMrkdwn('<@U999ZZZ> hi', options), '&lt;@U999ZZZ&gt; hi')
  equal(toSlackMrkdwn('<@U123ABC> <@U999ZZZ>', options), '<@U123ABC> &lt;@U999ZZZ&gt;')
  equal(toSlackMrkdwn('<@U123AB> hi', options), '&lt;@U123AB&gt; hi', 'a prefix is not a match')
  equal(toSlackMrkdwn('<@U123ABCX> hi', options), '&lt;@U123ABCX&gt; hi', 'a longer id is not a match')
})

test('the allowlist never unescapes links or other angle brackets', () => {
  const options = { mentionUserIds: ['U123ABC'] }
  equal(
    toSlackMrkdwn('see <https://evil.example|click> and <b>', options),
    'see &lt;https://evil.example|click&gt; and &lt;b&gt;',
  )
  equal(toSlackMrkdwn('a < b & <@U123ABC>', options), 'a &lt; b &amp; <@U123ABC>')
})

test('an allowlisted id inside a code span stays code', () => {
  equal(toSlackMrkdwn('run `<@U123ABC>` now', { mentionUserIds: ['U123ABC'] }), 'run `<@U123ABC>` now')
})

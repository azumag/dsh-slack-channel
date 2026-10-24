// Aggregator: run all test files via dynamic import so the harness stays a
// single binary (`node tests/run.mjs`), mirroring the sibling plugins.

import { summary } from './_util.mjs'

for (const file of [
  'schema.spec.mjs',
  'format.spec.mjs',
  'collector.spec.mjs',
  'slack.spec.mjs',
  'socket.spec.mjs',
  'sessions.spec.mjs',
  'surface.spec.mjs',
  'interactions.spec.mjs',
  'plugin.spec.mjs',
  'plugin-flow.spec.mjs',
  'interactive.spec.mjs',
  'thread-scope.spec.mjs',
  'handover.spec.mjs',
]) {
  process.stdout.write('\n== ' + file + ' ==\n')
  await import('./' + file)
}

await summary()

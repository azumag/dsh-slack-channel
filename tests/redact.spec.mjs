// Secret masking for what an approval prompt shows: known key shapes,
// secret-named values, and what must stay readable (references, numbers,
// file paths, ordinary commands).

import { test, assert, equal } from './_util.mjs'
import { REDACTED, redactSecrets } from '../src/redact.js'

// Shaped like real keys, never real ones; built at run time so secret scanners do not flag them.
const GH = 'gh' + 'p_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
const PAT = 'github' + '_pat_' + '11ABCDEFG0' + 'x'.repeat(40)
const SLACK = ['xo' + 'xb', '1'.repeat(12), '2'.repeat(12), 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-')
const NV = 'nv' + 'api-' + 'Zz9_'.repeat(10)
const SK = 's' + 'k-' + 'abcDEF123456ghiJKL789'
const JWT = 'ey' + 'JhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'

test('known key shapes are masked, their prefix kept', () => {
  equal(redactSecrets('gh api user -H "token ' + GH + '"').includes(GH), false, 'GitHub token')
  equal(redactSecrets('curl -H "Authorization: Bearer ' + SK + '" x'), 'curl -H "Authorization: Bearer sk-' + REDACTED + '" x', 'a bearer key')
  equal(redactSecrets('echo ' + GH), 'echo ghp_' + REDACTED)
  equal(redactSecrets('echo ' + PAT), 'echo github_pat_' + REDACTED)
  equal(redactSecrets('echo ' + SLACK), 'echo xoxb-' + REDACTED)
  equal(redactSecrets('echo ' + NV), 'echo nvapi-' + REDACTED)
  equal(redactSecrets('echo ' + SK), 'echo sk-' + REDACTED)
  equal(redactSecrets('echo ' + JWT), 'echo eyJ' + REDACTED)
})

test('values of secret-named variables, keys, flags and headers are masked', () => {
  equal(redactSecrets('GH_TOKEN=hunter22 gh pr list'), 'GH_TOKEN=' + REDACTED + ' gh pr list')
  equal(redactSecrets('export DB_PASSWORD="p@ss word"'), 'export DB_PASSWORD="' + REDACTED + '"')
  equal(redactSecrets("mysql --password='abc123xyz' -e 'select 1'"), "mysql --password='" + REDACTED + "' -e 'select 1'")
  equal(redactSecrets('tool --api-key abcd1234 run'), 'tool --api-key ' + REDACTED + ' run')
  equal(redactSecrets('{"client_secret": "s3cr3t-value", "name": "x"}'), '{"client_secret": "' + REDACTED + '", "name": "x"}')
  equal(redactSecrets('curl -H "Authorization: Basic dXNlcjpwYXNz" x'), 'curl -H "Authorization: Basic ' + REDACTED + '" x')
  equal(redactSecrets('curl -u admin:letmein https://h'), 'curl -u admin:' + REDACTED + ' https://h')
  equal(redactSecrets('git clone https://bot:abc123@github.com/o/r'), 'git clone https://bot:' + REDACTED + '@github.com/o/r')
  const pem = 'cat <<EOF\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\nEOF'
  equal(redactSecrets(pem).includes('b3BlbnNzaC1rZXktdjEAAAAA'), false, 'a PEM body')
})

test('references, numbers, paths and ordinary commands stay as written', () => {
  for (const command of [
    'GH_TOKEN=$(cat ~/.config/gh/token) gh pr list',
    'curl -H "Authorization: Bearer $NVIDIA_API_KEY" https://integrate.api.nvidia.com/v1/models',
    'gh auth login --with-token < ~/.token',
    'tool --token "$TOKEN" --token-file ~/.secrets/t',
    'python3 run.py --max_tokens=4096',
    'hermes cron --help 2>&1 | head -40',
    'ls -la ~/.dsh && git status --short',
    'echo "xoxb-…" is the bot token shape',
  ]) {
    equal(redactSecrets(command), command, command)
  }
  equal(redactSecrets(''), '')
  equal(redactSecrets(undefined), undefined)
})

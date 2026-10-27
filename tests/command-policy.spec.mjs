// Command-policy tests: which commands an approval answers by rule
// (autoAllowCommands) — allow, ask or deny — no host, no network.

import { test, assert, equal } from './_util.mjs'
import { createCommandPolicy, invalidPatterns, recursiveRmRule } from '../src/command-policy.js'

const decide = createCommandPolicy({ cwd: '/home/hatch/work', home: '/home/hatch' })
const verdict = (command) => decide(command).decision

test('policy: ordinary work runs without asking', () => {
  for (const command of [
    'echo HOME=$HOME; pwd; ls -la /home/hatch/work 2>&1; ls -la /home/hatch | head -40',
    'which git gh python3 pytest 2>&1; git --version; gh auth status 2>&1 | head -20',
    'cd ~/work/docich-2826 && git fetch origin && git switch -c fix/2826 origin/main',
    'git push -u origin fix/2826-summon-okunote',
    'gh pr create --base main --title "fix" --body-file /tmp/body.md',
    'gh pr view 2830 --json state,reviews && gh pr checks 2830',
    'python3 -m pytest -q tests/hanjuku',
    'rm -rf node_modules build ./dist',
    'rm -rf /home/hatch/work/docich-2826/.pytest_cache',
    'rm -rf ~/work/tmp-clone "$HOME/work/old" ${HOME}/work/x',
    'rm -rf /tmp/dsh-check',
  ]) equal(verdict(command), 'allow', command)
})

test('policy: hard-to-undo commands still ask', () => {
  for (const command of [
    'git push --force origin fix/x',
    'git push -f',
    'git push origin --delete old-branch',
    'git push origin main',
    'git push origin HEAD:master',
    'gh pr merge 2830 --squash',
    'gh pr close 2830',
    'gh repo delete azumag/x --yes',
    'gh api -X DELETE repos/azumag/x/git/refs/heads/y',
    'sudo apt-get install -y bubblewrap',
    'rm -rf /etc/x',
    'rm -rf ~/.config',
    'rm -r $HOME',
    'rm -rf ../other',
    'rm -rf *',
    'rm -rf /home/hatch/work-old',
  ]) equal(verdict(command), 'ask', command)
})

test('policy: taking the machine down is denied', () => {
  for (const command of [
    'systemctl restart dsh-slack',
    'sudo shutdown -h now',
    'reboot',
    'mkfs.ext4 /dev/sdb1',
  ]) equal(verdict(command), 'deny', command)
})

test('policy: config patterns are added to the built-in lists', () => {
  const custom = createCommandPolicy({
    cwd: '/home/hatch/work',
    home: '/home/hatch',
    denyCommands: ['\\.dsh-slack/secrets/'],
    askCommands: ['\\bnpm\\s+publish\\b'],
  })
  equal(custom('cat ~/.dsh-slack/secrets/slack.json').decision, 'deny')
  equal(custom('npm publish').decision, 'ask')
  equal(custom('git push --force').decision, 'ask', 'the built-in ask list still applies')
  equal(custom('reboot').decision, 'deny', 'the built-in deny list still applies')
  equal(custom('npm test').decision, 'allow')
  equal(custom('git push --force').pattern, createCommandPolicy()('git push --force').pattern, 'the matching rule is reported')
})

test('policy: the rm rule without a workspace only spares /tmp', () => {
  const plain = createCommandPolicy()
  equal(plain('rm -rf /tmp/x').decision, 'allow')
  equal(plain('rm -rf /home/hatch/work/x').decision, 'ask')
  equal(plain('rm -rf ~/work/x').decision, 'ask')
  assert(recursiveRmRule('/srv/a.b', '/home/x').includes('srv/a\\.b/'), 'the workspace path is escaped')
})

test('policy: invalid patterns are reported', () => {
  equal(invalidPatterns(['ok', '(']).length, 1)
  equal(invalidPatterns(['\\bgit\\b']), [])
})

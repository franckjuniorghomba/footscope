import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  existsSync,
  statSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

// Les faux processus gardent leurs arguments/environnements, jamais le flux SSH.
// Le programme distant tourne vraiment dans bash -s ; seuls les chemins système
// sont redirigés vers le bac à sable, aucun apt/Docker/réseau réel.
const root = mkdtempSync(join(tmpdir(), 'relay-install-test-'));
const repo = resolve('.');
const secret = randomBytes(32).toString('hex');
const fake = String.raw`#!/usr/bin/env python3
import os, sys, json, pathlib, subprocess, shutil
name = pathlib.Path(sys.argv[0]).name
base = pathlib.Path(os.environ['RELAY_TEST_ROOT'])
remote = base / 'remote'
a = sys.argv[1:]
with (base / 'processes').open('a') as f:
    f.write(json.dumps([name, a, dict(os.environ)]) + '\n')
# Inspecter aussi les arguments des processus vivants pendant le transfert.
with (base / 'argv').open('ab') as f:
    pid = os.getpid()
    while pid and pid != int(os.environ['RELAY_TEST_PARENT']):
        try:
            p = pathlib.Path('/proc') / str(pid)
            f.write((p / 'cmdline').read_bytes() + b'\n')
            pid = int(next(line.split()[1] for line in (p / 'status').read_text().splitlines() if line.startswith('PPid:')))
        except (OSError, StopIteration): break
mode = os.environ.get('RELAY_TEST_MODE', '')
if name == 'ssh':
    cmd = a[-1]
    if cmd == 'true': sys.exit(1 if mode == 'ssh-fail' else 0)
    if 'mktemp' in cmd:
        print('/root/footscope-relay.ABCDEF12.tar'); sys.exit(0)
    assert cmd.startswith('bash -s -- '), cmd
    data = sys.stdin.buffer.read().decode()
    # Substitution des chemins uniquement ; script + token inchangés autrement.
    data = data.replace('/etc/os-release', str(base / 'os-release'))
    data = data.replace('/etc/apt/', str(remote / 'etc/apt') + '/')
    data = data.replace('/root/', str(remote) + '/')
    args = cmd.split()[3:]
    args[1] = args[1].replace('/root/', str(remote) + '/')
    env = dict(os.environ, HOME=str(remote), RELAY_TEST_SIDE='remote')
    sys.exit(subprocess.run(['bash', '-s', '--'] + args, input=data.encode(), env=env).returncode)
elif name == 'scp':
    if mode == 'scp-fail': sys.exit(1)
    source, target = a[-2:]
    shutil.copyfile(source, remote / pathlib.Path(target).name)
    shutil.copyfile(source, base / 'archive.tar')
elif name == 'curl':
    if '-o' in a:
        pathlib.Path(a[a.index('-o')+1]).write_text('FAKE GPG'); sys.exit(0)
    side = os.environ.get('RELAY_TEST_SIDE', 'pc')
    counter = base / ('curl-' + side)
    n = int(counter.read_text())+1 if counter.exists() else 1
    counter.write_text(str(n))
    if mode == 'health-fail' or (mode == 'pc-fail' and side == 'pc'): sys.exit(22)
    if mode == 'health-invalid': print('{"ready":false}')
    elif mode == 'health-retry' and side == 'remote' and n < 3: sys.exit(22)
    else: print('{"ready":true}')
elif name == 'docker':
    if mode == 'docker-install' and a in [['version'], ['compose','version']]: sys.exit(1)
    if mode == 'compose-fail' and 'up' in a: sys.exit(1)
elif name == 'clip.exe':
    (base / 'clipboard').write_bytes(sys.stdin.buffer.read())
elif name == 'openssl':
    print((base / 'fixture-token').read_text())
elif name == 'install':
    if '-d' in a: pathlib.Path(a[-1]).mkdir(parents=True, exist_ok=True)
elif name == 'dpkg': print('amd64')
elif name in ['apt-get', 'systemctl', 'sleep']: pass
else: raise Exception(name)
`;
try {
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'fake'), fake, { mode: 0o755 });
  const names = [
    'ssh',
    'scp',
    'curl',
    'docker',
    'clip.exe',
    'openssl',
    'install',
    'dpkg',
    'apt-get',
    'systemctl',
    'sleep',
  ];
  for (const name of names) symlinkSync('fake', join(root, 'bin', name));
  const cases = [];
  function scenario(
    name,
    {
      mode = '',
      input = 'oui\n',
      ip = '203.0.113.42',
      prepare,
      repeat = false,
      noClipboard = false,
    } = {},
  ) {
    const dir = join(root, name);
    const home = join(dir, 'pc');
    const remote = join(dir, 'remote');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(remote, 'etc', 'apt', 'sources.list.d'), { recursive: true });
    writeFileSync(join(dir, 'os-release'), 'ID=ubuntu\nVERSION_ID=24.04\nVERSION_CODENAME=noble\n');
    writeFileSync(join(dir, 'fixture-token'), secret);
    if (prepare) prepare({ dir, home, remote });
    if (noClipboard) rmSync(join(root, 'bin', 'clip.exe'));
    const env = {
      LANG: 'C.UTF-8',
      RELAY_TEST_PARENT: String(process.pid),
      HOME: home,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      RELAY_TEST_ROOT: dir,
      RELAY_TEST_MODE: mode,
    };
    const run = () =>
      spawnSync('bash', ['scripts/relay-install.sh', ip], {
        cwd: repo,
        env,
        input,
        encoding: 'utf8',
        timeout: 30000,
      });
    const result = run();
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    assert.ok(!output.includes(secret), `${name}: secret dans la sortie`);
    for (const file of ['processes', 'argv']) {
      if (existsSync(join(dir, file)))
        assert.ok(
          !readFileSync(join(dir, file), 'utf8').includes(secret),
          `${name}: secret dans ${file}`,
        );
    }
    if (repeat) {
      assert.equal(result.status, 0, output);
      const before = statSync(join(remote, 'footscope/deploy/relay/.env')).mtimeMs;
      const second = run();
      assert.equal(second.status, 0, second.stderr);
      assert.ok(!(second.stdout + second.stderr).includes(secret));
      assert.equal(statSync(join(remote, 'footscope/deploy/relay/.env')).mtimeMs, before);
      const calls = readFileSync(join(dir, 'processes'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse);
      assert.equal(calls.filter(([n]) => n === 'openssl').length, 1);
    }
    cases.push(name);
    return { result, output, dir, home, remote };
  }
  const ok = scenario('success-reuse', { repeat: true });
  for (const path of [
    join(ok.home, '.config/footscope/relay-token'),
    join(ok.remote, 'footscope/deploy/relay/.env'),
  ])
    assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(ok.dir, 'clipboard'), 'utf8').trim(), secret);
  const calls = readFileSync(join(ok.dir, 'processes'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
  assert.ok(
    calls.findIndex(([n]) => n === 'clip.exe') >
      calls.findIndex(([n, , e]) => n === 'curl' && !e.RELAY_TEST_SIDE),
  );
  const archive = spawnSync('tar', ['-tf', join(ok.dir, 'archive.tar')], { encoding: 'utf8' });
  assert.equal(archive.status, 0);
  assert.ok(
    archive.stdout
      .trim()
      .split('\n')
      .every((p) => p.startsWith('deploy/') || p === 'scripts/' || p === 'scripts/relay.mjs'),
  );
  assert.equal(
    readFileSync(join(ok.remote, 'footscope/.dockerignore'), 'utf8'),
    '.git\n.env\n.env.*\n**/.env\n**/.env.*\nnode_modules\n.build\ndist\ncoverage\nupload\n*.zip\n',
  );
  const retry = scenario('https-retry', { mode: 'health-retry' });
  assert.equal(retry.result.status, 0, retry.output);
  assert.equal(readFileSync(join(retry.dir, 'curl-remote'), 'utf8'), '3');
  const install = scenario('docker-deb822', { mode: 'docker-install' });
  assert.equal(install.result.status, 0, install.output);
  assert.match(
    readFileSync(join(install.remote, 'etc/apt/sources.list.d/docker.sources'), 'utf8'),
    /Types: deb[\s\S]*Suites: noble[\s\S]*Architectures: amd64/,
  );
  for (const mode of [
    'ssh-fail',
    'scp-fail',
    'compose-fail',
    'health-fail',
    'health-invalid',
    'pc-fail',
  ]) {
    const test = scenario(mode, { mode });
    assert.notEqual(test.result.status, 0, test.output);
    assert.ok(!existsSync(join(test.dir, 'clipboard')));
    assert.ok(!test.output.includes('API_RELAY_TOKEN'));
    if (mode.startsWith('health-'))
      assert.equal(readFileSync(join(test.dir, 'curl-remote'), 'utf8'), '30');
    if (mode === 'ssh-fail')
      assert.ok(!existsSync(join(test.home, '.config/footscope/relay-token')));
  }
  for (const ip of ['999.1.1.1', '01.2.3.4', 'x;false'])
    assert.notEqual(scenario(`bad-ip-${cases.length}`, { ip }).result.status, 0);
  assert.notEqual(scenario('cancel', { input: 'non\n' }).result.status, 0);
  assert.notEqual(scenario('eof', { input: '' }).result.status, 0);
  const conflict = scenario('env-conflict', {
    prepare: ({ remote }) => {
      mkdirSync(join(remote, 'footscope/deploy/relay'), { recursive: true });
      writeFileSync(join(remote, 'footscope/deploy/relay/.env'), 'DO_NOT_OVERWRITE\n');
    },
  });
  assert.notEqual(conflict.result.status, 0);
  assert.equal(
    readFileSync(join(conflict.remote, 'footscope/deploy/relay/.env'), 'utf8'),
    'DO_NOT_OVERWRITE\n',
  );
  const badToken = scenario('invalid-token', {
    prepare: ({ home }) => {
      mkdirSync(join(home, '.config/footscope'), { recursive: true });
      writeFileSync(join(home, '.config/footscope/relay-token'), 'invalid');
    },
  });
  assert.notEqual(badToken.result.status, 0);
  assert.ok(!existsSync(join(badToken.dir, 'archive.tar')));
  for (const kind of ['symlink-token', 'config-in-repo', 'unsupported-os']) {
    const test = scenario(kind, {
      prepare: ({ dir, home }) => {
        if (kind === 'unsupported-os') {
          writeFileSync(join(dir, 'os-release'), 'ID=debian\nVERSION_ID=12\n');
        } else {
          mkdirSync(join(home, '.config'), { recursive: true });
          if (kind === 'config-in-repo') symlinkSync(repo, join(home, '.config/footscope'));
          else {
            mkdirSync(join(home, '.config/footscope'));
            symlinkSync(join(dir, 'fixture-token'), join(home, '.config/footscope/relay-token'));
          }
        }
      },
    });
    assert.notEqual(test.result.status, 0, test.output);
    assert.ok(!existsSync(join(test.dir, 'clipboard')));
  }
  const noClip = scenario('no-clipboard', { noClipboard: true });
  assert.equal(noClip.result.status, 0, noClip.output);
  assert.match(noClip.output, /interopérabilité Windows/);
  // Vérifier tous les fichiers versionnés et les nouveaux fichiers de la tâche.
  const tracked = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .stdout.split('\0')
    .filter(Boolean);
  for (const file of [...tracked, 'scripts/relay-install.sh', 'tests/relay-install.mjs']) {
    if (existsSync(file) && statSync(file).isFile())
      assert.ok(!readFileSync(file).includes(Buffer.from(secret)), `${file}: secret dans le dépôt`);
  }
  console.log(
    `Relay installer: ${cases.length} scénarios simulés, zéro fuite stdout/stderr/arguments/environnements/dépôt.`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

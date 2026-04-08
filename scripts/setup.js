#!/usr/bin/env node
/**
 * protect-bypass setup script
 * Cross-platform: macOS, Windows, Linux
 * Run with: npm run setup
 */

const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
const POST_INSTALL = process.argv.includes('--post-install');

// ── Helpers ───────────────────────────────────────────────────────────────────

const green  = s => `\x1b[32m${s}\x1b[0m`;
const red    = s => `\x1b[31m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const bold   = s => `\x1b[1m${s}\x1b[0m`;
const dim    = s => `\x1b[2m${s}\x1b[0m`;

function ok(msg)   { console.log(green('  ✓ ') + msg); }
function err(msg)  { console.log(red('  ✗ ') + msg); }
function info(msg) { console.log(dim('    ') + msg); }
function warn(msg) { console.log(yellow('  ! ') + msg); }
function step(msg) { console.log('\n' + bold(msg)); }

function which(cmd) {
  try {
    const result = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8' });
    return result.status === 0 && result.stdout.trim().length > 0;
  } catch { return false; }
}

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: opts.silent ? 'pipe' : 'inherit', ...opts });
}

function openBrowser(url) {
  if (IS_WIN)   spawnSync('cmd', ['/c', 'start', url], { detached: true });
  else if (IS_MAC) spawnSync('open', [url], { detached: true });
  else {
    for (const b of ['xdg-open', 'gnome-open', 'sensible-browser']) {
      if (which(b)) { spawnSync(b, [url], { detached: true }); break; }
    }
  }
}

// ── Remux binary paths ────────────────────────────────────────────────────────

function getRemuxCandidates() {
  const localBin = path.join(os.homedir(), '.local', 'bin', IS_WIN ? 'remux.exe' : 'remux');
  const usrLocal = IS_WIN ? null : '/usr/local/bin/remux';
  const tmpBuild = IS_WIN
    ? path.join(os.tmpdir(), 'pb-remux', 'target', 'release', 'remux.exe')
    : path.join(os.tmpdir(), 'pb-remux', 'target', 'release', 'remux');
  return [localBin, usrLocal, tmpBuild].filter(Boolean);
}

function findRemux() {
  return getRemuxCandidates().find(p => fs.existsSync(p)) || null;
}

function getRemuxInstallPath() {
  const localBin = path.join(os.homedir(), '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  return path.join(localBin, IS_WIN ? 'remux.exe' : 'remux');
}

// ── Checks ────────────────────────────────────────────────────────────────────

function checkNode() {
  step('Checking Node.js...');
  const version = process.version;
  const major = parseInt(version.slice(1));
  if (major < 18) {
    err(`Node.js ${version} is too old. Need 18+.`);
    info('Download: https://nodejs.org');
    process.exit(1);
  }
  ok(`Node.js ${version}`);
}

function checkDeps() {
  step('Installing Node dependencies...');
  const nodeModules = path.join(ROOT, 'node_modules');
  const hasExpress = fs.existsSync(path.join(nodeModules, 'express'));
  const hasSsh2 = fs.existsSync(path.join(nodeModules, 'ssh2'));
  if (hasExpress && hasSsh2) {
    ok('node_modules already installed');
    return;
  }
  try {
    run('npm install', { cwd: ROOT });
    ok('npm install complete');
  } catch (e) {
    err('npm install failed: ' + e.message);
    process.exit(1);
  }
}

function checkFfmpeg() {
  step('Checking ffmpeg...');
  if (which('ffmpeg')) {
    ok('ffmpeg found');
    return true;
  }
  warn('ffmpeg not found — footage recovery will not work.');
  if (IS_MAC)   info('Install: brew install ffmpeg  OR  https://evermeet.cx/ffmpeg/');
  if (IS_WIN)   info('Download: https://www.gyan.dev/ffmpeg/builds/ → add ffmpeg.exe to PATH');
  if (IS_LINUX) info('Install: sudo apt install ffmpeg  (or dnf/pacman equivalent)');
  info('You can still use diagnostics without ffmpeg.');
  return false;
}

function checkRemux() {
  step('Checking remux binary...');
  const existing = findRemux();
  if (existing) {
    ok(`remux found at ${existing}`);
    return true;
  }

  warn('remux not found — building from source...');

  // Check cargo
  let hasCargo = which('cargo');
  if (!hasCargo) {
    // Try sourcing rustup env (Mac/Linux)
    const cargoEnv = path.join(os.homedir(), '.cargo', 'env');
    if (fs.existsSync(cargoEnv)) {
      process.env.PATH += path.delimiter + path.join(os.homedir(), '.cargo', 'bin');
      hasCargo = which('cargo');
    }
  }

  if (!hasCargo) {
    warn('Rust/cargo not found. remux will not be built.');
    info('Install Rust: https://rustup.rs');
    info('Then run: npm run setup');
    info('Footage recovery will be unavailable until remux is installed.');
    return false;
  }

  // Check git
  if (!which('git')) {
    warn('git not found. Cannot clone remux source.');
    info('Install git: https://git-scm.com');
    return false;
  }

  return buildRemux();
}

function buildRemux() {
  const buildDir = path.join(os.tmpdir(), 'pb-remux');
  const installPath = getRemuxInstallPath();

  try {
    info('Cloning unifi-protect-remux...');
    if (fs.existsSync(buildDir)) {
      if (IS_WIN) run(`rmdir /s /q "${buildDir}"`, { silent: true });
      else run(`rm -rf "${buildDir}"`, { silent: true });
    }
    run(`git clone --depth=1 https://github.com/petergeneric/unifi-protect-remux.git "${buildDir}"`);

    info('Building (this takes 1-2 minutes)...');
    run('cargo build --release', { cwd: buildDir });

    const builtBin = path.join(buildDir, 'target', 'release', IS_WIN ? 'remux.exe' : 'remux');
    if (!fs.existsSync(builtBin)) {
      throw new Error('Build completed but binary not found');
    }

    fs.copyFileSync(builtBin, installPath);
    if (!IS_WIN) fs.chmodSync(installPath, 0o755);

    ok(`remux built and installed to ${installPath}`);
    return true;
  } catch (e) {
    err(`remux build failed: ${e.message}`);
    info('You can build it manually: https://github.com/petergeneric/unifi-protect-remux');
    return false;
  }
}

// ── Write runtime config ───────────────────────────────────────────────────────

function writeConfig(remuxPath) {
  const config = {
    remuxPath: remuxPath || null,
    platform: process.platform,
    setupAt: new Date().toISOString(),
    nodeVersion: process.version,
  };
  fs.writeFileSync(
    path.join(ROOT, '.pb-config.json'),
    JSON.stringify(config, null, 2)
  );
  ok('Config written to .pb-config.json');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + bold('═'.repeat(48)));
  console.log(bold('  protect-bypass — setup'));
  console.log(bold('  Platform: ') + dim(process.platform + ' ' + process.arch));
  console.log(bold('═'.repeat(48)));

  // Skip heavy work if this is just npm postinstall
  if (POST_INSTALL) {
    console.log(dim('\n  Run "npm run setup" to complete setup.\n'));
    process.exit(0);
  }

  checkNode();
  checkDeps();
  checkFfmpeg();
  const remuxOk = checkRemux();
  const remuxPath = findRemux();

  step('Writing config...');
  writeConfig(remuxPath);

  console.log('\n' + bold('═'.repeat(48)));
  console.log(bold('  Setup complete!'));
  console.log(bold('═'.repeat(48)));
  console.log('');
  if (!remuxOk) {
    warn('remux is missing — footage recovery will not work until it is installed.');
    info('Install Rust (https://rustup.rs) then run: npm run setup');
    console.log('');
  }
  console.log('  Start the tool with: ' + bold('npm start'));
  console.log('  Then open:           ' + bold('http://localhost:3500'));
  console.log('');

  // Ask to start now
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('  Start protect-bypass now? [Y/n] ', function(answer) {
    rl.close();
    if (answer.toLowerCase() !== 'n') {
      console.log('');
      setTimeout(() => openBrowser('http://localhost:3500'), 2000);
      const child = spawn('node', ['server.js'], { cwd: ROOT, stdio: 'inherit' });
      child.on('exit', code => process.exit(code || 0));
    } else {
      console.log('  Run "npm start" whenever you\'re ready.\n');
      process.exit(0);
    }
  });
}

main().catch(e => { err(e.message); process.exit(1); });

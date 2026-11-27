#!/usr/bin/env node
/*
 * Authorship stamp for Openly. Uses only Node's built-in crypto.
 *
 *   node tools/brand.js init     First time: make your signing key, hide an encrypted claim in the code, sign everything.
 *   node tools/brand.js sign     After you change code: sign again before a release.
 *   node tools/brand.js verify   Anyone can run this: checks the code is exactly what the author signed.
 *   node tools/brand.js reveal   You only: decrypts the hidden claim with your passphrase.
 *
 * Your private key lives in .brand/ (encrypted with your passphrase, never committed). Keep a backup and remember the passphrase.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const KEY_FILE = path.join(ROOT, '.brand', 'signing-key.json');
const SIG_FILE = path.join(ROOT, 'BRAND.sig.json');
const AUTHOR = 'Raheelkhan Lohani';
const PROJECT = 'Openly';
const TARGETS = [
  { file: 'extension/brand.js', wrap: (o) => `globalThis.OpenlyBrand = ${o};` },
  { file: 'backend/src/brand.js', wrap: (o) => `module.exports = ${o};` },
];
const SKIP_DIRS = new Set(['node_modules', '.git', '.brand', 'dist']);
const SKIP_FILES = new Set(['BRAND.sig.json', ...TARGETS.map((t) => t.file)]);
const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');

/* ---------- passphrase ---------- */
function ask(question, hidden = true) {
  if (process.env.BRAND_PASSPHRASE) return Promise.resolve(process.env.BRAND_PASSPHRASE);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}

/* ---------- encryption: scrypt + AES-256-GCM ---------- */
function seal(plain, passphrase) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return JSON.stringify({ v: 1, s: b64(salt), i: b64(iv), t: b64(c.getAuthTag()), c: b64(ct) });
}
function open(sealed, passphrase) {
  const o = JSON.parse(sealed);
  const key = crypto.scryptSync(passphrase, unb64(o.s), 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const d = crypto.createDecipheriv('aes-256-gcm', key, unb64(o.i));
  d.setAuthTag(unb64(o.t));
  return Buffer.concat([d.update(unb64(o.c)), d.final()]).toString('utf8');
}

/* ---------- what gets signed ---------- */
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (fs.statSync(full).isDirectory()) { if (!SKIP_DIRS.has(name)) walk(full, out); }
    else if (!SKIP_FILES.has(rel) && !/\.(png|zip|log)$/.test(rel) && !rel.startsWith('backend/package-lock')) out.push(rel);
  }
  return out;
}
function manifest() {
  return walk(ROOT).sort().map((rel) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex')}  ${rel}`);
}
const message = (lines, provenance, signedAt) => Buffer.from(`openly-manifest-v1\n${lines.join('\n')}\n${provenance}\n${signedAt}`);
const fingerprintOf = (publicKeyB64) => crypto.createHash('sha256').update(unb64(publicKeyB64)).digest('hex').slice(0, 16);

function writeTargets(brand) {
  const obj = JSON.stringify(brand);
  for (const t of TARGETS) {
    const p = path.join(ROOT, t.file);
    const src = fs.readFileSync(p, 'utf8');
    const next = src.replace(/\/\*BRAND:BEGIN\*\/[\s\S]*?\/\*BRAND:END\*\//, `/*BRAND:BEGIN*/\n${t.wrap(obj)}\n/*BRAND:END*/`);
    if (next === src && !src.includes(obj)) throw new Error(`Markers not found in ${t.file}`);
    fs.writeFileSync(p, next);
  }
}
function readBrand() {
  const src = fs.readFileSync(path.join(ROOT, TARGETS[1].file), 'utf8');
  const m = /module\.exports = (\{[\s\S]*?\});\s*\n\/\*BRAND:END\*\//.exec(src);
  return m ? JSON.parse(m[1]) : null;
}

/* ---------- commands ---------- */
async function loadPrivateKey(passphrase) {
  if (!fs.existsSync(KEY_FILE)) throw new Error('No signing key found. Run "node tools/brand.js init" first.');
  return crypto.createPrivateKey({ key: unb64(open(fs.readFileSync(KEY_FILE, 'utf8'), passphrase)), format: 'der', type: 'pkcs8' });
}

async function signAll(privateKey, publicKeyB64, provenance) {
  const signedAt = new Date().toISOString();
  const brand = { author: AUTHOR, project: PROJECT, fingerprint: fingerprintOf(publicKeyB64), publicKey: publicKeyB64, provenance, signature: null, signedAt };
  writeTargets(brand); // fingerprint and claim first; they are not part of the signed file list
  const lines = manifest();
  const signature = b64(crypto.sign(null, message(lines, provenance, signedAt), privateKey));
  brand.signature = signature;
  writeTargets(brand);
  fs.writeFileSync(SIG_FILE, JSON.stringify({ project: PROJECT, author: AUTHOR, fingerprint: brand.fingerprint, publicKey: publicKeyB64, provenance, signedAt, signature, files: lines.length }, null, 2) + '\n');
  return brand;
}

async function init() {
  if (fs.existsSync(KEY_FILE)) throw new Error('A signing key already exists in .brand/. Use "sign" to sign again.');
  const pass = await ask('Choose a passphrase (you will need it to sign and to reveal the claim): ');
  if (pass.length < 10) throw new Error('Use a passphrase of at least 10 characters.');
  if (!process.env.BRAND_PASSPHRASE && (await ask('Type it again: ')) !== pass) throw new Error('The passphrases did not match.');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyB64 = b64(publicKey.export({ format: 'der', type: 'spki' }));
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, seal(b64(privateKey.export({ format: 'der', type: 'pkcs8' })), pass), { mode: 0o600 });
  const claim = JSON.stringify({ author: AUTHOR, project: PROJECT, claim: 'Original author and owner', created: new Date().toISOString(), id: crypto.randomBytes(8).toString('hex') });
  const brand = await signAll(privateKey, publicKeyB64, seal(claim, pass));
  console.log(`Done. Fingerprint ${brand.fingerprint}.\nBack up .brand/signing-key.json somewhere safe and remember your passphrase. Never commit .brand/.`);
}

async function sign() {
  const pass = await ask('Passphrase: ');
  const priv = await loadPrivateKey(pass);
  const b = readBrand();
  if (!b?.provenance) throw new Error('Run "init" first.');
  await signAll(priv, b.publicKey, b.provenance);
  console.log('Signed.');
}

function verify() {
  if (!fs.existsSync(SIG_FILE)) throw new Error('BRAND.sig.json is missing, so this copy is not signed.');
  const s = JSON.parse(fs.readFileSync(SIG_FILE, 'utf8'));
  const lines = manifest();
  const pub = crypto.createPublicKey({ key: unb64(s.publicKey), format: 'der', type: 'spki' });
  const ok = crypto.verify(null, message(lines, s.provenance, s.signedAt), pub, unb64(s.signature));
  const embedded = readBrand();
  const same = embedded && embedded.signature === s.signature && embedded.fingerprint === s.fingerprint && fingerprintOf(s.publicKey) === s.fingerprint;
  if (ok && same) {
    console.log(`VALID. ${s.files} files are exactly as signed by the holder of key ${s.fingerprint} on ${s.signedAt}.`);
  } else {
    console.log(ok ? 'The signature is valid but the embedded stamps do not match it.' : 'NOT VALID. Files were changed after signing (or this is not an authentic copy).');
    process.exitCode = 1;
  }
}

async function reveal() {
  const s = JSON.parse(fs.readFileSync(SIG_FILE, 'utf8'));
  const pass = await ask('Passphrase: ');
  try { console.log(JSON.stringify(JSON.parse(open(s.provenance, pass)), null, 2)); }
  catch { throw new Error('Wrong passphrase, or the claim was altered.'); }
}

const cmd = process.argv[2];
const run = { init, sign, verify, reveal }[cmd];
if (!run) { console.log('Usage: node tools/brand.js <init|sign|verify|reveal>'); process.exit(1); }
Promise.resolve().then(run).catch((e) => { console.error('Error: ' + e.message); process.exit(1); });

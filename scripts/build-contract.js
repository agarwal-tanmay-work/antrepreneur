// Builds (or tests) the Rust contract inside Docker with Rust 1.86, so nobody
// needs a local Rust toolchain. Output: out/antrepreneur.wasm
//   npm run build:contract     npm run test:contract
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib/near.js';

const test = process.argv.includes('--test');
const contractDir = path.join(ROOT, 'contract');
const outDir = path.join(ROOT, 'out');
mkdirSync(outDir, { recursive: true });
const sh = (cmd) => execSync(cmd, { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

sh(`docker build -q -t ant-builder -f "${path.join(contractDir, 'Dockerfile.build')}" "${contractDir}"`);
const vols = `-v "${contractDir}:/work" -v "${outDir}:/out" -v ant-cargo:/usr/local/cargo/registry -v ant-target:/target`;
const inner = test
  ? 'cargo test'
  : 'cargo build --release --target wasm32-unknown-unknown && wasm-opt -Oz --strip-debug /target/wasm32-unknown-unknown/release/antrepreneur.wasm -o /out/antrepreneur.wasm && ls -la /out/antrepreneur.wasm && sha256sum /out/antrepreneur.wasm';
sh(`docker run --rm ${vols} ant-builder sh -c "${inner}"`);

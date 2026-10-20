import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

/**
 * 扩展脚本构建：background（ESM service worker）与 content（IIFE 内容脚本）。
 * 仪表盘由 Vite 构建，本脚本负责剩下的文件并同步 manifest 版本。
 *
 * 注意：这里直接调用 esbuild 的平台二进制，而不是 `import { build } from 'esbuild'`。
 * 后者的 JS API 会再 spawn 一个子进程并用管道通信，在受限沙箱里会被拒绝（spawn EPERM）；
 * 直接调用二进制只需要继承当前进程的 stdio。
 */

const root = process.cwd();
const dist = resolve(root, 'dist');
mkdirSync(dist, { recursive: true });

const platform = `${process.platform}-${process.arch}`;
const binaryName = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
const esbuildBinary = resolve(root, 'node_modules', '@esbuild', platform, binaryName);
if (!existsSync(esbuildBinary)) {
  console.error(`找不到 esbuild 平台二进制：${esbuildBinary}`);
  process.exit(1);
}

const commonArgs = [
  '--bundle',
  '--platform=browser',
  '--target=chrome120',
  '--log-level=warning',
  '--legal-comments=none',
];

function runEsbuild(args) {
  const result = spawnSync(esbuildBinary, args, { stdio: 'inherit', cwd: root });
  if (result.error) {
    console.error(`执行 esbuild 失败：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

runEsbuild([
  ...commonArgs,
  '--format=esm',
  `--outfile=${resolve(dist, 'background.js')}`,
  resolve(root, 'src/extension/background.ts'),
]);

runEsbuild([
  ...commonArgs,
  '--format=iife',
  `--outfile=${resolve(dist, 'content.js')}`,
  resolve(root, 'src/extension/content.ts'),
]);

copyFileSync(resolve(root, 'src/extension/content.css'), resolve(dist, 'content.css'));
copyFileSync(resolve(root, 'src/extension/manifest.json'), resolve(dist, 'manifest.json'));

// 逐个复制图标：递归 cpSync 在 Windows 沙箱下对新建目录偶尔报 EIO，这里拆成文件级复制
const iconDir = resolve(dist, 'icons');
mkdirSync(iconDir, { recursive: true });
const iconSource = resolve(root, 'public/icons');
for (const name of readdirSync(iconSource)) {
  if (!name.endsWith('.png')) continue;
  copyFileSync(resolve(iconSource, name), resolve(iconDir, name));
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifestPath = resolve(dist, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.version = pkg.version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`dist 构建完成：${dist}`);

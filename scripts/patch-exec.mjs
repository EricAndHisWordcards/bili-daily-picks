/**
 * 沙箱兼容补丁：在受限环境下，Vite 启动时会对 `net use` 执行带管道的 `exec`，
 * 用来探测 Windows 网络驱动器；管道子进程会被沙箱拒绝（spawn EPERM），导致
 * Vite / Vitest 在加载配置时直接崩溃。
 *
 * 这里只拦截 `net use` 探测（固定回调一个错误，Vite 会退回到普通 realpath 实现），
 * 其他命令仍走真实实现，因此在普通开发环境里行为不变。
 *
 * 用法：node --import ./scripts/patch-exec.mjs node_modules/vite/bin/vite.js build
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');

const realExec = childProcess.exec.bind(childProcess);

function fakeChild() {
  const child = new EventEmitter();
  child.kill = () => undefined;
  child.unref = () => undefined;
  return child;
}

function isNetUse(command) {
  return typeof command === 'string' && /^\s*net\s+use\b/i.test(command);
}

childProcess.exec = function patchedExec(command, options, callback) {
  let cb = callback;
  let opts = options;
  if (typeof options === 'function') {
    cb = options;
    opts = undefined;
  }

  if (isNetUse(command)) {
    if (typeof cb === 'function') {
      process.nextTick(() => cb(new Error('sandbox: net use disabled by patch-exec.mjs'), '', ''));
    }
    return fakeChild();
  }

  try {
    return realExec(command, opts, cb);
  } catch (error) {
    if (typeof cb === 'function') {
      process.nextTick(() => cb(error, '', ''));
    }
    return fakeChild();
  }
};

// 让 ESM 的 `import { exec } from 'node:child_process'` 看到补丁后的实现
syncBuiltinESMExports();

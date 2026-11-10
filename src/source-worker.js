/**
 * 额度查询代码的执行载体（worker 线程）。
 *
 * 为什么单独一个线程：模型写出来的代码不可信——`while (true) {}` 写在 `await` 之后时，
 * `vm.runInContext` 的 timeout 根本拦不住（它只管同步执行那一段），整个宿主线程会被占死。
 * 放在 worker 里，超时后主线程直接 `terminate()`，代价只是这次查询失败。
 *
 * 这里只做三件事：跑 vm、把结果/错误原样传回、什么都不写。
 */

import { parentPort, workerData } from 'node:worker_threads';

import { runInVm } from './sources.js';

async function main() {
  try {
    const out = await runInVm({
      code: workerData?.code,
      credential: workerData?.credential,
      plan: workerData?.plan,
      allowHosts: workerData?.allowHosts,
      timeoutMs: workerData?.timeoutMs,
    });
    parentPort?.postMessage({ ok: true, out });
  } catch (error) {
    parentPort?.postMessage({ ok: false, error: String(error?.message || error) });
  }
}

main();
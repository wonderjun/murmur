/**
 * omp 扩展安装器：omp 的 hook 不是 sh 脚本而是 agent 进程内 TS 模块，
 * 落点是 <agentDir>/extensions/ 官方自动发现目录——独占文件写入而非
 * merge 配置（与 merge* 家族的本质区别，见 omp-script.ts 模板头）。
 * 归属只认 HOOK_MARKER：同名无标记文件不当我方文件。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderOmpExtension } from './omp-script';
import { HOOK_MARKER } from './script';

/** omp 扩展文件名（<agentDir>/extensions/ 自动发现目录里的落点名）。 */
const OMP_EXTENSION_NAME = 'murmur-agent.ts';

/** omp 上报扩展的落点路径（诊断 hookTargets 展示/adapter 判归属用）。 */
export function ompExtensionPath(extDir: string): string {
  return join(extDir, OMP_EXTENSION_NAME);
}

/** path 是否我方扩展文件（存在且含 HOOK_MARKER——同名用户文件不碰也不认）。 */
function isOmpExtensionFile(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

/** 该目录下我方 omp 扩展是否已安装（detect/hookInstalled 用）。 */
export function ompExtensionInstalled(extDir: string): boolean {
  return isOmpExtensionFile(ompExtensionPath(extDir));
}

/**
 * 落 omp 上报扩展：写入 <extDir>/murmur-agent.ts（omp 官方自动发现目录）。
 * 与 merge* 不同——这是独占文件，不 merge 他人配置：内容一致跳过（幂等），
 * 不同则覆盖重写（随启动升级模板、他人误改自愈）。返回是否有改动。
 */
export function installOmpExtension(extDir: string): { changed: boolean } {
  const path = ompExtensionPath(extDir);
  const src = renderOmpExtension();
  if (existsSync(path)) {
    try {
      if (readFileSync(path, 'utf8') === src) return { changed: false };
    } catch {
      // 读不了按重写处理。
    }
  }
  mkdirSync(extDir, { recursive: true });
  const tmp = `${path}.murmur-tmp`;
  writeFileSync(tmp, src);
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return { changed: true };
}

/** 卸载 omp 上报扩展：只删带 marker 的我方文件（同名用户文件不碰）。 */
export function uninstallOmpExtension(extDir: string): { changed: boolean } {
  const path = ompExtensionPath(extDir);
  if (!isOmpExtensionFile(path)) return { changed: false };
  try {
    unlinkSync(path);
    return { changed: true };
  } catch {
    return { changed: false };
  }
}

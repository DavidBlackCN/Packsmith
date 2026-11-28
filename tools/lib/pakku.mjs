import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, safePath } from './workspace.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
  });
}

export function requireSuccess(result) {
  if (result.code !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw Object.assign(new Error(`工具退出码 ${result.code}\n${output}`), { exitCode: result.code });
  }
  return result;
}

export async function tool(root) {
  const chain = await readJson(await safePath(root, 'toolchain.json'));
  const spec = chain.pakku;
  if (!spec || !/^\d+\.\d+\.\d+$/.test(spec.version) ||
      !/^[a-f0-9]{64}$/.test(spec.sha256) || !spec.url?.startsWith('https://')) {
    throw new Error('toolchain.json 的 Pakku 版本、SHA-256 或下载地址无效');
  }
  return { ...spec, chain, jar: await safePath(root, `.cache/pakku-${spec.version}.jar`) };
}

export async function verifiedTool(root) {
  const spec = await tool(root);
  let bytes;
  try {
    bytes = await fs.readFile(spec.jar);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Pakku 未安装，请运行 pnpm bootstrap');
    throw error;
  }
  if (sha256(bytes) !== spec.sha256) throw new Error(`Pakku SHA-256 不匹配，请移走损坏缓存再运行 pnpm bootstrap: ${spec.jar}`);
  return spec;
}

export async function bootstrap(root, download = fetch) {
  const spec = await tool(root);
  try {
    await fs.access(spec.jar);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await download(spec.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`下载 Pakku 失败 HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== spec.sha256) throw new Error('下载的 Pakku SHA-256 不匹配');
    await fs.mkdir(path.dirname(spec.jar), { recursive: true });
    const partial = `${spec.jar}.${randomUUID()}.part`;
    try {
      await fs.writeFile(partial, bytes, { flag: 'wx' });
      await fs.rename(partial, spec.jar);
    } finally {
      await fs.rm(partial, { force: true });
    }
    return spec;
  }
  return verifiedTool(root);
}

export async function pakku(root, targetPath, args, options = {}) {
  const spec = await verifiedTool(root);
  // Pakku 1.5.0 的 export 按 cwd 解析相对规则；传绝对 working-path 会破坏导出。
  const java = options.java ?? process.env.PACKSMITH_JAVA ?? 'java';
  return (options.execute ?? run)(java, [
    '-Dfile.encoding=UTF-8', '-jar', spec.jar, '--working-path', '.', ...args,
  ], { ...options, cwd: targetPath });
}

export function validateExportOutput(result) {
  requireSuccess(result);
  // 1.5.0 遇到 profile 导出错误或迁移时也可能以 0 退出。
  const output = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const profiles = output.split(/\r?\n/).filter(line => /\[[^\]]+ profile\]/.test(line));
  if (!profiles.length || profiles.some(line => !/\] exported to '/.test(line)) || output.includes('[Migration]')) {
    throw new Error(`Pakku 导出报告含错误、遗漏或隐式迁移\n${output}`);
  }
  return result;
}

export async function exportPakku(root, directory, options = {}) {
  const result = await pakku(root, directory, ['export'], { ...options, capture: true });
  return validateExportOutput(result);
}

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface ProjectCodexHomeOptions {
  userCodexHome?: string;
  runtimeRoot?: string;
}

function ensureLink(path: string, target: string, type: 'file' | 'dir'): void {
  if (existsSync(path) || lstatExists(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === resolve(target)) return;
    throw new Error(`Codex runtime path already exists and is not the expected link: ${path}`);
  }
  symlinkSync(target, path, type);
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keeps credentials outside the repository while projecting project-owned sessions,
 * skills and config into the Codex CLI home used by this workbench.
 */
export function prepareProjectCodexHome(
  cwd: string,
  options: ProjectCodexHomeOptions = {},
): string {
  const projectHome = join(cwd, '.codex');
  const userCodexHome = options.userCodexHome ?? join(homedir(), '.codex');
  const runtimeRoot = options.runtimeRoot ?? join(userCodexHome, 'waker-projects');
  const projectKey = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16);
  const runtimeHome = join(runtimeRoot, projectKey);

  mkdirSync(projectHome, { recursive: true });
  mkdirSync(join(projectHome, 'sessions'), { recursive: true });
  mkdirSync(join(projectHome, 'skills'), { recursive: true });
  mkdirSync(runtimeHome, { recursive: true });

  const projectConfig = join(projectHome, 'config.toml');
  if (!existsSync(projectConfig)) writeFileSync(projectConfig, '', { mode: 0o600 });

  ensureLink(join(runtimeHome, 'sessions'), join(projectHome, 'sessions'), 'dir');
  ensureLink(join(runtimeHome, 'skills'), join(projectHome, 'skills'), 'dir');
  ensureLink(join(runtimeHome, 'config.toml'), projectConfig, 'file');

  const userAuth = join(userCodexHome, 'auth.json');
  if (existsSync(userAuth)) ensureLink(join(runtimeHome, 'auth.json'), userAuth, 'file');

  return runtimeHome;
}

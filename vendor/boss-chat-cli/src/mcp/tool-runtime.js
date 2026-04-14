import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));

function pushValueArg(args, name, value) {
  if (value === undefined || value === null || value === '') {
    return;
  }
  args.push(`--${name}`, String(value));
}

function pushBooleanArg(args, name, value) {
  if (value === true) {
    args.push(`--${name}`);
  }
}

function parseJsonFromStdout(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {}

  const lines = trimmed
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {}
  }
  return null;
}

function normalizeStartFrom(input) {
  const value = String(input || '').trim().toLowerCase();
  if (value === 'all') return 'all';
  return 'unread';
}

function normalizePositiveInt(input) {
  if (input === undefined || input === null || input === '') return null;
  const value = Number.parseInt(String(input), 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function buildCliArgs(command, input = {}) {
  const args = [String(command), '--json'];
  pushValueArg(args, 'profile', input.profile || 'default');
  pushBooleanArg(args, 'dry-run', input.dryRun);
  pushBooleanArg(args, 'no-state', input.noState);

  switch (command) {
    case 'start-run':
    case 'run': {
      pushValueArg(args, 'job', input.job);
      pushValueArg(args, 'start-from', normalizeStartFrom(input.startFrom));
      pushValueArg(args, 'criteria', input.criteria);

      const targetCount = normalizePositiveInt(input.targetCount);
      if (targetCount) {
        pushValueArg(args, 'targetCount', targetCount);
      }

      pushValueArg(args, 'baseurl', input.baseUrl);
      pushValueArg(args, 'apikey', input.apiKey);
      pushValueArg(args, 'model', input.model);

      const port = normalizePositiveInt(input.port);
      if (port) {
        pushValueArg(args, 'port', port);
      }

      if (typeof input.safePacing === 'boolean') {
        pushValueArg(args, 'safe-pacing', String(input.safePacing));
      }
      if (typeof input.batchRestEnabled === 'boolean') {
        pushValueArg(args, 'batch-rest', String(input.batchRestEnabled));
      }
      break;
    }
    case 'get-run':
    case 'pause-run':
    case 'resume-run':
    case 'cancel-run':
      pushValueArg(args, 'run-id', input.runId);
      break;
    default:
      break;
  }

  return args;
}

export async function runCliJsonCommand(command, input = {}) {
  const cliArgs = buildCliArgs(command, input);
  const cwd = String(input.cwd || process.cwd());

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...cliArgs], {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      resolve({
        ok: false,
        exitCode: -1,
        command,
        args: cliArgs,
        stdout,
        stderr,
        payload: {
          status: 'FAILED',
          error: {
            code: 'CLI_SPAWN_FAILED',
            message: error?.message || '无法启动 boss-chat CLI',
            retryable: true,
          },
        },
      });
    });

    child.on('close', (code) => {
      const exitCode = Number.isInteger(code) ? code : 1;
      const parsed = parseJsonFromStdout(stdout);

      if (parsed && typeof parsed === 'object') {
        resolve({
          ok: exitCode === 0 && parsed.status !== 'FAILED',
          exitCode,
          command,
          args: cliArgs,
          stdout,
          stderr,
          payload: parsed,
        });
        return;
      }

      if (exitCode === 0) {
        resolve({
          ok: true,
          exitCode,
          command,
          args: cliArgs,
          stdout,
          stderr,
          payload: {
            status: 'OK',
            message: String(stdout || '').trim() || `${command} 执行成功`,
          },
        });
        return;
      }

      resolve({
        ok: false,
        exitCode,
        command,
        args: cliArgs,
        stdout,
        stderr,
        payload: {
          status: 'FAILED',
          error: {
            code: 'CLI_EXECUTION_FAILED',
            message: String(stderr || stdout || '').trim() || `${command} 执行失败`,
            retryable: true,
          },
        },
      });
    });
  });
}


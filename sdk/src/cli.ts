#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from './index.ts';
import { validateDownloadMirrors } from './native/native-package.ts';
import { KernelRequestError, MergedForwardError } from './errors.ts';
import type { ClientOptions, LoginRequest } from './contracts/client.ts';

import { parse, prepareCommand, required, validateCommandFlags } from './cli/command-plan.ts';
import { runClientCommand, watchReconnectEnabled, watchEventMode } from './cli/client-command.ts';
export { parse, prepareCommand, normalizeMessage } from './cli/command-plan.ts';
export { observeWatchEvents, observeWatchFailures } from './cli/client-command.ts';

const usage = `qq-native-client <command> [options]
  init --config FILE --data-dir DIR [--catalog URL] [--download-mirror HTTPS_PREFIX]
       [--wrapper FILE | --manifest URL --manifest-sha256 HASH]
       [--client-version V --app-id ID --qua Q]
  config --config FILE                 Check and display configuration
  login --config FILE [--method qr|restore|quick] [--uin UIN] [--qr-file FILE]
  contacts --config FILE [--uin UIN]    Restore login and list friends
  friend-category-add --config FILE --name TEXT [--uin UIN]  Create an empty friend category
  friend-category-rename --config FILE --category-id UINT32 --name TEXT [--uin UIN]  Rename a friend category
  friend-categories --config FILE [--uin UIN]  List categorized friends
  groups --config FILE [--uin UIN]      Restore login and list groups
  members --config FILE --group-id ID [--uin UIN]
  history --config FILE --kind private|group --target ID [--limit 20] [--before MESSAGE_ID] [--uin UIN]
  message --config FILE --kind private|group --target ID --message-id ID
  messages --config FILE --kind private|group --target ID --message-ids ID,ID
  forward-history --config FILE --kind private|group --target ID --root-message-id ID [--parent-message-id ID]
  forward-resource --config FILE --resource-id ID [--uin UIN]
  forward --config FILE --source-kind private|group --source-target ID --kind private|group --target ID --message-ids ID,ID
  send-forward --config FILE --kind private|group --target ID --nodes-file FILE
       [--title TEXT --summary TEXT --prompt TEXT] [--uin UIN]
  watch --config FILE [--uin UIN] [--events message|all|normalized]  Print business events as JSON lines
  send --config FILE --kind private|group --target ID (--text TEXT | --message-file JSON) [--uin UIN]
  nickname --config FILE --name TEXT
  signature --config FILE --text TEXT   Empty text explicitly clears the signature
  profile --config FILE --target USER_ID
  requests --config FILE
  group-requests --config FILE [--doubt true|false] [--limit 20] [--before SEQUENCE]
  group-request --config FILE --group-id ID --sequence SEQUENCE --type 1|5|7 --accept true|false [--doubt true|false] [--reason TEXT]
  request --config FILE --uid UID --time SECONDS --accept true|false
  recall --config FILE --kind private|group --target ID --message-id ID
  download --config FILE --kind private|group --target ID --message-id ID --element-id ID --destination FILE
  friend-remark --config FILE --target USER_ID --remark TEXT
  friend-delete --config FILE --target USER_ID [--block true|false] [--both true|false]
  group-name --config FILE --group-id ID --name TEXT
  group-essence-list --config FILE --group-id ID [--page-start 0] [--page-limit 50]
  group-essence-all --config FILE --group-id ID [--max-pages 20]
  group-essence --config FILE --group-id ID --message-id ID --enabled true|false
  group-muted --config FILE --group-id ID
  group-info --config FILE --group-id ID
  group-search --config FILE --group-id ID
  group-file-count --config FILE --group-id ID
  group-folder-create --config FILE --group-id ID --name NAME
  group-folder-delete --config FILE --group-id ID --folder-id ID
  group-remark --config FILE --group-id ID --remark TEXT
  group-mute --config FILE --group-id ID --enabled true|false
  member-mute --config FILE --group-id ID --user-id ID --seconds SECONDS
  member-card --config FILE --group-id ID --user-id ID --card TEXT
  member-admin --config FILE --group-id ID --user-id ID --enabled true|false
  group-kick --config FILE --group-id ID --user-id ID [--reject-rejoin true|false] [--reason TEXT]
  group-notices --config FILE --group-id ID
  group-notice-publish --config FILE --group-id ID --text TEXT [--image FILE] [--pinned true|false] [--confirm-required true|false]
  group-notice-delete --config FILE --group-id ID --notice-id ID
  group-leave --config FILE --group-id ID
Account commands accept optional --uin UIN. Empty card/remark clears it.
Commands restore existing authorization unless login --method qr is explicit.
`;
function validateConfig(value: unknown): asserts value is ClientOptions {
  if (!value || typeof value !== 'object') throw new Error('Configuration must be a JSON object');
  const options = value as ClientOptions;
  if (!options.dataDir || typeof options.dataDir !== 'string')
    throw new Error('Configuration requires dataDir');
  if (options.wrapperPath && options.manifestUrl)
    throw new Error('Choose wrapperPath or manifestUrl');
  if (
    options.version &&
    ![options.version.clientVersion, options.version.appId, options.version.qua].every(
      (v) => typeof v === 'string' && !!v,
    )
  )
    throw new Error('Version requires complete metadata');
  if (options.catalogUrl) {
    const url = new URL(options.catalogUrl);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Catalog requires HTTPS without credentials');
  }
  validateDownloadMirrors(options.downloadMirrors);
  if (options.manifestUrl && !/^[a-f0-9]{64}$/i.test(options.manifestSha256 ?? ''))
    throw new Error('Mirror requires trusted manifestSha256');
}
async function main() {
  const { command, flags } = parse(process.argv.slice(2));
  if (!command || command === '--help' || flags.help) {
    console.log(usage);
    return;
  }
  validateCommandFlags(command, flags);
  const watchMode = command === 'watch' ? watchEventMode(flags.events) : undefined;
  const action = ['init', 'config', 'login', 'watch'].includes(command)
    ? undefined
    : await prepareCommand(command, flags);
  const configPath = resolve(required(flags, 'config'));
  if (command === 'init') {
    const options: ClientOptions = { dataDir: resolve(required(flags, 'data-dir')) };
    if (flags.wrapper) {
      options.wrapperPath = resolve(flags.wrapper);
    }
    if (['client-version', 'app-id', 'qua'].some((key) => flags[key] !== undefined)) {
      options.version = {
        clientVersion: required(flags, 'client-version'),
        appId: required(flags, 'app-id'),
        qua: required(flags, 'qua'),
      };
    }
    if (flags.manifest) {
      options.manifestUrl = flags.manifest;
      options.manifestSha256 = required(flags, 'manifest-sha256');
    }
    if (flags.catalog) options.catalogUrl = flags.catalog;
    if (flags['download-mirror']) options.downloadMirrors = [flags['download-mirror']];
    validateConfig(options);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(options, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(`Created ${configPath}`);
    return;
  }
  const options: unknown = JSON.parse(await readFile(configPath, 'utf8'));
  validateConfig(options);
  if (command === 'config') {
    console.log(JSON.stringify(options, null, 2));
    return;
  }
  let login: LoginRequest = { method: 'restore', ...(flags.uin ? { uin: flags.uin } : {}) };
  if (command === 'login') {
    const method = flags.method ?? 'restore';
    if (method === 'qr') login = { method: 'qr' };
    else if (method === 'quick') login = { method: 'quick', uin: required(flags, 'uin') };
    else if (method !== 'restore') throw new Error('--method must be qr, restore or quick');
  }
  if (command === 'watch') watchReconnectEnabled(options.autoReconnect);
  const client = await createClient({ ...options, login: undefined });
  await runClientCommand({
    client,
    command,
    login,
    autoReconnect: options.autoReconnect,
    watchMode,
    action,
    qrPath: resolve(flags['qr-file'] ?? `${configPath}.qrcode.png`),
    writeQr: (path, image) => writeFile(path, image, { mode: 0o600 }),
    output: (line) => console.log(line),
    report: (line) => console.error(line),
    signals: process,
    setExitCode(code) {
      process.exitCode = code;
    },
  });
}
export function formatCliError(error: unknown): string {
  const progress =
    error instanceof MergedForwardError
      ? { phase: error.phase, ...error.progress }
      : error instanceof KernelRequestError
        ? error.mergedForward
        : undefined;
  return progress
    ? JSON.stringify({
        error: error instanceof Error ? error.message : 'Merged-forward failed',
        mergedForward: progress,
        ...(typeof (error as KernelRequestError).code === 'string' ||
        typeof (error as KernelRequestError).code === 'number'
          ? { code: (error as KernelRequestError).code }
          : {}),
      })
    : error instanceof Error
      ? error.message
      : String(error);
}
let isCliEntry = false;
try {
  isCliEntry =
    !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  /* Imported modules and non-file argv entries do not execute the CLI. */
}
if (isCliEntry)
  void main().catch((error) => {
    console.error(formatCliError(error));
    if (process.exitCode !== 130) process.exitCode = 1;
  });

import { contactsCommands } from './commands/contacts.ts';
import { groupsCommands } from './commands/groups.ts';
import { messagesCommands } from './commands/messages.ts';
import type {
  ClientCommandAction,
  ClientCommandDefinition,
  CommandFlags,
} from './command-contracts.ts';

export { parse, required, numeric, bool, peer } from './command-input.ts';
export { normalizeMessage } from './commands/messages.ts';

type CommandDefinition =
  | { execution: 'entry'; flags: readonly string[] }
  | ({ execution: 'client' } & ClientCommandDefinition);

// Entry commands retain their configuration/login/watch lifecycle in cli.ts.
const entryCommands = {
  init: [
    'config',
    'data-dir',
    'wrapper',
    'client-version',
    'app-id',
    'qua',
    'manifest',
    'manifest-sha256',
    'catalog',
    'download-mirror',
  ],
  config: ['config'],
  prepare: ['config'],
  login: ['config', 'method', 'uin', 'qr-file'],
  watch: ['config', 'uin', 'events'],
};
const commands = new Map<string, CommandDefinition>(
  Object.entries(entryCommands).map(([name, flags]) => [name, { execution: 'entry', flags }]),
);
for (const domain of [contactsCommands, groupsCommands, messagesCommands]) {
  for (const [name, definition] of Object.entries(domain)) {
    if (commands.has(name)) throw new Error(`Duplicate CLI command definition: ${name}`);
    commands.set(name, { execution: 'client', ...definition });
  }
}
function definition(command: string): CommandDefinition {
  const found = commands.get(command);
  if (!found) throw new Error(`Unknown command: ${command}`);
  return found;
}

/** Checks command flags before configuration access or native client creation. */
export function validateCommandFlags(command: string, flags: CommandFlags): void {
  const selected = definition(command);
  for (const flag of Object.keys(flags))
    if (!selected.flags.includes(flag)) throw new Error(`Unknown option for ${command}: --${flag}`);
}

/** Entry commands are handled by the existing executable lifecycle owner. */
export function isEntryCommand(command: string): boolean {
  return definition(command).execution === 'entry';
}

/** Captures a plan before configuration/native acquisition; execution remains explicit. */
export async function prepareCommand(
  command: string,
  flags: CommandFlags,
): Promise<ClientCommandAction> {
  const selected = definition(command);
  if (selected.execution !== 'client') throw new Error(`Unknown command: ${command}`);
  return selected.prepare({ ...flags });
}

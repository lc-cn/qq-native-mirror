import type { QQClient } from '../index.ts';

export type CommandFlags = Record<string, string>;
export type ClientCommandAction = (client: QQClient) => Promise<unknown>;

/** A command owns its accepted flags and the plan captured before account acquisition. */
export interface ClientCommandDefinition {
  readonly flags: readonly string[];
  prepare(flags: CommandFlags): ClientCommandAction | Promise<ClientCommandAction>;
}

export const CLI_MODE_NAMES = ["interactive", "print", "json", "rpc"] as const;

export type CliMode = (typeof CLI_MODE_NAMES)[number];

export function isCliMode(value: string): value is CliMode {
  return CLI_MODE_NAMES.some((mode) => mode === value);
}

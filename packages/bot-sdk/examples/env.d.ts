// The examples read process.env and process.argv; the SDK itself needs no Node types.
declare const process: { env: Record<string, string | undefined>; argv: string[]; exitCode?: number };

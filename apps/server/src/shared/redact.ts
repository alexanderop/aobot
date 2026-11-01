/**
What may be recorded about something a Bot typed: its length, never its value. It may be a password.
Audit rows, logs and span attributes all go through this.
*/
export function redact(typed: string): string {
  return `[${typed.length} chars]`;
}

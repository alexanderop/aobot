import { Effect } from "effect";
import type { Computer } from "../computers.ts";

/** A {@link Computer} that answers as `answers` says and dies on anything else, so a test names all it uses. */
export function fakeComputer(answers: Partial<Computer>): Computer {
  const unused = (what: string) => () => Effect.die(`this test's computer has no ${what}`);

  return {
    browse: unused("browser"),
    run: unused("shell"),
    files: unused("workspace"),
    download: unused("downloads"),
    upload: unused("uploads"),
    input: unused("input"),
    ...answers,
  };
}

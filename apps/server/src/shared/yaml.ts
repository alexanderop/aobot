import { Result } from "effect";
import { parseDocument } from "yaml";

/**
A settings file's YAML as plain values, or the parser's first complaint. A file that holds nothing, or
only comments, is `the file is empty` rather than a value. `toJS` throws on a file that expands too far,
such as an alias bomb.
*/
export function parseYaml(text: string): Result.Result<unknown, string> {
  return Result.try({
    try: () => {
      const document = parseDocument(text);
      const [broken] = document.errors;

      if (broken !== undefined) throw broken;

      return document.toJS();
    },
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  }).pipe(
    Result.flatMap((contents) =>
      contents === null || contents === undefined
        ? Result.fail("the file is empty")
        : Result.succeed(contents),
    ),
  );
}

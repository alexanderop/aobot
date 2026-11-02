import { Result } from "effect";
import { parseDocument } from "yaml";

/**
A settings file's YAML as plain values, or the parser's first complaint. `toJS` throws on a file that
expands too far, such as an alias bomb.
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
  });
}

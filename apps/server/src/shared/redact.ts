import { Predicate, Schema } from "effect";

/**
What may be recorded about something a Bot typed: its length, never its value. It may be a password.
Audit rows, logs and span attributes all go through this.
*/
export function redact(typed: string): string {
  return `[${typed.length} chars]`;
}

/**
`name=value` pairs, joined by `&`, with the value of each pair `secret` names redacted. A part without
`=` is all value, so it is redacted when `secret` names `""`.
*/
function redactPairs(pairs: string, secret: (name: string) => boolean): string {
  return pairs
    .split("&")
    .map((pair) => {
      const equals = pair.indexOf("=");

      if (equals === -1) return pair === "" || !secret("") ? pair : redact(pair);

      const name = pair.slice(0, equals);

      return secret(name) ? `${name}=${redact(pair.slice(equals + 1))}` : pair;
    })
    .join("&");
}

/** `scheme://userinfo@host…` with its userinfo redacted, as written, up to the end of the authority. */
function redactWrittenUserinfo(base: string): string {
  const scheme = base.indexOf("://");

  if (scheme === -1) return base;

  const authorityStart = scheme + 3;
  const slash = base.indexOf("/", authorityStart);
  const authority = base.slice(authorityStart, slash === -1 ? undefined : slash);
  const at = authority.lastIndexOf("@");

  if (at === -1) return base;

  return `${base.slice(0, authorityStart)}${redact(authority.slice(0, at))}${base.slice(authorityStart + at)}`;
}

/**
`base` with its userinfo redacted. A browser also reads userinfo in an address not written
`scheme://`, such as `https:/ada:pw@h.example`, `https:\\ada:pw@h.example` or `HTTPS:ada:pw@h.example`, so
when the text shows none but the browser's own parse finds one, the address is recorded as parsed.
*/
function redactUserinfo(base: string): string {
  const written = redactWrittenUserinfo(base);

  if (written !== base) return written;

  const parsed = URL.parse(base);

  if (parsed === null || (parsed.username === "" && parsed.password === "")) return base;

  const userinfo =
    parsed.password === "" ? parsed.username : `${parsed.username}:${parsed.password}`;

  return `${parsed.protocol}//${redact(userinfo)}@${parsed.host}${parsed.pathname}`;
}

/** `url` with its userinfo, the fragment, and the value of each query parameter `secret` names redacted. */
function redactAddress(url: string, secret: (name: string) => boolean): string {
  const hash = url.indexOf("#");
  const beforeHash = hash === -1 ? url : url.slice(0, hash);
  const question = beforeHash.indexOf("?");
  const base = question === -1 ? beforeHash : beforeHash.slice(0, question);

  return [
    redactUserinfo(base),
    question === -1 ? "" : `?${redactPairs(beforeHash.slice(question + 1), secret)}`,
    hash === -1 ? "" : `#${redactPairs(url.slice(hash + 1), () => true)}`,
  ].join("");
}

/**
An address as it may be recorded: the value of every query parameter and the fragment become
`[N chars]`, whatever they are called, so `?token=`, `?q=` and `#access_token=` keep their names and lose
their values, and so does the userinfo of `https://user:pass@host`. It reads the text as written, so the
row keeps the spelling the Bot used, and an address that does not parse is redacted all the same. Only
the computer is ever sent the address itself.
*/
export function redactUrl(url: string): string {
  return redactAddress(url, () => true);
}

/**
An address as the model and the transcript are shown it: like {@link redactUrl}, but a query parameter
keeps its value unless its name holds a credential word, so `?page=2` still says which page it is. A
page's address can hold what was typed into it, such as a form sent by GET or an OAuth redirect's
`#access_token=…`.
*/
export function redactUrlSecrets(url: string): string {
  return redactAddress(url, isSensitiveKey);
}

/**
An address inside free text, from its scheme to the first space or quote. The scheme's length is bounded,
so text of dots such as `a.a.a.…` costs each position a few steps, not the rest of the text.
*/
const urlInText = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>`]+/giu;

/** `text` with every address in it redacted as {@link redactUrl} does. */
function redactUrlsIn(text: string): string {
  return text.replaceAll(urlInText, redactUrl);
}

/** A key in one spelling: `toolResult`, `tool_result`, `tool-result` and `Tool.Result` are all `toolresult`. */
function spelling(key: string): string {
  return key.toLowerCase().replaceAll(/[-_.\s]/gu, "");
}

/**
Keys whose whole value is what a Bot typed, a tool's input or output, or a request's body, in any
spelling. Matched as the whole key, since `text` also ends `context`.
*/
const sensitiveKeys: ReadonlySet<string> = new Set([
  "text",
  "value",
  "content",
  "contents",
  "body",
  "input",
  "output",
  "result",
  "prompt",
  "parameters",
  "params",
  "arguments",
  "args",
  "toolinput",
  "tooloutput",
  "toolresult",
  "toolparameters",
  "toolarguments",
]);

/**
Endings that mark a key as holding a credential, in any spelling: `accessToken`, `x-api-key`,
`DB_PASSWORD`, `MYSQL_PWD`, `http.request.header.authorization`. An ending, not a part, so `input_tokens`
stays a count.
*/
const sensitiveEndings: ReadonlyArray<string> = [
  "password",
  "passwd",
  "pass",
  "pwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "accesskey",
  "privatekey",
  "auth",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "sessionid",
  "bearer",
];

/** Whether `key` names a credential, by its ending, in any spelling of it. */
function isCredentialKey(key: string): boolean {
  const spelt = spelling(key);

  return sensitiveEndings.some((ending) => spelt.endsWith(ending));
}

/** Whether a value recorded under `key` may hold a secret or something a Bot typed, in any spelling of it. */
export function isSensitiveKey(key: string): boolean {
  return sensitiveKeys.has(spelling(key)) || isCredentialKey(key);
}

const isJsonObject = Schema.is(Schema.JsonObject);

/** A value that may hold a secret, as its length only, whatever its shape. */
function redactValue(value: Schema.Json): string {
  return Predicate.isString(value) ? redact(value) : redact(JSON.stringify(value));
}

/**
The value recorded under `key`: its length only when the key may hold a secret, in any spelling of it,
and otherwise {@link redactFields} of it.
*/
export function redactField(key: string, value: Schema.Json): Schema.Json {
  return isSensitiveKey(key) ? redactValue(value) : redactFields(value);
}

/**
`value` with everything under a {@link isSensitiveKey} key replaced by its length, at any depth, and every
address in its text redacted. For structured data whose keys we did not choose, such as the attributes a
library writes onto a span. A filter: a secret under a harmless key, in text that is no address, passes.
*/
export function redactFields(value: Schema.Json): Schema.Json {
  if (Predicate.isString(value)) return redactUrlsIn(value);

  if (Array.isArray(value)) return value.map(redactFields);

  if (!isJsonObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, redactField(key, field)]),
  );
}

/**
A value as a shell word: quoted, or up to the next space, operator, redirect or quote, so the quote that
closes the word around it, as in `-m 'fix: token=abc'`, stays. One already redacted is skipped.
*/
const word = String.raw`(?!\[\d+ chars\])("[^"]*"|'[^']*'|[^\s;&|<>"']+)`;

/** A `NAME=value` assignment whose name may hold a secret: `API_TOKEN=abc`, `export PASSWORD="x y"`. */
const assignment = new RegExp(String.raw`(?<![-\w])([A-Za-z_]\w*)=${word}`, "gu");

/**
A flag and its value, after `=` or a space: `--password=x`, `--token x`, `--api-key 'x'`. A `--no-` flag
is a switch, so what follows it is no value of it.
*/
const flag = new RegExp(String.raw`(--?[A-Za-z][A-Za-z0-9-]{0,63})(=|\s+)${word}`, "gu");

/** A header given to curl and the like: `-H "Authorization: Bearer x"`, `--header='X-Api-Key: x'`. */
const header = /(-H|--header)(=|\s*)(["'])([A-Za-z0-9-]+):([^"'\n]*)\3/gu;

/** A header written as one unquoted word: `-H Authorization:x`, `--header=Cookie:sid=1`. */
const bareHeader = /(-H|--header)(=|\s+)([A-Za-z0-9-]+):([^\s"'<>]+)/gu;

/** A JSON string under a key, as in `-d '{"password":"x"}'`. One already redacted is skipped. */
const jsonField = /"([A-Za-z0-9_.-]{1,64})"(\s*:\s*)"(?!\[\d+ chars\]")((?:[^"\\]|\\.)*)"/gu;

/**
`-p` and a password, only after a command whose `-p` is one: `mysql -phunter2` (attached, since a bare
`-p` asks for it), `docker login -p x`, `sshpass -p x`. After any other command `-p` is no password, as in
`mkdir -p dir` or `ssh -p 22`. The words between the command and its `-p` are bounded.
*/
const passwordP: ReadonlyArray<RegExp> = [
  String.raw`(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^;&|\n]{0,1000}?\s-p)`,
  String.raw`(\b(?:docker|podman)\s+login\b[^;&|\n]{0,1000}?\s-p(?:=|\s+))`,
  String.raw`(\bsshpass\s+-p\s*)`,
].map((command) => new RegExp(`${command}${word}`, "gu"));

/**
The password of `user:pass` after curl's or wget's `-u`, `--user`, `-U` or `--proxy-user`. After any other
command `-u` is no password, as in `docker run -u 1000:1000`. The words between the command and its flag
are bounded.
*/
const userFlag =
  /(\b(?:curl|wget)\b[^;&|\n]{0,1000}?\s(?:-u|--user|-U|--proxy-user)(?:\s+|=))(["']?)([^\s:"']{1,256}):([^\s"']+)\2/gu;

/** A bearer token written out anywhere, such as in a header curl is not handed with `-H`. */
const bearer = /\b(bearer\s+)(?!\[\d+ chars\])([^\s"']+)/giu;

/** A shell word redacted, inside its quotes when it has them. */
function redactWord(value: string): string {
  const quote = value[0];

  return quote === '"' || quote === "'"
    ? `${quote}${redact(value.slice(1, -1))}${quote}`
    : redact(value);
}

/** A header's value after its colon, redacted, keeping the space before it. */
function redactHeaderValue(value: string): string {
  const kept = value.trimStart();

  return `${value.slice(0, value.length - kept.length)}${redact(kept)}`;
}

/**
How a command is redacted, one pattern at a time, in order: addresses first, then each pattern skips a
value an earlier one redacted. No pattern nests quantifiers, and a name that can start anywhere is
bounded in length, since the server runs them on its one thread.
*/
const commandRedactions: ReadonlyArray<(command: string) => string> = [
  redactUrlsIn,
  (command) =>
    command.replaceAll(
      header,
      (whole, name: string, space: string, quote: string, field: string, value: string) =>
        isCredentialKey(field)
          ? `${name}${space}${quote}${field}:${redactHeaderValue(value)}${quote}`
          : whole,
    ),
  (command) =>
    command.replaceAll(bareHeader, (whole, name: string, between: string, field: string, value) =>
      isCredentialKey(field) ? `${name}${between}${field}:${redact(value)}` : whole,
    ),
  (command) =>
    command.replaceAll(jsonField, (whole, key: string, colon: string, value: string) =>
      isCredentialKey(key) ? `"${key}"${colon}"${redact(value)}"` : whole,
    ),
  (command) =>
    command.replaceAll(
      userFlag,
      (_whole, before: string, quote: string, user: string, password: string) =>
        `${before}${quote}${user}:${redact(password)}${quote}`,
    ),
  (command) =>
    command.replaceAll(assignment, (whole, name: string, value: string) =>
      isCredentialKey(name) ? `${name}=${redactWord(value)}` : whole,
    ),
  (command) =>
    command.replaceAll(flag, (whole, name: string, between: string, value: string) =>
      isCredentialKey(name) && !name.startsWith("--no-")
        ? `${name}${between}${redactWord(value)}`
        : whole,
    ),
  ...passwordP.map(
    (pattern) => (command: string) =>
      command.replaceAll(
        pattern,
        (_whole, before: string, value: string) => `${before}${redactWord(value)}`,
      ),
  ),
  (command) =>
    command.replaceAll(
      bearer,
      (_whole, scheme: string, token: string) => `${scheme}${redact(token)}`,
    ),
];

/**
A command as its audit row keeps it: as written, except that a secret in it becomes `[N chars]`. That is
the value of an assignment, a flag or a JSON field whose name ends in a credential word (`API_TOKEN=abc`,
`--password=x`, `--token x`, `"password":"x"`), a credential header (`-H "Authorization: Bearer x"`),
the password of `curl -u user:pass` and of `-p` where `mysql`, `docker login` or `sshpass` read it, a
bearer token, and the userinfo, query values and fragment of every address written `scheme://` in it.
A name such as `--output`, `--body` or `TEXT` names no credential, so its value stays.
Matching a command's text is a filter, not a boundary: a secret written some other way, such as
`echo hunter2 | login`, stays in the row.
*/
export function redactCommand(command: string): string {
  return commandRedactions.reduce((redacted, redaction) => redaction(redacted), command);
}

const utf8 = new TextEncoder();

/**
Does the token a caller offered match the one expected? Compares UTF-8 bytes in time that depends only on
their length, so a wrong guess reveals nothing about how much of it was right. Any string is a valid
input: a header with non-ASCII characters is simply a mismatch. An empty expected token matches nothing.

Written without `node:crypto` because this package also runs in the web page and the desktop app.
*/
export function tokensMatch(expected: string, offered: string): boolean {
  const want = utf8.encode(expected);
  const got = utf8.encode(offered);

  if (want.length === 0 || want.length !== got.length) return false;

  let difference = 0;

  for (const [index, byte] of want.entries()) difference |= byte ^ (got[index] ?? 0);

  return difference === 0;
}

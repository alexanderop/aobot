import { describe, expect, it } from "vite-plus/test";
import {
  isSensitiveKey,
  redact,
  redactCommand,
  redactField,
  redactFields,
  redactUrl,
  redactUrlSecrets,
} from "./redact.ts";

describe("redact", () => {
  it("keeps the length of what a Bot typed and nothing of its value", () => {
    expect(redact("cat /etc/passwd")).toBe("[15 chars]");
    expect(redact("hunter2-secret")).toBe("[14 chars]");
    expect(redact("")).toBe("[0 chars]");
  });
});

describe("redactUrl", () => {
  it.each([
    ["https://shop.example/cart", "https://shop.example/cart"],
    ["https://shop.example/?access_token=abc", "https://shop.example/?access_token=[3 chars]"],
    ["https://shop.example/?q=x&token=abcd", "https://shop.example/?q=[1 chars]&token=[4 chars]"],
    ["https://shop.example/?sig", "https://shop.example/?[3 chars]"],
    ["https://shop.example/?a=&b", "https://shop.example/?a=[0 chars]&[1 chars]"],
    [
      "https://shop.example/cb#access_token=abc&state=xy",
      "https://shop.example/cb#access_token=[3 chars]&state=[2 chars]",
    ],
    ["https://shop.example/docs#install", "https://shop.example/docs#[7 chars]"],
    ["https://shop.example/#", "https://shop.example/#"],
    ["https://ada:hunter2@shop.example/x", "https://[11 chars]@shop.example/x"],
    ["https://ada@shop.example", "https://[3 chars]@shop.example"],
    ["shop.example/?token=abc", "shop.example/?token=[3 chars]"],
    ["http://[::1]:8080/?k=v#f", "http://[::1]:8080/?k=[1 chars]#[1 chars]"],
    ["https:/ada:hunter2@h.example/x", "https://[11 chars]@h.example/x"],
    [String.raw`https:\\ada:hunter2@h.example\x`, "https://[11 chars]@h.example/x"],
    ["HTTPS:ada:hunter2@h.example/x?q=1", "https://[11 chars]@h.example/x?q=[1 chars]"],
    ["https:ada@h.example", "https://[3 chars]@h.example/"],
    ["mailto:ada@h.example", "mailto:ada@h.example"],
  ])("records %s as %s", (url, recorded) => {
    expect(redactUrl(url)).toBe(recorded);
  });
});

describe("redactUrlSecrets", () => {
  it.each([
    ["https://shop.example/list?page=2&q=cats", "https://shop.example/list?page=2&q=cats"],
    [
      "https://shop.example/login?user=ada&password=hunter2",
      "https://shop.example/login?user=ada&password=[7 chars]",
    ],
    ["https://shop.example/?print", "https://shop.example/?print"],
    [
      "https://shop.example/cb#access_token=abc&state=xy",
      "https://shop.example/cb#access_token=[3 chars]&state=[2 chars]",
    ],
    ["https://ada:pw@shop.example/", "https://[6 chars]@shop.example/"],
  ])("shows the model %s as %s", (url, shown) => {
    expect(redactUrlSecrets(url)).toBe(shown);
  });
});

describe("isSensitiveKey", () => {
  it.each([
    "toolResult",
    "tool_result",
    "tool-result",
    "ToolResult",
    "TOOL.RESULT",
    "parameters",
    "text",
    "password",
    "userPassword",
    "DB_PASSWORD",
    "accessToken",
    "access_token",
    "x-api-key",
    "apiKey",
    "AWS_SECRET_ACCESS_KEY",
    "http.request.header.authorization",
    "Set-Cookie",
    "client_secret",
    "PASS",
    "DB_PASS",
    "MYSQL_PWD",
    "oauth2-bearer",
  ])("reads %s as one that may hold a secret", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    "command",
    "url",
    "ref",
    "role",
    "name",
    "host",
    "path",
    "field",
    "context",
    "gen_ai.usage.input_tokens",
    "gateway.action",
    "gateway.file_bytes",
    "tokenCount",
  ])("keeps %s, which the audit page and the traces read", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe("redactFields", () => {
  it("keeps only the length under a sensitive key, in any spelling and at any depth", () => {
    expect(
      redactFields({
        tool: "type",
        toolResult: "the page",
        tool_result: { ok: true },
        nested: [{ password: "hunter2", host: "shop.example" }],
        count: 3,
      }),
    ).toEqual({
      tool: "type",
      toolResult: "[8 chars]",
      tool_result: "[11 chars]",
      nested: [{ password: "[7 chars]", host: "shop.example" }],
      count: 3,
    });
  });

  it("treats one field as redactFields treats it inside an object", () => {
    expect(redactField("password", { nested: "x" })).toBe("[14 chars]");
    expect(redactField("url", "https://x.example/?code=1234")).toBe(
      "https://x.example/?code=[4 chars]",
    );
  });

  it("redacts the addresses in text under any key", () => {
    expect(redactFields({ "url.full": "https://x.example/?code=1234" })).toEqual({
      "url.full": "https://x.example/?code=[4 chars]",
    });
  });
});

describe("redactCommand", () => {
  it.each([
    ["ls -la /workspace", "ls -la /workspace"],
    ["rm -rf /tmp/x", "rm -rf /tmp/x"],
    ["API_TOKEN=abc ./deploy.sh", "API_TOKEN=[3 chars] ./deploy.sh"],
    ["export PASSWORD=hunter2", "export PASSWORD=[7 chars]"],
    ['export DB_PASSWORD="two words"', 'export DB_PASSWORD="[9 chars]"'],
    ["NODE_ENV=production npm start", "NODE_ENV=production npm start"],
    ["mysql --password=hunter2 shop", "mysql --password=[7 chars] shop"],
    ["gh auth login --token abc123", "gh auth login --token [6 chars]"],
    ["tool --api-key 'k-1'", "tool --api-key '[3 chars]'"],
    [
      'curl -H "Authorization: Bearer abc.def" https://api.example/',
      'curl -H "Authorization: [14 chars]" https://api.example/',
    ],
    ["curl --header 'X-Api-Key: k1' x", "curl --header 'X-Api-Key: [2 chars]' x"],
    ['curl -H "Accept: text/html" x', 'curl -H "Accept: text/html" x'],
    ["curl -u ada:hunter2 https://x.example", "curl -u ada:[7 chars] https://x.example"],
    ['curl -H"Cookie: sid=abc" x', 'curl -H"Cookie: [7 chars]" x'],
    [
      "curl https://ada:pw@x.example/a?token=abc#frag",
      "curl https://[6 chars]@x.example/a?token=[3 chars]#[4 chars]",
    ],
    ['curl "https://x.example/?q=cats"', 'curl "https://x.example/?q=[4 chars]"'],
    ["PASS=hunter2 ./login", "PASS=[7 chars] ./login"],
    ["DB_PASS=hunter2 MYSQL_PWD=pw mysql", "DB_PASS=[7 chars] MYSQL_PWD=[2 chars] mysql"],
    ['curl -H "authorization: bearer abc" x', 'curl -H "authorization: [10 chars]" x'],
    ["echo bearer abc", "echo bearer [3 chars]"],
    ["curl --oauth2-bearer abc x", "curl --oauth2-bearer [3 chars] x"],
    ["curl --header=Authorization:abc x", "curl --header=Authorization:[3 chars] x"],
    ["curl -H Cookie:sid=abc x", "curl -H Cookie:[7 chars] x"],
    ["curl --header='X-Api-Key: k1' x", "curl --header='X-Api-Key: [2 chars]' x"],
    [
      `curl -d '{"user":"ada","password":"hun\\"ter2"}' x`,
      `curl -d '{"user":"ada","password":"[9 chars]"}' x`,
    ],
    ['curl -d \'{"password": "x"}\' x', 'curl -d \'{"password": "[1 chars]"}\' x'],
    ["mysql -u root -phunter2 shop", "mysql -u root -p[7 chars] shop"],
    ["mysql -u root -p shop", "mysql -u root -p shop"],
    ["docker login -u ada -p hunter2 ghcr.io", "docker login -u ada -p [7 chars] ghcr.io"],
    ["sshpass -p hunter2 ssh h", "sshpass -p [7 chars] ssh h"],
    ["mkdir -p dir && ssh -p 22 h", "mkdir -p dir && ssh -p 22 h"],
    ["gh auth login --with-token < t", "gh auth login --with-token < t"],
    ["x --no-auth y", "x --no-auth y"],
    [
      "curl -d 'password=hunter2' https://x.example/",
      "curl -d 'password=[7 chars]' https://x.example/",
    ],
    ["git commit -m 'fix: token=abc'", "git commit -m 'fix: token=[3 chars]'"],
    ['git commit -m "token=abc"', 'git commit -m "token=[3 chars]"'],
    ["TOKEN=abc>out", "TOKEN=[3 chars]>out"],
    ["OUTPUT=dist npm run build", "OUTPUT=dist npm run build"],
    ["TEXT=hi ./x", "TEXT=hi ./x"],
    [
      "curl --output report.pdf https://x.example/r",
      "curl --output report.pdf https://x.example/r",
    ],
    ["gh pr create --title fix --body done", "gh pr create --title fix --body done"],
    ["ffmpeg -i in.mp4 --text hello", "ffmpeg -i in.mp4 --text hello"],
    ["npm test -- --input fixtures/a.json", "npm test -- --input fixtures/a.json"],
    [`curl -d '{"text":"hello"}' x`, `curl -d '{"text":"hello"}' x`],
    ["docker run -u 1000:1000 img", "docker run -u 1000:1000 img"],
    ["curl -s --user ada:hunter2 x", "curl -s --user ada:[7 chars] x"],
    ["curl --proxy-user ada:pw -x p x", "curl --proxy-user ada:[2 chars] -x p x"],
    ["wget --user=ada:pw x", "wget --user=ada:[2 chars] x"],
  ])("records %s as %s", (command, recorded) => {
    expect(redactCommand(command)).toBe(recorded);
  });

  it("redacts a secret once when two patterns name it", () => {
    expect(redactCommand("PASSWORD=x mysql --password=y https://h/?password=z")).toBe(
      "PASSWORD=[1 chars] mysql --password=[1 chars] https://h/?password=[1 chars]",
    );
  });

  it("stays fast on a long command that almost matches", () => {
    const started = performance.now();
    redactCommand(`-H "Authorization:${" ".repeat(50_000)}`);
    redactCommand(`--token${" ".repeat(50_000)}`);
    redactCommand(`${"a".repeat(50_000)}=`);
    redactCommand("a.".repeat(25_000));
    redactCommand("-a".repeat(25_000));
    redactCommand("-u=a".repeat(12_500));
    redactCommand(`"a":"${"x".repeat(50_000)}`);
    redactCommand(`mysql ${"a ".repeat(25_000)}`);
    redactCommand("mysql ".repeat(10_000));
    redactCommand("curl ".repeat(10_000));

    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

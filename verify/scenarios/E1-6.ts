import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { ModelStep } from "../../apps/server/src/features/agent/testing/model-script.ts";
import { assert, browser, evaluate, waitFor } from "../browser.ts";
import {
  answers,
  ask,
  auditRows,
  cardResult,
  doneCards,
  failedCards,
  modelRequests,
  script,
} from "../chat.ts";
import { attribute, traceSpans } from "../tempo.ts";

const expenses = "date,item,amount\n2026-10-01,Train,12.50\n2026-10-02,Lunch,7.50\n";

const totalled = `${expenses}total,,20.00\n`;

const bytes = (text: string) => Buffer.byteLength(text);

const FileDetail = Schema.fromJsonString(
  Schema.Struct({
    path: Schema.String,
    name: Schema.String,
    extension: Schema.String,
    bytes: Schema.optionalKey(Schema.Number),
    reason: Schema.optionalKey(Schema.String),
  }),
);

const decodeDetail = Schema.decodeUnknownSync(FileDetail);

/** The status the server answers a `GET` of `url` sent with exactly `headers`, which `fetch` cannot set. */
function answered(url: string, headers: Record<string, string>) {
  return new Promise<{ readonly status: number }>((resolve, reject) => {
    const sent = request(url, { headers });

    sent.on("response", (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0 });
    });
    sent.on("error", reject);
    sent.end();
  });
}

/** Every audit row as `action · decision`, oldest first. */
function trail(): ReadonlyArray<string> {
  return auditRows().map((row) => `${row.action} · ${row.decision}`);
}

/**
E1-6: the person attaches expenses.csv in the composer, which uploads it into the Bot's workspace, and
asks for a total row saved as expenses-total.csv. The Bot reads the file, saves the new one, and a chip
under its answer downloads exactly what it saved. Asked to read /etc/passwd, it is refused. The upload,
the write with its path and size, the download and the refusal are each in the audit trail, and the
write's span carries the file's size.
*/
export default async function scenario(baseUrl: string, grafanaUrl: string): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "aobot-verify-e1-6-"));
  const picked = join(folder, "expenses.csv");
  writeFileSync(picked, expenses);

  await script([
    ModelStep.CallTools({ calls: [{ name: "read_file", params: { path: "expenses.csv" } }] }),
    ModelStep.CallTools({
      calls: [{ name: "write_file", params: { path: "expenses-total.csv", contents: totalled } }],
    }),
    ModelStep.Say({
      words: ["I", " saved", " expenses-total.csv", " with", " a", " total", " row."],
    }),
  ]);

  browser("open", baseUrl);
  browser("wait", "--load", "networkidle");
  browser("upload", 'input[type="file"]', picked);

  await waitFor("expenses.csv to reach the workspace", 60_000, () =>
    evaluate(
      Schema.Boolean,
      `document.querySelector('.attachment[data-status="ready"] .attachment__name')?.textContent === "expenses.csv"`,
    ),
  );

  await ask(
    "Add a total row and save it as expenses-total.csv.",
    0,
    "I saved expenses-total.csv with a total row.",
  );

  await waitFor(
    "the read_file and write_file cards to be done",
    10_000,
    () => doneCards("read_file") === 1 && doneCards("write_file") === 1,
  );

  const seen = await modelRequests();
  assert(
    seen[0]?.includes("I put expenses.csv in your workspace.") === true,
    "the message told the model the file is in its workspace",
  );
  assert(
    seen.some(
      (request) =>
        request.includes('source=\\"file contents\\"') && request.includes("2026-10-02,Lunch,7.50"),
    ),
    "the model read expenses.csv as untrusted file contents",
  );
  assert(
    cardResult("read_file").includes("2026-10-01,Train,12.50"),
    "the read_file card shows what it read",
  );

  const chip = evaluate(
    Schema.Struct({ href: Schema.String, download: Schema.String, text: Schema.String }),
    `(() => { const chip = document.querySelector('.tool-call[data-tool="write_file"] a.file-chip'); return chip && { href: chip.getAttribute("href"), download: chip.getAttribute("download"), text: chip.textContent }; })()`,
  );

  assert(
    chip.text === "expenses-total.csv" &&
      chip.href === "/files?path=expenses-total.csv" &&
      chip.download === "",
    `the write_file card holds a file chip naming expenses-total.csv (${JSON.stringify(chip)})`,
  );

  const downloaded = join(folder, "downloaded.csv");
  browser("download", '.tool-call[data-tool="write_file"] a.file-chip', downloaded);

  const received = readFileSync(downloaded);
  assert(
    received.equals(Buffer.from(totalled)),
    `the download is exactly the file the Bot saved, total row and all (${JSON.stringify(received.toString())})`,
  );
  assert(received.toString().endsWith("total,,20.00\n"), "the total row is there");

  // Refused before the gateway, so it adds no row to the trail below.
  const rebound = await answered(new URL(chip.href, baseUrl).href, {
    host: `evil.example:${new URL(baseUrl).port}`,
    "sec-fetch-site": "same-origin",
  });

  assert(
    rebound.status === 403,
    `the server refuses a page at another name that points at it, though it sends no Origin (${rebound.status})`,
  );

  await script([
    ModelStep.CallTools({ calls: [{ name: "read_file", params: { path: "/etc/passwd" } }] }),
    ModelStep.Say({ words: ["That", " file", " is", " outside", " my", " workspace."] }),
  ]);

  await ask("Read /etc/passwd with read_file.", 1, "That file is outside my workspace.");
  await waitFor("the refused read_file card", 10_000, () => failedCards("read_file") === 1);

  assert(
    (await modelRequests()).some((request) =>
      request.includes("/etc/passwd is outside your workspace"),
    ),
    "the model was told /etc/passwd is outside its workspace",
  );
  assert(
    !(await modelRequests()).some((request) => request.includes("root:x:0:0")),
    "no line of /etc/passwd reached the model",
  );

  await waitFor("the download's outcome row", 10_000, () =>
    trail().includes("file.downloaded · succeeded"),
  );

  const rows = auditRows();
  assert(
    JSON.stringify(trail()) ===
      JSON.stringify([
        "file.uploaded · allow",
        "file.uploaded · succeeded",
        "read_file · allow",
        "read_file · succeeded",
        "write_file · allow",
        "write_file · succeeded",
        "file.downloaded · allow",
        "file.downloaded · succeeded",
        "read_file · deny",
      ]),
    `the audit trail holds the upload, the read, the write, the download and the refusal (${JSON.stringify(trail())})`,
  );

  const detailOf = (action: string, decision: string) =>
    decodeDetail(rows.find((row) => row.action === action && row.decision === decision)?.detail);

  const uploaded = detailOf("file.uploaded", "allow");
  assert(
    uploaded.path === "expenses.csv" && uploaded.bytes === bytes(expenses),
    `file.uploaded · allow holds the path and size (${JSON.stringify(uploaded)})`,
  );

  const written = detailOf("write_file", "allow");
  assert(
    written.path === "expenses-total.csv" &&
      written.extension === "csv" &&
      written.bytes === bytes(totalled),
    `write_file · allow holds the path and size (${JSON.stringify(written)})`,
  );
  assert(
    !rows.some((row) => row.detail.includes("total,,20.00") || row.detail.includes("Train")),
    "no audit row holds what a file holds",
  );

  const refused = detailOf("read_file", "deny");
  assert(
    refused.path === "/etc/passwd" && refused.reason === "outside workspace",
    `read_file · deny says /etc/passwd is outside the workspace (${JSON.stringify(refused)})`,
  );

  const traceId = rows.find((row) => row.action === "write_file")?.trace_id ?? "";
  assert(traceId !== "", "the write_file row carries the turn's trace_id");

  let spans: Awaited<ReturnType<typeof traceSpans>> = [];

  await waitFor("the write_file Gateway.act span in Tempo", 60_000, async () => {
    spans = await traceSpans(grafanaUrl, traceId).catch(() => []);

    return spans.some(
      (span) => span.name === "Gateway.act" && attribute(span, "gateway.action") === "write_file",
    );
  });

  const write = spans.find(
    (span) => span.name === "Gateway.act" && attribute(span, "gateway.action") === "write_file",
  );

  assert(
    write !== undefined && attribute(write, "gateway.file_bytes") === String(bytes(totalled)),
    `the write_file span records the file's size (${JSON.stringify(write?.attributes)})`,
  );
  assert(!JSON.stringify(spans).includes("total,,20.00"), "no span holds what the file holds");

  assert(answers()[1] === "That file is outside my workspace.", "the Bot said it was refused");
}

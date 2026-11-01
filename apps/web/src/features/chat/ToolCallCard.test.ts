import { describe, expect, it } from "vite-plus/test";
import { ToolCallId } from "@aobot/domain";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCallCard } from "./ToolCallCard.tsx";
import { ToolCallStatus } from "./conversation-state.ts";
import type { ToolCall } from "./conversation-state.ts";

const call = (name: string, args: string, status: ToolCallStatus): ToolCall => ({
  id: ToolCallId.make("call-1"),
  name,
  args,
  status,
});

const draw = (toolCall: ToolCall) =>
  renderToStaticMarkup(createElement(ToolCallCard, { call: toolCall }));

describe("ToolCallCard", () => {
  it("says which page navigate opened once it is done", () => {
    const html = draw(
      call("navigate", '{"url":"https://example.com"}', ToolCallStatus.Done({ result: "ok" })),
    );

    expect(html).toContain('data-tool="navigate"');
    expect(html).toContain("Opened https://example.com");
  });

  it("says navigate could not open the page when it failed, and marks the card failed", () => {
    const html = draw(
      call(
        "navigate",
        '{"url":"https://example.com"}',
        ToolCallStatus.Failed({ result: "The computer is not available." }),
      ),
    );

    expect(html).toContain('data-status="failed"');
    expect(html).toContain("Could not open https://example.com");
    expect(html).not.toContain("Opened");
  });

  it("says snapshot could not read the page when it failed", () => {
    const html = draw(
      call("snapshot", "{}", ToolCallStatus.Failed({ result: "No page is open." })),
    );

    expect(html).toContain('data-status="failed"');
    expect(html).toContain("Could not read the page");
  });

  it("says a tool it has no renderer for failed, with why", () => {
    const html = draw(
      call("scroll", '{"ref":"e3"}', ToolCallStatus.Failed({ result: "No element e3." })),
    );

    expect(html).toContain('data-status="failed"');
    expect(html).toContain("scroll failed");
    expect(html).toMatch(/<details[^>]*>.*No element e3\..*<\/details>/s);
  });

  it("shows navigate as still opening while it runs", () => {
    expect(
      draw(call("navigate", '{"url":"https://example.com"}', ToolCallStatus.Running())),
    ).toContain("Opening https://example.com…");
  });

  it("folds what snapshot read behind a summary", () => {
    const html = draw(
      call("snapshot", "{}", ToolCallStatus.Done({ result: "heading Example Domain" })),
    );

    expect(html).toContain("Read the page");
    expect(html).toMatch(/<details[^>]*>.*heading Example Domain.*<\/details>/s);
  });

  it("draws a tool it has no renderer for by name, with its input", () => {
    const html = draw(call("scroll", '{"ref":"e3"}', ToolCallStatus.Unfinished()));

    expect(html).toContain('data-tool="scroll"');
    expect(html).toContain("Did not finish scroll");
    expect(html).toContain("{&quot;ref&quot;:&quot;e3&quot;}");
  });

  it("says which element click clicked, and folds the page it answered with", () => {
    const html = draw(
      call("click", '{"ref":"e23"}', ToolCallStatus.Done({ result: 'searchbox "Search"' })),
    );

    expect(html).toContain('data-tool="click"');
    expect(html).toContain("Clicked e23");
    expect(html).toMatch(/<details[^>]*>.*searchbox &quot;Search&quot;.*<\/details>/s);
  });

  it("says type typed into the element, and shows the field holding the text", () => {
    const html = draw(
      call(
        "type",
        '{"ref":"e23","text":"Effect TypeScript"}',
        ToolCallStatus.Done({
          result: 'searchbox "Search Wikipedia" [ref=e23]: Effect TypeScript',
        }),
      ),
    );

    expect(html).toContain("Typed into e23");
    expect(html).toMatch(/<details[^>]*>.*\[ref=e23\]: Effect TypeScript.*<\/details>/s);
  });

  it("says why a click on a stale ref did not happen", () => {
    const html = draw(
      call(
        "click",
        '{"ref":"e9"}',
        ToolCallStatus.Failed({
          result: "click did not run: e9 is not a ref in your latest snapshot.",
        }),
      ),
    );

    expect(html).toContain('data-status="failed"');
    expect(html).toContain("Could not click e9");
    expect(html).toContain("e9 is not a ref in your latest snapshot");
  });

  it("shows type as still typing while it runs", () => {
    expect(draw(call("type", '{"ref":"e2","text":"Ada"}', ToolCallStatus.Running()))).toContain(
      "Typing into e2…",
    );
  });

  it("shows the command run ran, and folds what it printed", () => {
    const html = draw(
      call(
        "run",
        '{"command":"echo hello > notes.txt && ls"}',
        ToolCallStatus.Done({ result: "Exit code: 0\n\nstdout:\nnotes.txt" }),
      ),
    );

    expect(html).toContain('data-tool="run"');
    expect(html).toContain("Ran a command");
    expect(html).toContain("<code");
    expect(html).toContain("echo hello &gt; notes.txt &amp;&amp; ls");
    expect(html).toMatch(/<details[^>]*>.*Exit code: 0.*notes\.txt.*<\/details>/s);
  });

  it("shows the command run is running while it runs", () => {
    const html = draw(call("run", '{"command":"sleep 5"}', ToolCallStatus.Running()));

    expect(html).toContain("Running a command…");
    expect(html).toContain("sleep 5");
  });

  it("says why a command did not run", () => {
    const html = draw(
      call(
        "run",
        '{"command":"ls"}',
        ToolCallStatus.Failed({ result: "Your computer could not be started." }),
      ),
    );

    expect(html).toContain('data-status="failed"');
    expect(html).toContain("Could not run a command");
    expect(html).toContain("Your computer could not be started.");
  });

  it("puts a chip that downloads the file under a write_file once it is saved", () => {
    const html = draw(
      call(
        "write_file",
        '{"path":"reports/expenses-total.csv","contents":"total,20\\n"}',
        ToolCallStatus.Done({ result: "Saved reports/expenses-total.csv (9 bytes)." }),
      ),
    );

    expect(html).toContain('data-tool="write_file"');
    expect(html).toContain("Saved reports/expenses-total.csv");
    expect(html).toMatch(
      /<a class="file-chip" href="\/files\?path=reports%2Fexpenses-total\.csv" download="">.*expenses-total\.csv.*<\/a>/s,
    );
    expect(html).not.toContain("total,20");
  });

  it("names a chip by the file's whole name, \\ and all, as the Linux computer saved it", () => {
    const html = draw(
      call(
        "write_file",
        '{"path":"reports/a\\\\b.txt","contents":""}',
        ToolCallStatus.Done({ result: "Saved reports/a\\b.txt (0 bytes)." }),
      ),
    );

    expect(html).toMatch(/<a class="file-chip"[^>]*>.*a\\b\.txt.*<\/a>/s);
  });

  it("offers no chip while a write_file runs or once it failed, and says why it failed", () => {
    const running = draw(
      call("write_file", '{"path":"a.csv","contents":""}', ToolCallStatus.Running()),
    );

    const failed = draw(
      call(
        "write_file",
        '{"path":"/etc/passwd","contents":""}',
        ToolCallStatus.Failed({
          result: "write_file did not run: /etc/passwd is outside your workspace.",
        }),
      ),
    );

    expect(running).toContain("Saving a.csv…");
    expect(running).not.toContain("file-chip");
    expect(failed).toContain("Could not save /etc/passwd");
    expect(failed).toContain("outside your workspace");
    expect(failed).not.toContain("file-chip");
  });

  it("says which file read_file read, and folds what it read", () => {
    const html = draw(
      call(
        "read_file",
        '{"path":"expenses.csv"}',
        ToolCallStatus.Done({ result: "File: expenses.csv (40 bytes)\n\ndate,amount" }),
      ),
    );

    expect(html).toContain("Read expenses.csv");
    expect(html).toMatch(/<details[^>]*>.*date,amount.*<\/details>/s);
    expect(html).not.toContain("file-chip");
  });

  it("says list_files listed your files for the whole workspace, and a folder by its name", () => {
    expect(
      draw(
        call("list_files", '{"path":"."}', ToolCallStatus.Done({ result: "notes.txt (5 bytes)" })),
      ),
    ).toContain("Listed your files");
    expect(draw(call("list_files", '{"path":"reports"}', ToolCallStatus.Running()))).toContain(
      "Listing reports…",
    );
  });
});

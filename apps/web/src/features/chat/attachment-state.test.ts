import { describe, expect, it } from "vite-plus/test";
import {
  Attachment,
  afterSend,
  messageWith,
  sendWith,
  stillUploading,
} from "./attachment-state.ts";

const ready = (path: string) => Attachment.Ready({ id: path, name: path, path });

describe("messageWith", () => {
  it("adds a line naming the file that reached the workspace", () => {
    expect(
      messageWith("Add a total row and save it as expenses-total.csv.", [ready("expenses.csv")]),
    ).toBe(
      "Add a total row and save it as expenses-total.csv.\n\nI put expenses.csv in your workspace.",
    );
  });

  it("names every file that arrived, and none that did not", () => {
    expect(
      messageWith("Compare them.", [
        ready("a.csv"),
        Attachment.Failed({ id: "x", name: "huge.zip", message: "Too large." }),
        Attachment.Uploading({ id: "y", name: "slow.csv" }),
        ready("b.csv"),
        ready("c.csv"),
      ]),
    ).toBe("Compare them.\n\nI put a.csv, b.csv and c.csv in your workspace.");
  });

  it("is the line alone when the person typed nothing", () => {
    expect(messageWith("  ", [ready("a.csv"), ready("b.csv")])).toBe(
      "I put a.csv and b.csv in your workspace.",
    );
  });

  it("leaves a message with no files as it was typed", () => {
    expect(messageWith("Hello", [])).toBe("Hello");
  });
});

describe("after a message went", () => {
  it("keeps the files that failed, and those that arrived after it was written", () => {
    const failed = Attachment.Failed({ id: "x", name: "huge.zip", message: "Too large." });
    const sent = [ready("a.csv"), failed];

    expect(afterSend([...sent, ready("b.csv")], sent)).toEqual([failed, ready("b.csv")]);
  });
});

describe("stillUploading", () => {
  it("holds the message while a file is on its way", () => {
    expect(stillUploading([ready("a.csv"), Attachment.Uploading({ id: "b", name: "b.csv" })])).toBe(
      true,
    );
    expect(stillUploading([ready("a.csv")])).toBe(false);
  });
});

describe("sendWith", () => {
  it("sends the message naming the files, and says it went", () => {
    const sent: Array<string> = [];

    expect(sendWith("Total it.", [ready("a.csv")], (text) => sent.push(text) > 0)).toBe(true);
    expect(sent).toEqual(["Total it.\n\nI put a.csv in your workspace."]);
  });

  it("says nothing went when the conversation did not take the message", () => {
    expect(sendWith("Total it.", [ready("a.csv")], () => false)).toBe(false);
  });

  it("sends nothing while a file is still on its way", () => {
    const sent: Array<string> = [];
    const uploading = [Attachment.Uploading({ id: "b", name: "b.csv" })];

    expect(sendWith("Total it.", uploading, (text) => sent.push(text) > 0)).toBe(false);
    expect(sent).toEqual([]);
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFakeMail, loadScript, element, collection } from "./fake-mail.mjs";

const setup = () => {
  const fake = buildFakeMail();
  return { ...fake, call: loadScript(fake.Mail) };
};

test("list_accounts and list_mailboxes", () => {
  const { call } = setup();
  const a = call("list_accounts", {});
  assert.equal(a.ok, true);
  assert.deepEqual(a.result[0].email_addresses, ["lj@example.com"]);
  const m = call("list_mailboxes", { account: "work" });
  assert.deepEqual(m.result.map((x) => x.mailbox), ["INBOX", "Archive"]);
});

test("list_messages sorts newest first and pages", () => {
  const { call } = setup();
  const r = call("list_messages", { limit: 2 }).result;
  assert.equal(r.total, 3);
  assert.deepEqual(r.messages.map((m) => m.id), [2, 3]);
  assert.equal(r.messages[0].account, "Work");
  assert.equal(r.messages[0].mailbox, "INBOX");
  const p2 = call("list_messages", { limit: 2, offset: 2 }).result;
  assert.deepEqual(p2.messages.map((m) => m.id), [1]);
});

test("filters: unread_only and since_days", () => {
  const { call } = setup();
  assert.deepEqual(call("list_messages", { unread_only: true }).result.messages.map((m) => m.id), [2, 1]);
  assert.deepEqual(call("list_messages", { since_days: 7 }).result.messages.map((m) => m.id), [2, 3]);
});

test("search by sender/subject, and across all mailboxes", () => {
  const { call } = setup();
  assert.deepEqual(call("search_messages", { query: "bob@acme.com" }).result.messages.map((m) => m.id), [3, 1]);
  assert.deepEqual(call("search_messages", { query: "quote", field: "subject" }).result.messages.map((m) => m.id), [2, 1]);
  const all = call("search_messages", { query: "quote", account: "Work", mailbox: "*" }).result;
  assert.deepEqual(all.messages.map((m) => m.id), [2, 10, 1]);
});

test("get_message returns body and truncates", () => {
  const { call } = setup();
  const r = call("get_message", { id: 2, account: "Work", mailbox: "INBOX", max_chars: 7 }).result;
  assert.equal(r.subject, "New quote request");
  assert.equal(r.body, "Body of");
  assert.equal(r.truncated, true);
});

test("unknown mailbox/account give helpful errors", () => {
  const { call } = setup();
  assert.match(call("list_messages", { account: "Nope" }).error, /Account not found/);
  assert.match(call("list_messages", { account: "Work", mailbox: "Zzz" }).error, /not found in account/);
  assert.match(call("list_messages", { mailbox: "Archive" }).error, /requires an account/);
  assert.match(call("get_message", { id: 999 }).error, /not found/);
});

test("compose: draft vs send", () => {
  const { call, log } = setup();
  const d = call("compose", { to: ["a@b.com"], subject: "Hi", body: "x" }).result;
  assert.equal(d.status, "draft_opened");
  assert.ok(!log.some((l) => l[0] === "send"));
  const s = call("compose", { to: ["a@b.com"], cc: ["c@d.com"], subject: "Hi", body: "x", send: true }).result;
  assert.equal(s.status, "sent");
  const sent = log.find((l) => l[0] === "send")[1];
  assert.equal(sent.visible, false);
  assert.deepEqual(sent.toRecipients().map((r) => r.address()), ["a@b.com"]);
  assert.deepEqual(sent.ccRecipients().map((r) => r.address()), ["c@d.com"]);
});

test("compose with failing attachment refuses to send", () => {
  const { call, log } = setup();
  const r = call("compose", { to: ["a@b.com"], subject: "Hi", body: "x", attachments: ["/x.pdf"], send: true });
  // fake supports neither attach path, so it must not send
  assert.equal(r.ok, false);
  assert.match(r.error, /Not sent/);
  assert.ok(!log.some((l) => l[0] === "send"));
});

test("reply prepends body to quoted text", () => {
  const { call, log } = setup();
  call("reply", { id: 2, account: "Work", mailbox: "INBOX", body: "Thanks!", send: true });
  const [, r, opts] = log.find((l) => l[0] === "reply-send");
  assert.equal(r.content, "Thanks!\n\n> quoted");
  assert.equal(opts.openingWindow, false);
});

test("update and move messages", () => {
  const { call, inboxMsgs, archiveMsgs } = setup();
  const u = call("update_messages", { messages: [{ id: 2, account: "Work", mailbox: "INBOX" }, { id: 77 }], read: true, flagged: true }).result;
  assert.deepEqual(u.map((x) => x.ok), [true, false]);
  assert.equal(inboxMsgs.find((m) => m.__raw.id === 2).__raw.readStatus, true);
  const mv = call("move_messages", { messages: [{ id: 2, account: "Work", mailbox: "INBOX" }], to_account: "Work", to_mailbox: "archive" }).result;
  assert.equal(mv.results[0].ok, true);
  assert.ok(archiveMsgs.some((m) => m.__raw.id === 2));
});

test("duplicate account names prefer the enabled account", () => {
  const { Mail, call } = setup();
  const work = Mail.accounts[0];
  const dupe = element({ name: "Work", enabled: false, emailAddresses: [], mailboxes: collection([]) });
  Mail.accounts.push(dupe);
  assert.equal(call("list_messages", { account: "Work" }).ok, true);
  dupe.__raw.enabled = true;
  assert.match(call("list_messages", { account: "Work" }).error, /ambiguous/);
  assert.ok(work);
});

test("bad request JSON and unknown op", () => {
  const { Mail } = buildFakeMail();
  const call = loadScript(Mail);
  assert.match(call("nope", {}).error, /Unknown op/);
});

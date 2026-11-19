// Minimal emulation of JXA object specifiers for Apple Mail, enough to run
// jxa/mail.js under Node. Elements expose properties as getter functions and
// accept assignment; collections are callable and support whose/byName/bulk
// property reads, like real JXA element arrays.
import fs from "node:fs";
import vm from "node:vm";

function matches(obj, f) {
  if (f._and) return f._and.every((c) => matches(obj, c));
  if (f._or) return f._or.some((c) => matches(obj, c));
  return Object.entries(f).every(([k, cond]) => {
    const v = obj[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("_contains" in cond) return String(v).includes(cond._contains);
      if ("_greaterThan" in cond) return v > cond._greaterThan;
      throw new Error("unsupported op " + JSON.stringify(cond));
    }
    return v === cond;
  });
}

export function element(data) {
  return new Proxy(data, {
    get(t, k) {
      if (k === "__raw") return t;
      const v = t[k];
      if (typeof v === "function" && v.__method) return v;
      if (v && v.__collection) return v;
      return () => v;
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  });
}

export function collection(items) {
  const fn = () => items.slice();
  return new Proxy(fn, {
    get(_t, k) {
      if (k === "__collection") return true;
      if (k === "length") return items.length;
      if (k === "whose") return (f) => collection(items.filter((e) => matches(e.__raw, f)));
      if (k === "byName")
        return (n) => {
          const e = items.find((x) => x.__raw.name === n);
          if (!e) return element({ get name() { throw new Error("no such object"); } });
          return e;
        };
      if (k === "push") return (x) => items.push(x);
      if (typeof k === "string" && /^\d+$/.test(k)) return items[Number(k)];
      // Bulk property read, e.g. messages.dateReceived()
      return () => items.map((e) => e.__raw[k]);
    },
  });
}

export function method(f) {
  f.__method = true;
  return f;
}

export function buildFakeMail() {
  const log = [];
  const now = Date.now();
  const day = 86400000;
  const acct = element({ name: "Work", enabled: true, accountType: "imap", emailAddresses: ["lj@example.com"] });
  const mk = (id, subject, sender, ageDays, extra = {}) =>
    element({ id, subject, sender, dateReceived: new Date(now - ageDays * day), readStatus: false, flaggedStatus: false, messageId: `<${id}@x>`, content: `Body of ${subject}`, toRecipients: collection([]), ccRecipients: collection([]), mailAttachments: collection([]), ...extra });
  const inboxMsgs = [mk(1, "Old quote", "Bob <bob@acme.com>", 30), mk(2, "New quote request", "Alice <alice@corp.com>", 1), mk(3, "Lunch?", "Bob <bob@acme.com>", 5, { readStatus: true })];
  const archiveMsgs = [mk(10, "Archived quote", "Carol <carol@x.com>", 2)];
  const inbox = element({ name: "INBOX", unreadCount: 2, account: method(() => acct), messages: collection(inboxMsgs), container: method(() => acct) });
  const archive = element({ name: "Archive", unreadCount: 1, account: method(() => acct), messages: collection(archiveMsgs), container: method(() => acct) });
  for (const m of inboxMsgs) m.__raw.mailbox = method(() => inbox);
  for (const m of archiveMsgs) m.__raw.mailbox = method(() => archive);
  acct.__raw.mailboxes = collection([inbox, archive]);

  const outgoing = [];
  const Mail = {
    accounts: collection([acct]),
    inbox,
    outgoingMessages: collection(outgoing),
    OutgoingMessage(props) {
      const m = element({ ...props, toRecipients: collection([]), ccRecipients: collection([]), bccRecipients: collection([]) });
      m.__raw.send = method(() => log.push(["send", m.__raw]));
      m.__raw.save = method(() => log.push(["save", m.__raw]));
      return m;
    },
    ToRecipient: (p) => element(p),
    CcRecipient: (p) => element(p),
    BccRecipient: (p) => element(p),
    move(m, { to }) {
      const from = m.__raw.mailbox();
      const src = from.__raw.messages === inbox.__raw.messages ? inboxMsgs : archiveMsgs;
      src.splice(src.indexOf(m), 1);
      (to === inbox ? inboxMsgs : archiveMsgs).push(m);
      m.__raw.mailbox = method(() => to);
      log.push(["move", m.__raw.id, to.__raw.name]);
    },
    reply(m, opts) {
      const r = element({ content: "> quoted" });
      r.__raw.send = method(() => log.push(["reply-send", r.__raw, opts]));
      return r;
    },
    activate: () => log.push(["activate"]),
    make: () => { throw new Error("make unsupported in fake"); },
  };
  return { Mail, log, inboxMsgs, archiveMsgs };
}

export function loadScript(Mail) {
  const ctx = { Application: () => Mail, Path: (p) => ({ path: p }), JSON, Date, Math, Number, String, Error };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL("../jxa/mail.js", import.meta.url), "utf8"), ctx);
  return (op, args) => JSON.parse(ctx.run([JSON.stringify({ op, args })]));
}

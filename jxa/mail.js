// JavaScript for Automation (JXA) bridge to Apple Mail.
// Invoked as: osascript -l JavaScript mail.js '<json request>'
// The request is passed via argv (never interpolated into source), so user
// input cannot inject script code. Output is a single JSON line on stdout.

function run(argv) {
  var req;
  try {
    req = JSON.parse(argv[0] || "{}");
  } catch (e) {
    return JSON.stringify({ ok: false, error: "Invalid request JSON: " + e });
  }
  var Mail = Application("Mail");
  Mail.includeStandardAdditions = true;
  var handler = HANDLERS[req.op];
  if (!handler) return JSON.stringify({ ok: false, error: "Unknown op: " + req.op });
  try {
    return JSON.stringify({ ok: true, result: handler(Mail, req.args || {}) });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}

// ---------- helpers ----------

function safe(fn, fallback) {
  try {
    var v = fn();
    return v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function iso(d) {
  return d && d.toISOString ? d.toISOString() : null;
}

function findAccount(Mail, name) {
  var accts = Mail.accounts();
  var lower = String(name).toLowerCase();
  var byName = accts.filter(function (a) { return a.name().toLowerCase() === lower; });
  // Allow matching by email address as a convenience.
  var matches = byName.length ? byName : accts.filter(function (a) {
    var addrs = safe(function () { return a.emailAddresses(); }, []);
    return addrs.some(function (x) { return String(x).toLowerCase() === lower; });
  });
  if (!matches.length) throw new Error("Account not found: " + name + ". Use list_accounts to see names.");
  if (matches.length === 1) return matches[0];
  // Several accounts share the name: prefer the enabled one(s).
  var enabled = matches.filter(function (a) { return safe(function () { return a.enabled(); }, true) !== false; });
  if (enabled.length === 1) return enabled[0];
  throw new Error("Account name '" + name + "' is ambiguous (" + matches.length + " accounts" + (enabled.length ? ", " + enabled.length + " enabled" : "") + "). Rename one in Mail → Settings → Accounts → Description.");
}

var SPECIAL = {
  inbox: "inbox",
  sent: "sentMailbox",
  drafts: "draftsMailbox",
  trash: "trashMailbox",
  junk: "junkMailbox",
  outbox: "outbox",
};

function mailboxPath(mb) {
  var parts = [mb.name()];
  var cur = mb;
  for (var depth = 0; depth < 20; depth++) {
    var parent = safe(function () { return cur.container(); }, null);
    if (!parent) break;
    var pname = safe(function () { return parent.name(); }, null);
    // The top-level container is the account itself; stop there.
    if (!pname || safe(function () { return parent.emailAddresses(); }, null)) break;
    parts.unshift(pname);
    cur = parent;
  }
  return parts.join("/");
}

// Resolve a mailbox. With no account, special names map to Mail's unified
// mailboxes (all accounts). With an account, look up by path/name.
function findMailbox(Mail, accountName, mailboxName) {
  var name = mailboxName || "INBOX";
  var key = String(name).toLowerCase();
  if (!accountName) {
    if (SPECIAL[key]) return Mail[SPECIAL[key]];
    throw new Error("Mailbox '" + name + "' requires an account (only inbox/sent/drafts/trash/junk/outbox work across all accounts).");
  }
  var acct = findAccount(Mail, accountName);
  var direct = safe(function () {
    var mb = acct.mailboxes.byName(name);
    mb.name(); // force resolution
    return mb;
  }, null);
  if (direct) return direct;
  var all = acct.mailboxes();
  for (var i = 0; i < all.length; i++) {
    var mb = all[i];
    if (mb.name().toLowerCase() === key || mailboxPath(mb).toLowerCase() === key) return mb;
  }
  throw new Error("Mailbox '" + name + "' not found in account '" + accountName + "'. Use list_mailboxes.");
}

function summarize(m) {
  var mb = safe(function () { return m.mailbox(); }, null);
  return {
    id: m.id(),
    account: mb ? safe(function () { return mb.account().name(); }, null) : null,
    mailbox: mb ? safe(function () { return mailboxPath(mb); }, null) : null,
    subject: safe(function () { return m.subject(); }, ""),
    sender: safe(function () { return m.sender(); }, ""),
    date_received: iso(safe(function () { return m.dateReceived(); }, null)),
    read: safe(function () { return m.readStatus(); }, null),
    flagged: safe(function () { return m.flaggedStatus(); }, null),
    message_id: safe(function () { return m.messageId(); }, null),
  };
}

function recipients(list) {
  return (list || []).map(function (r) {
    return { name: safe(function () { return r.name(); }, null), address: safe(function () { return r.address(); }, null) };
  });
}

function getMessageByRef(Mail, ref) {
  if (!ref || ref.id === undefined) throw new Error("Message reference needs id, account and mailbox (from list/search results).");
  var mb = findMailbox(Mail, ref.account, ref.mailbox);
  var hits = mb.messages.whose({ id: Number(ref.id) })();
  if (!hits.length) throw new Error("Message " + ref.id + " not found in " + (ref.account || "all accounts") + "/" + (ref.mailbox || "INBOX") + ". It may have been moved.");
  return hits[0];
}

function buildFilter(args) {
  var clauses = [];
  if (args.unread_only) clauses.push({ readStatus: false });
  if (args.flagged_only) clauses.push({ flaggedStatus: true });
  if (args.since_days) {
    var d = new Date(Date.now() - Number(args.since_days) * 86400000);
    clauses.push({ dateReceived: { _greaterThan: d } });
  }
  if (args.query) {
    var q = String(args.query);
    var field = args.field || "any";
    var ors = [];
    if (field === "subject" || field === "any") ors.push({ subject: { _contains: q } });
    if (field === "sender" || field === "any") ors.push({ sender: { _contains: q } });
    if (field === "content") ors.push({ content: { _contains: q } });
    clauses.push(ors.length === 1 ? ors[0] : { _or: ors });
  }
  if (!clauses.length) return null;
  return clauses.length === 1 ? clauses[0] : { _and: clauses };
}

// Fetch newest-first page of messages from a set of mailboxes.
function collect(mailboxes, args) {
  var limit = Math.min(Number(args.limit || 25), 200);
  var offset = Number(args.offset || 0);
  var filter = buildFilter(args);
  var pool = []; // {coll, idx, date}
  var total = 0;
  for (var i = 0; i < mailboxes.length; i++) {
    var coll = filter ? mailboxes[i].messages.whose(filter) : mailboxes[i].messages;
    // One Apple Event fetches every date in the collection.
    var dates = safe(function () { return coll.dateReceived(); }, []);
    total += dates.length;
    for (var j = 0; j < dates.length; j++) pool.push({ coll: coll, idx: j, t: dates[j] ? dates[j].getTime() : 0 });
  }
  pool.sort(function (a, b) { return b.t - a.t; });
  var page = pool.slice(offset, offset + limit).map(function (p) { return summarize(p.coll[p.idx]); });
  return { total: total, offset: offset, count: page.length, messages: page };
}

function addRecipients(Mail, msg, kind, list) {
  (list || []).forEach(function (addr) {
    msg[kind].push(Mail[kind === "toRecipients" ? "ToRecipient" : kind === "ccRecipients" ? "CcRecipient" : "BccRecipient"]({ address: addr }));
  });
}

function addAttachments(Mail, msg, paths) {
  var failed = [];
  (paths || []).forEach(function (p) {
    try {
      Mail.make({ new: "attachment", withProperties: { fileName: Path(p) }, at: msg.content.paragraphs[msg.content.paragraphs.length - 1] });
    } catch (e) {
      try {
        msg.attachments.push(Mail.Attachment({ fileName: Path(p) }));
      } catch (e2) {
        failed.push(p + ": " + e2);
      }
    }
  });
  return failed;
}

// ---------- operations ----------

var HANDLERS = {
  list_accounts: function (Mail) {
    return Mail.accounts().map(function (a) {
      return {
        name: a.name(),
        enabled: safe(function () { return a.enabled(); }, null),
        type: safe(function () { return String(a.accountType()); }, null),
        email_addresses: safe(function () { return a.emailAddresses(); }, []),
      };
    });
  },

  list_mailboxes: function (Mail, args) {
    var accts = args.account ? [findAccount(Mail, args.account)] : Mail.accounts();
    var out = [];
    accts.forEach(function (a) {
      a.mailboxes().forEach(function (mb) {
        out.push({
          account: a.name(),
          mailbox: mailboxPath(mb),
          unread: safe(function () { return mb.unreadCount(); }, null),
        });
      });
    });
    return out;
  },

  list_messages: function (Mail, args) {
    return collect([findMailbox(Mail, args.account, args.mailbox)], args);
  },

  search_messages: function (Mail, args) {
    var boxes;
    if (args.mailbox === "*") {
      var accts = args.account ? [findAccount(Mail, args.account)] : Mail.accounts();
      boxes = [];
      accts.forEach(function (a) { boxes = boxes.concat(a.mailboxes()); });
    } else {
      boxes = [findMailbox(Mail, args.account, args.mailbox)];
    }
    return collect(boxes, args);
  },

  get_message: function (Mail, args) {
    var m = getMessageByRef(Mail, args);
    var out = summarize(m);
    var body = safe(function () { return m.content(); }, "") || "";
    var max = Number(args.max_chars || 20000);
    out.truncated = body.length > max;
    out.body = body.slice(0, max);
    out.to = recipients(safe(function () { return m.toRecipients(); }, []));
    out.cc = recipients(safe(function () { return m.ccRecipients(); }, []));
    out.reply_to = safe(function () { return m.replyTo(); }, null);
    out.date_sent = iso(safe(function () { return m.dateSent(); }, null));
    out.attachments = safe(function () {
      return m.mailAttachments().map(function (a) {
        return {
          name: safe(function () { return a.name(); }, null),
          size: safe(function () { return a.fileSize(); }, null),
          downloaded: safe(function () { return a.downloaded(); }, null),
        };
      });
    }, []);
    if (args.include_headers) out.headers = safe(function () { return m.allHeaders(); }, null);
    return out;
  },

  compose: function (Mail, args) {
    var send = !!args.send;
    var msg = Mail.OutgoingMessage({
      subject: args.subject || "",
      content: args.body || "",
      visible: !send,
    });
    Mail.outgoingMessages.push(msg);
    if (args.from) msg.sender = args.from;
    addRecipients(Mail, msg, "toRecipients", args.to);
    addRecipients(Mail, msg, "ccRecipients", args.cc);
    addRecipients(Mail, msg, "bccRecipients", args.bcc);
    var failed = addAttachments(Mail, msg, args.attachments);
    if (failed.length && send) {
      msg.delete && safe(function () { Mail.delete(msg); }, null);
      throw new Error("Not sent: could not attach " + failed.join("; "));
    }
    if (send) {
      msg.send();
      return { status: "sent", subject: args.subject, to: args.to || [] };
    }
    safe(function () { msg.save(); }, null);
    Mail.activate();
    return { status: "draft_opened", subject: args.subject, attachment_errors: failed };
  },

  reply: function (Mail, args) {
    var original = getMessageByRef(Mail, args);
    var send = !!args.send;
    var r = Mail.reply(original, { openingWindow: !send, replyToAll: !!args.reply_all });
    var quoted = safe(function () { return r.content(); }, "") || "";
    r.content = (args.body || "") + (quoted ? "\n\n" + quoted : "");
    if (send) {
      r.send();
      return { status: "sent", in_reply_to: original.subject() };
    }
    Mail.activate();
    return { status: "draft_opened", in_reply_to: original.subject() };
  },

  forward: function (Mail, args) {
    var original = getMessageByRef(Mail, args);
    var send = !!args.send;
    var f = Mail.forward(original, { openingWindow: !send });
    addRecipients(Mail, f, "toRecipients", args.to);
    if (args.body) {
      var existing = safe(function () { return f.content(); }, "") || "";
      f.content = args.body + "\n\n" + existing;
    }
    if (send) {
      f.send();
      return { status: "sent", forwarded: original.subject(), to: args.to };
    }
    Mail.activate();
    return { status: "draft_opened", forwarded: original.subject() };
  },

  update_messages: function (Mail, args) {
    var results = [];
    (args.messages || []).forEach(function (ref) {
      try {
        var m = getMessageByRef(Mail, ref);
        if (args.read !== undefined && args.read !== null) m.readStatus = !!args.read;
        if (args.flagged !== undefined && args.flagged !== null) m.flaggedStatus = !!args.flagged;
        results.push({ id: ref.id, ok: true });
      } catch (e) {
        results.push({ id: ref.id, ok: false, error: String(e) });
      }
    });
    return results;
  },

  move_messages: function (Mail, args) {
    var target = findMailbox(Mail, args.to_account, args.to_mailbox);
    var results = [];
    (args.messages || []).forEach(function (ref) {
      try {
        var m = getMessageByRef(Mail, ref);
        Mail.move(m, { to: target });
        results.push({ id: ref.id, ok: true });
      } catch (e) {
        results.push({ id: ref.id, ok: false, error: String(e) });
      }
    });
    return { moved_to: (args.to_account || "") + "/" + args.to_mailbox, results: results };
  },
};

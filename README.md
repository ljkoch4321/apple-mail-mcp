# Apple Mail connector (MCP)

Lets Claude read, search, draft, send and organize email in **Apple Mail on your Mac**.
It works with every account Mail has (iCloud, Gmail, Exchange, IMAP). It talks to Mail
through `osascript` (JavaScript for Automation), so no passwords or API keys are involved.

It runs locally, so use it from the **Claude Desktop app** or **Claude Code on your Mac**.

## Install

### Option A: Claude Desktop (one click)
1. Copy `apple-mail.mcpb` to your Mac.
2. Double-click it, or drag it onto Claude Desktop → Settings → Extensions, and click **Install**.

### Option B: Claude Code / manual config
On your Mac (Node 18+):
```bash
cd apple-mail-mcp && npm install && npm run build
```
```bash
claude mcp add apple-mail -- node "$PWD/dist/index.js"
```
Or add this to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{ "mcpServers": { "apple-mail": { "command": "node", "args": ["/full/path/to/apple-mail-mcp/dist/index.js"] } } }
```

### First run: macOS permission
On the first call, macOS asks whether Claude (or your terminal) may control **Mail**. Click **OK**.
If you clicked Don't Allow, go to System Settings → Privacy & Security → **Automation** and turn it on.

## Tools

| Tool | What it does |
|---|---|
| `list_accounts` | Accounts configured in Mail |
| `list_mailboxes` | Folders and unread counts |
| `list_messages` | Newest-first listing; filters: `unread_only`, `flagged_only`, `since_days`, `limit`, `offset` |
| `search_messages` | Search by subject/sender (fast) or `content` (slow). `mailbox: "*"` searches every folder of an account |
| `get_message` | Body, recipients, attachment list, and optional headers |
| `create_draft` | Opens a compose window for you to review. **Does not send** |
| `send_email` | Sends immediately (marked destructive, so clients ask before running it) |
| `reply` / `forward` | Open for review by default; `send: true` sends immediately |
| `update_messages` | Mark read/unread, flag/unflag |
| `move_messages` | Move to Archive, another folder, or Trash |

Messages are identified by the `{id, account, mailbox}` that list and search return.
Without an account, `inbox`/`sent`/`drafts`/`trash`/`junk` refer to Mail's unified mailboxes.

## Tips
- Large mailboxes are slow to script. Pass `since_days` (e.g. 30) to keep calls fast.
- Set `APPLE_MAIL_TIMEOUT_MS` to change the 120s per-call timeout.
- Attachments for drafts and sends take absolute file paths on the Mac. If an attachment
  can't be added, `send_email` refuses to send rather than sending without it.

## Development
```bash
npm test
```
The tests run `jxa/mail.js` against a fake Mail object in Node, and exercise the MCP server
through an in-memory client. They pass on Linux, but real Mail behavior needs a Mac.
Rebuild the extension with `npm prune --omit=dev && npx @anthropic-ai/mcpb pack . apple-mail.mcpb && npm install`.

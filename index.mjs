// Telegram → Claude Code router
// 1 bot, 1 group (Topics on). Each topic = 1 agent session.
// Sessions are resumed on demand with the official `claude` CLI — nothing needs to be running beforehand.

import { Bot } from "grammy";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------- config ----------
const expand = (p) => (p?.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const env = process.env;

const BOT_TOKEN = env.BOT_TOKEN;
const CHAT_ID = Number(env.CHAT_ID || 0); // group id (negative number); 0 = not locked yet
const ALLOWED = new Set(
  (env.ALLOWED_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean).map(Number),
);
const PROJECTS_ROOT = expand(env.PROJECTS_ROOT || "~/agents");
const TEMPLATE_DIR = expand(env.TEMPLATE_DIR || path.resolve("template"));
const CLAUDE_BIN = env.CLAUDE_BIN || "claude";
const MODEL = env.CLAUDE_MODEL || "";
const PERMISSION_MODE = env.PERMISSION_MODE || "acceptEdits";
const MAX_CONCURRENT = Number(env.MAX_CONCURRENT || 2);
const DB_FILE = expand(env.DB_FILE || path.resolve("sessions.json"));
const APPEND_PROMPT =
  env.APPEND_PROMPT ||
  "Người dùng nhắn cho bạn qua Telegram, tin nhắn của họ được chuyển thẳng vào đây. " +
    "Trả lời tự nhiên như đang làm việc trong terminal, dùng ngôn ngữ người dùng dùng. Không cần tóm tắt theo mẫu cố định.";

let TEMPLATE_ALLOW = [];
try {
  TEMPLATE_ALLOW = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, ".claude/settings.json"), "utf8"))
    .permissions?.allow ?? [];
} catch {}

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN in .env");
  process.exit(1);
}

// ---------- storage (tiny JSON db) ----------
let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, "utf8")) : { topics: {} };
const save = () => {
  fs.writeFileSync(DB_FILE + ".tmp", JSON.stringify(db, null, 2));
  fs.renameSync(DB_FILE + ".tmp", DB_FILE);
};

const ANIMALS = [
  ["Sói", "🐺"], ["Cáo", "🦊"], ["Nhện", "🕷️"], ["Bọ Cạp", "🦂"], ["Cánh Cụt", "🐧"],
  ["Hà Mã", "🦛"], ["Hươu", "🦒"], ["Rắn", "🐍"], ["Cú", "🦉"], ["Gấu", "🐻"],
  ["Hổ", "🐯"], ["Rồng", "🐉"], ["Bạch Tuộc", "🐙"], ["Mèo", "🐱"], ["Khỉ", "🐒"],
  ["Cá Mập", "🦈"], ["Đại Bàng", "🦅"], ["Rùa", "🐢"], ["Ong", "🐝"], ["Voi", "🐘"],
];
function pickAnimal() {
  const used = new Set(Object.values(db.topics).map((t) => t.name));
  const free = ANIMALS.filter(([n]) => !used.has(n));
  const pool = free.length ? free : ANIMALS;
  const [name, emoji] = pool[Math.floor(Math.random() * pool.length)];
  return { name: free.length ? name : `${name} ${Object.keys(db.topics).length + 1}`, emoji };
}
const slug = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---------- telegram helpers ----------
const bot = new Bot(BOT_TOKEN);
const tag = (t) => `[${t.emoji} ${t.name} #${t.sessionId.slice(0, 8)}]`;

async function send(topic, text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900));
  let last;
  for (const c of chunks.length ? chunks : [" "]) {
    last = await bot.api
      .sendMessage(topic.chatId, c, { message_thread_id: topic.threadId })
      .catch((e) => console.error("send failed:", e.description || e));
  }
  return last;
}
async function edit(topic, msg, text) {
  if (!msg) return;
  await bot.api
    .editMessageText(topic.chatId, msg.message_id, text.slice(0, 4000))
    .catch(() => {}); // "message is not modified" etc.
}

// ---------- run queue ----------
const running = new Map(); // threadId -> { child, stopped }
const queues = new Map(); // threadId -> [prompt]
const waiting = []; // threadIds waiting for a slot

function enqueue(topic, prompt) {
  const q = queues.get(topic.threadId) ?? [];
  q.push(prompt);
  queues.set(topic.threadId, q);
  if (running.has(topic.threadId)) return send(topic, "📥 Đã xếp hàng, sẽ chạy sau task hiện tại.");
  if (running.size >= MAX_CONCURRENT)
    send(topic, `⏸ Đang chờ slot (${running.size}/${MAX_CONCURRENT} session đang chạy).`);
  if (!waiting.includes(topic.threadId)) waiting.push(topic.threadId);
  pump();
}

function pump() {
  while (running.size < MAX_CONCURRENT && waiting.length) {
    const id = waiting.shift();
    const q = queues.get(id);
    const topic = db.topics[id];
    if (!topic || !q?.length || running.has(id)) continue;
    const prompt = q.shift();
    running.set(id, { child: null, stopped: false });
    runClaude(topic, prompt)
      .catch((e) => send(topic, `❌ Lỗi router: ${e.message}`))
      .finally(() => {
        running.delete(id);
        if (queues.get(id)?.length) waiting.push(id);
        pump();
      });
  }
}

const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

// Run a shell command and collect output (used by `!cmd` and /usage)
function runCapture(cmd, args, cwd, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const add = (c) => { out += c; if (out.length > 20000) out = out.slice(-20000); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => { out += `\n⏱ quá ${timeoutMs / 1000}s, đã dừng.`; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

function describeTool(b) {
  const i = b.input || {};
  const detail = i.command || i.file_path || i.path || i.pattern || i.url || i.description || "";
  return `${b.name}${detail ? ": " + String(detail).replace(/\s+/g, " ").slice(0, 90) : ""}`;
}

async function runClaude(topic, prompt) {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", PERMISSION_MODE,
    "--append-system-prompt", APPEND_PROMPT,
  ];
  if (topic.started) args.push("--resume", topic.sessionId);
  else args.push("--session-id", topic.sessionId);
  if (MODEL) args.push("--model", MODEL);
  // Claude CLI bỏ qua allow-list của project chưa "trust" ở chế độ -p, nên truyền allow-list
  // từ TEMPLATE_DIR (file của chính mình, không phải của repo lạ) qua cờ --allowedTools.
  if (TEMPLATE_ALLOW.length) args.push("--allowedTools", ...TEMPLATE_ALLOW);

  const t0 = Date.now();
  const status = await send(topic, `⏳ ${tag(topic)} đang làm...`);
  const child = spawn(CLAUDE_BIN, args, { cwd: topic.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  running.get(topic.threadId).child = child;
  child.stdin.end(prompt); // prompt via stdin: safe for long text / leading dashes

  let buf = "", stderr = "", result = null, steps = 0, lastTool = "", lastEdit = 0;
  const tick = () => {
    if (Date.now() - lastEdit < 4000) return;
    lastEdit = Date.now();
    edit(topic, status, `⏳ ${tag(topic)} đang làm... (${steps} bước, ${((Date.now() - t0) / 1000) | 0}s)\n▸ ${lastTool}`);
  };
  const handle = (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === "system" && m.subtype === "init") {
      topic.started = true;
      if (m.session_id) topic.sessionId = m.session_id;
      save();
    } else if (m.type === "assistant") {
      for (const b of m.message?.content ?? []) {
        if (b.type === "tool_use") { steps++; lastTool = describeTool(b); tick(); }
      }
    } else if (m.type === "result") {
      result = m;
    }
  };
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handle(line);
    }
  });
  child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-2000)));
  const code = await new Promise((res) => child.on("close", res));
  if (buf.trim()) handle(buf.trim());

  const secs = ((Date.now() - t0) / 1000) | 0;
  if (running.get(topic.threadId)?.stopped) {
    await edit(topic, status, `🛑 ${tag(topic)} đã dừng sau ${steps} bước.`);
    return;
  }
  if (result) {
    if (result.session_id) { topic.sessionId = result.session_id; topic.started = true; save(); }
    const ok = result.subtype === "success" && !result.is_error;
    const u = result.usage || {};
    const tin = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const tokens = tin || u.output_tokens ? ` · ${fmtTok(tin)} in / ${fmtTok(u.output_tokens || 0)} out` : "";
    await edit(topic, status, `${ok ? "✅" : "⚠️"} ${tag(topic)} xong · ${steps} bước · ${secs}s${tokens}`);
    await send(topic, result.result || (ok ? "(xong, không có nội dung trả về)" : `⚠️ ${result.subtype}`));
  } else {
    await edit(topic, status, `❌ ${tag(topic)} lỗi (exit ${code}) sau ${secs}s`);
    await send(topic, `stderr:\n${stderr || "(trống)"}`);
  }
}

// ---------- auth ----------
bot.use(async (ctx, next) => {
  if (ctx.message?.text?.startsWith("/id")) return next(); // lets you discover ids during setup
  if (!ALLOWED.has(ctx.from?.id)) return;
  if (CHAT_ID && ctx.chat?.id !== CHAT_ID) return;
  return next();
});

// ---------- commands ----------
bot.command("id", (ctx) =>
  ctx.reply(`chat_id: ${ctx.chat.id}\nuser_id: ${ctx.from?.id}\nthread_id: ${ctx.message?.message_thread_id ?? "-"}`, {
    message_thread_id: ctx.message?.message_thread_id,
  }),
);

bot.command("new", async (ctx) => {
  if (!ctx.chat.is_forum) return ctx.reply("Group cần bật Topics.");
  const { name, emoji } = pickAnimal();
  // /new                  → làm việc ở thư mục home (~), giống mở terminal mới
  // /new work/robo-worker → ~/work/robo-worker (tương đối tính từ ~, như `cd` trong terminal)
  // /new /abs/path, ~/x   → đúng đường dẫn đó
  const folder = ctx.match?.trim().split(/\s+/)[0];
  const home = os.homedir();
  const cwd = !folder ? home : path.resolve(home, expand(folder));
  const existed = fs.existsSync(cwd);
  fs.mkdirSync(cwd, { recursive: true });
  // Chỉ copy template vào thư mục MỚI tạo — không đụng vào repo có sẵn hay home
  if (!existed && fs.existsSync(TEMPLATE_DIR)) fs.cpSync(TEMPLATE_DIR, cwd, { recursive: true });

  const ft = await ctx.api.createForumTopic(ctx.chat.id, `${name} ${emoji}`);
  const topic = {
    chatId: ctx.chat.id, threadId: ft.message_thread_id, name, emoji, cwd,
    sessionId: randomUUID(), started: false, createdAt: new Date().toISOString(),
  };
  db.topics[topic.threadId] = topic;
  save();
  await send(topic, `${emoji} ${name} sẵn sàng ${tag(topic)}\n📁 ${cwd}\nNhắn brief vào topic này để bắt đầu.`);
});

bot.command("stop", async (ctx) => {
  const id = ctx.message?.message_thread_id;
  const r = running.get(id);
  queues.delete(id);
  if (!r?.child) return ctx.reply("Không có task nào đang chạy.", { message_thread_id: id });
  r.stopped = true;
  r.child.kill("SIGINT");
  setTimeout(() => r.child.exitCode === null && r.child.kill("SIGKILL"), 5000);
});

bot.command("reset", async (ctx) => {
  const topic = db.topics[ctx.message?.message_thread_id];
  if (!topic) return;
  topic.sessionId = randomUUID();
  topic.started = false;
  save();
  await send(topic, `♻️ Context mới ${tag(topic)} (giữ nguyên thư mục ${topic.cwd})`);
});

bot.command("status", async (ctx) => {
  const lines = Object.values(db.topics).map((t) => {
    const s = running.has(t.threadId) ? "🟢 chạy" : queues.get(t.threadId)?.length ? "🟡 chờ" : "⚪️ rảnh";
    return `${s}  ${t.emoji} ${t.name}  📁 ${path.basename(t.cwd)}`;
  });
  await ctx.reply(lines.join("\n") || "Chưa có session nào. Gõ /new để tạo.", {
    message_thread_id: ctx.message?.message_thread_id,
  });
});

// /usage → quota gói Claude (dùng được ở mọi topic, không tốn token)
bot.command("usage", async (ctx) => {
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  const { out } = await runCapture(
    CLAUDE_BIN, ["-p", "/usage", "--output-format", "json", "--no-session-persistence"], PROJECTS_ROOT, 60000,
  );
  let text = out.trim();
  try { text = JSON.parse(text.slice(text.indexOf("{"))).result || text; } catch {}
  await ctx.reply(text.slice(0, 4000) || "(không lấy được usage)", {
    message_thread_id: ctx.message?.message_thread_id,
  });
});

// ---------- messages in topics ----------
bot.on("message", async (ctx) => {
  const topic = db.topics[ctx.message.message_thread_id];
  if (!topic) return; // General or unknown topic
  const text = ctx.message.text ?? ctx.message.caption;
  if (!text) return send(topic, "Bản này mới nhận text. Gửi link Figma/đường dẫn file thay cho ảnh nhé.");

  // `!cmd` → chạy shell trực tiếp trong thư mục của topic (như ! trong Claude CLI)
  if (text.startsWith("!")) {
    const cmd = text.slice(1).trim();
    if (!cmd) return;
    const { code, out } = await runCapture("/bin/zsh", ["-lc", cmd], topic.cwd);
    return send(topic, `$ ${cmd}\n${out.trim() || "(không có output)"}${code ? `\n[exit ${code}]` : ""}`);
  }

  // Slash command khác (/context, /compact, ...) → chuyển thẳng cho Claude CLI của session này
  if (text.startsWith("/")) return enqueue(topic, text.replace(/^(\/\w+)@\w+/, "$1"));

  enqueue(topic, text);
});

bot.catch((err) => console.error("bot error:", err.error ?? err));

// ---------- lifecycle ----------
const shutdown = async () => {
  for (const r of running.values()) r.child?.kill("SIGINT");
  await bot.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await bot.api.setMyCommands([
  { command: "new", description: "Tạo agent/session mới (topic mới)" },
  { command: "status", description: "Xem các session" },
  { command: "stop", description: "Dừng task trong topic này" },
  { command: "reset", description: "Xoá context, giữ thư mục" },
  { command: "usage", description: "Xem quota gói Claude" },
  { command: "context", description: "Xem context của session này" },
  { command: "compact", description: "Nén context của session này" },
  { command: "id", description: "Xem chat_id / user_id" },
]);
if (CHAT_ID) bot.api.sendMessage(CHAT_ID, "🟢 Agent bot online").catch(() => {});
console.log("router started");
bot.start(); // pending updates (up to 24h) are processed on startup

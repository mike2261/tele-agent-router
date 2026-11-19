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
    "Trả lời tự nhiên như đang làm việc trong terminal, dùng ngôn ngữ người dùng dùng. Không cần tóm tắt theo mẫu cố định. " +
    "Khi cần chạy tiến trình chạy mãi (dev server, Metro/expo start, vite dev, emulator...), KHÔNG dùng background task " +
    "của Bash tool vì lượt trả lời sẽ không kết thúc được; hãy tách hẳn: `nohup <lệnh> > /tmp/<tên>.log 2>&1 &` rồi đọc log khi cần.";

// Plugin tắt riêng cho bot (Claude CLI trên máy vẫn giữ nguyên). Phẩy ngăn cách, dạng name@marketplace.
const DISABLED_PLUGINS = (env.DISABLED_PLUGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const SETTINGS_ARGS = DISABLED_PLUGINS.length
  ? ["--settings", JSON.stringify({ enabledPlugins: Object.fromEntries(DISABLED_PLUGINS.map((p) => [p, false])) })]
  : [];

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
// Tên topic = tên folder đang làm việc; emoji con vật chỉ để dễ phân biệt.
// Trùng tên folder với topic khác → thêm số: "robo-worker 2".
function pickName(cwd) {
  const base = cwd === os.homedir() ? "home" : path.basename(cwd) || cwd;
  const topics = Object.values(db.topics);
  const usedNames = new Set(topics.map((t) => t.name));
  let name = base;
  for (let i = 2; usedNames.has(name); i++) name = `${base} ${i}`;
  const usedEmoji = new Set(topics.map((t) => t.emoji));
  const free = ANIMALS.filter(([, e]) => !usedEmoji.has(e));
  const pool = free.length ? free : ANIMALS;
  const [, emoji] = pool[Math.floor(Math.random() * pool.length)];
  return { name, emoji };
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
// Tiến trình claude đã trả kết quả nhưng chưa thoát vì còn tác vụ nền (vd dev server Metro)
const lingering = new Map(); // threadId -> child
async function killLingering(threadId) {
  const child = lingering.get(threadId);
  if (!child) return false;
  lingering.delete(threadId);
  const closed = new Promise((r) => child.once("close", r));
  child.kill("SIGINT");
  const t = setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5000);
  await Promise.race([closed, new Promise((r) => setTimeout(r, 6000))]);
  clearTimeout(t);
  return true;
}
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
function runCapture(cmd, args, cwd, timeoutMs = 120000, input) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"] });
    if (input != null) child.stdin.end(input);
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

// Hỏi nhanh: fork session hiện tại (chỉ đọc, không lưu) để trả lời ngay cả khi task chính đang chạy
const SIDE_PROMPT =
  "Đây là câu hỏi nhanh của người dùng qua Telegram, trong lúc task chính có thể vẫn đang chạy ở tiến trình khác. " +
  "Bạn là bản sao CHỈ ĐỌC của session: không sửa file, không chạy lệnh làm thay đổi gì, không spawn sub-agent, không tiếp tục làm task. " +
  "Trả lời ngắn gọn dựa trên lịch sử session và trạng thái file hiện tại (có thể đọc file, git status/log/diff).";
const SIDE_ALLOW = ["Read", "Grep", "Glob", "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)", "Bash(ls:*)"];

async function askSide(topic, question) {
  if (!topic.started) return send(topic, "Session chưa chạy lượt nào nên chưa có gì để hỏi.");
  const t0 = Date.now();
  const status = await send(topic, `🔎 ${tag(topic)} đang xem (không ngắt task chính)...`);
  const args = [
    "-p", "--output-format", "json",
    "--resume", topic.sessionId, "--fork-session", "--no-session-persistence",
    "--permission-mode", "plan",
    "--append-system-prompt", SIDE_PROMPT,
    "--allowedTools", ...SIDE_ALLOW,
    "--disallowedTools", "Agent", "Task", "Edit", "Write", "NotebookEdit",
    ...SETTINGS_ARGS,
  ];
  if (MODEL) args.push("--model", MODEL);
  const { out } = await runCapture(CLAUDE_BIN, args, topic.cwd, 300000, question);
  let r;
  try { r = JSON.parse(out.slice(out.indexOf("{"))); } catch {}
  const secs = ((Date.now() - t0) / 1000) | 0;
  if (!r) {
    await edit(topic, status, `❌ ${tag(topic)} hỏi nhanh lỗi sau ${secs}s`);
    return send(topic, out.trim().slice(-1500) || "(không có output)");
  }
  const u = r.usage || {};
  const tin = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  await edit(topic, status, `🔎 ${tag(topic)} hỏi nhanh · ${secs}s · ${fmtTok(tin)} in / ${fmtTok(u.output_tokens || 0)} out`);
  await send(topic, r.result || "(không có câu trả lời)");
}

async function runClaude(topic, prompt) {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", topic.mode || PERMISSION_MODE,
    "--append-system-prompt", APPEND_PROMPT,
    ...SETTINGS_ARGS,
  ];
  if (topic.started) args.push("--resume", topic.sessionId);
  else args.push("--session-id", topic.sessionId);
  if (MODEL) args.push("--model", MODEL);
  // Claude CLI bỏ qua allow-list của project chưa "trust" ở chế độ -p, nên truyền allow-list
  // từ TEMPLATE_DIR (file của chính mình, không phải của repo lạ) qua cờ --allowedTools.
  const allow = [...TEMPLATE_ALLOW];
  // /chrome on → bật Claude in Chrome cho topic này (dùng Chrome thật, có sẵn đăng nhập của bạn)
  if (topic.chrome) { args.push("--chrome"); allow.push("mcp__claude-in-chrome"); }
  if (allow.length) args.push("--allowedTools", ...allow);

  // Phiên trước còn treo vì tác vụ nền → dừng nó trước, tránh 2 tiến trình cùng ghi 1 session
  if (await killLingering(topic.threadId))
    await send(topic, "⏹ Đã dừng tác vụ nền của lượt trước (vd dev server) để chạy lượt mới.");

  const t0 = Date.now();
  const status = await send(topic, `⏳ ${tag(topic)} đang làm...`);
  const child = spawn(CLAUDE_BIN, args, { cwd: topic.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  running.get(topic.threadId).child = child;
  if (running.get(topic.threadId).stopped) child.kill("SIGINT"); // /exit lúc đang khởi động
  child.stdin.end(prompt); // prompt via stdin: safe for long text / leading dashes

  let buf = "", stderr = "", steps = 0, lastTool = "", lastText = "";
  const subs = new Map(); // task_id → { desc, toolUseId, lastTool }
  const render = () => {
    let t = `⏳ ${tag(topic)} đang làm... (${steps} bước, ${((Date.now() - t0) / 1000) | 0}s)`;
    if (lastTool) t += `\n▸ ${lastTool}`;
    if (subs.size) {
      t += `\n🤖 ${subs.size} sub-agent đang chạy:`;
      for (const a of subs.values()) t += `\n • ${a.desc}${a.lastTool ? ` — ${a.lastTool}` : ""}`;
    }
    return t;
  };
  // Cập nhật dòng trạng thái mỗi 5s (Telegram giới hạn tốc độ sửa tin nhắn)
  const timer = setInterval(() => {
    const t = render();
    if (t !== lastText) { lastText = t; edit(topic, status, t); }
  }, 5000);
  const subByToolUse = (id) => [...subs.values()].find((a) => a.toolUseId === id);
  const handle = (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === "system" && m.subtype === "init") {
      topic.started = true;
      if (m.session_id) topic.sessionId = m.session_id;
      save();
    } else if (m.type === "system" && m.subtype === "task_started") {
      subs.set(m.task_id, {
        desc: String(m.description || m.subagent_type || "sub-agent").slice(0, 60),
        toolUseId: m.tool_use_id, lastTool: "",
      });
    } else if (m.type === "system" && (m.subtype === "task_updated" || m.subtype === "task_notification")) {
      const st = m.patch?.status ?? m.status;
      if (st && st !== "running" && st !== "pending") subs.delete(m.task_id);
    } else if (m.type === "assistant") {
      const sub = m.parent_tool_use_id && subByToolUse(m.parent_tool_use_id);
      for (const b of m.message?.content ?? []) {
        if (b.type !== "tool_use") continue;
        steps++;
        if (sub) sub.lastTool = describeTool(b).slice(0, 60);
        else lastTool = describeTool(b);
      }
    } else if (m.type === "result") {
      if (!finished) finish(m);
      // Kết quả sau đó = Claude tự chạy tiếp khi tác vụ nền xong → gửi như tin báo thêm
      else if (m.result) send(topic, `🔔 ${tag(topic)} (sau khi tác vụ nền xong)\n${m.result}`);
    }
  };
  // Claude CLI gửi `result` ngay khi xong lượt, nhưng KHÔNG thoát khi còn tác vụ nền (dev server...).
  // Nên báo kết quả & nhả slot ngay khi có result; tiến trình còn sống thì giữ ở `lingering`.
  let finished = false, resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const finish = async (result, code) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    const secs = ((Date.now() - t0) / 1000) | 0;
    try {
      if (running.get(topic.threadId)?.stopped) {
        await edit(topic, status, `🛑 ${tag(topic)} đã dừng sau ${steps} bước.`);
      } else if (result) {
        if (result.session_id) { topic.sessionId = result.session_id; topic.started = true; save(); }
        const ok = result.subtype === "success" && !result.is_error;
        const u = result.usage || {};
        const tin = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        const tokens = tin || u.output_tokens ? ` · ${fmtTok(tin)} in / ${fmtTok(u.output_tokens || 0)} out` : "";
        const bg = child.exitCode === null ? "\n⚙️ còn tác vụ nền đang chạy (dev server...). /stop để tắt." : "";
        if (child.exitCode === null) lingering.set(topic.threadId, child);
        await edit(topic, status, `${ok ? "✅" : "⚠️"} ${tag(topic)} xong · ${steps} bước · ${secs}s${tokens}${bg}`);
        await send(topic, result.result || (ok ? "(xong, không có nội dung trả về)" : `⚠️ ${result.subtype}`));
      } else {
        await edit(topic, status, `❌ ${tag(topic)} lỗi (exit ${code}) sau ${secs}s`);
        await send(topic, `stderr:\n${stderr || "(trống)"}`);
      }
    } finally {
      resolveDone();
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
  child.on("close", (code) => {
    if (buf.trim()) handle(buf.trim());
    if (lingering.get(topic.threadId) === child) lingering.delete(topic.threadId);
    finish(null, code);
  });
  await done;
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
  // /new                  → làm việc ở thư mục home (~), giống mở terminal mới
  // /new work/robo-worker → ~/work/robo-worker (tương đối tính từ ~, như `cd` trong terminal)
  // /new /abs/path, ~/x   → đúng đường dẫn đó
  // /new work/robo-worker Robo Worker → như trên, đặt tên topic là "Robo Worker"
  const [folder, ...nameWords] = ctx.match?.trim().split(/\s+/).filter(Boolean) ?? [];
  const home = os.homedir();
  const cwd = !folder ? home : path.resolve(home, expand(folder));
  const existed = fs.existsSync(cwd);
  fs.mkdirSync(cwd, { recursive: true });
  // Chỉ copy template vào thư mục MỚI tạo — không đụng vào repo có sẵn hay home
  if (!existed && fs.existsSync(TEMPLATE_DIR)) fs.cpSync(TEMPLATE_DIR, cwd, { recursive: true });

  const picked = pickName(cwd);
  const emoji = picked.emoji;
  const name = nameWords.join(" ").slice(0, 100) || picked.name;
  const ft = await ctx.api.createForumTopic(ctx.chat.id, `${emoji} ${name}`.slice(0, 128));
  const topic = {
    chatId: ctx.chat.id, threadId: ft.message_thread_id, name, emoji, cwd,
    sessionId: randomUUID(), started: false, createdAt: new Date().toISOString(),
  };
  db.topics[topic.threadId] = topic;
  save();
  await send(topic, `${emoji} ${name} sẵn sàng ${tag(topic)}\n📁 ${cwd}\nNhắn brief vào topic này để bắt đầu.`);
});

// /rename Tên mới → đổi tên topic (giữ emoji)
// /mode [auto|acceptEdits|bypassPermissions|plan] → chế độ quyền riêng cho topic này
const MODES = { auto: "auto", accept: "acceptEdits", acceptedits: "acceptEdits", bypass: "bypassPermissions",
  bypasspermissions: "bypassPermissions", plan: "plan", default: null };
bot.command("mode", async (ctx) => {
  const topic = db.topics[ctx.message?.message_thread_id];
  if (!topic) return ctx.reply("Gõ /mode trong một topic.");
  const arg = ctx.match?.trim().toLowerCase();
  if (!arg) {
    return send(topic, `Chế độ quyền: ${topic.mode || PERMISSION_MODE}${topic.mode ? "" : " (mặc định)"}\n` +
      "/mode auto: tự chạy lệnh, có bộ lọc chặn lệnh nguy hiểm (khuyên dùng)\n" +
      "/mode accept: chỉ chạy lệnh trong allow-list\n" +
      "/mode bypass: chạy MỌI lệnh, không kiểm tra\n" +
      "/mode plan: chỉ đọc, lên kế hoạch\n" +
      "/mode default: về mặc định trong .env");
  }
  if (!(arg in MODES)) return send(topic, "Không có chế độ đó. Gõ /mode để xem danh sách.");
  topic.mode = MODES[arg] || undefined;
  save();
  const m = topic.mode || PERMISSION_MODE;
  await send(topic, `🔐 Chế độ quyền: ${m}${m === "bypassPermissions" ? "\n⚠️ Claude sẽ chạy mọi lệnh mà không kiểm tra." : ""}\nÁp dụng từ lượt tiếp theo.`);
});

bot.command("rename", async (ctx) => {
  const topic = db.topics[ctx.message?.message_thread_id];
  if (!topic) return ctx.reply("Gõ /rename trong một topic.");
  const name = ctx.match?.trim().slice(0, 100);
  if (!name) return send(topic, "Gõ: /rename Tên mới");
  try {
    await bot.api.editForumTopic(topic.chatId, topic.threadId, { name: `${topic.emoji} ${name}`.slice(0, 128) });
  } catch (e) {
    return send(topic, `Không đổi được tên topic (${e.description || e.message}). Bot cần quyền Manage Topics.`);
  }
  topic.name = name;
  save();
});

// Đổi tên topic bằng tay trên Telegram → cập nhật tên trong bot
bot.on("message:forum_topic_edited", async (ctx) => {
  const topic = db.topics[ctx.message.message_thread_id];
  const raw = ctx.message.forum_topic_edited.name;
  if (!topic || !raw) return;
  topic.name = raw.startsWith(topic.emoji) ? raw.slice(topic.emoji.length).trim() || raw : raw;
  save();
});

bot.command("stop", async (ctx) => {
  const id = ctx.message?.message_thread_id;
  const r = running.get(id);
  queues.delete(id);
  if (!r?.child) {
    const killed = await killLingering(id);
    return ctx.reply(killed ? "⏹ Đã tắt tác vụ nền (dev server...) của topic này." : "Không có task nào đang chạy.",
      { message_thread_id: id });
  }
  r.stopped = true;
  r.child.kill("SIGINT");
  setTimeout(() => r.child.exitCode === null && r.child.kill("SIGKILL"), 5000);
});

// ---------- /resume, /sid: nối session giữa Telegram và Claude CLI trên máy ----------
// Claude lưu session ở ~/.claude/projects/<cwd, ký tự lạ → "-">/<sessionId>.jsonl
const sessionDir = (cwd) => path.join(os.homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? `${m} phút trước` : m < 1440 ? `${Math.round(m / 60)} giờ trước` : `${Math.round(m / 1440)} ngày trước`;
};
function firstPrompt(file) {
  // Chỉ đọc 256KB đầu: file session có thể vài chục MB
  let text = "";
  try {
    const fd = fs.openSync(file, "r");
    const b = Buffer.alloc(262144);
    text = b.subarray(0, fs.readSync(fd, b, 0, b.length, 0)).toString("utf8");
    fs.closeSync(fd);
  } catch { return ""; }
  for (const line of text.split("\n")) {
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type !== "user" || m.isMeta) continue;
    const c = m.message?.content;
    const t = typeof c === "string" ? c : Array.isArray(c) ? c.find((x) => x.type === "text")?.text ?? "" : "";
    if (t && !t.startsWith("<")) return t.replace(/\s+/g, " ").trim();
  }
  return "";
}
function listSessions(cwd, limit = 8) {
  const dir = sessionDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ id: f.slice(0, -6), file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((x) => ({ ...x, prompt: firstPrompt(x.file) }));
}
const shq = (p) => `'${p.replace(/'/g, `'\\''`)}'`;

async function switchSession(topic, id) {
  if (running.has(topic.threadId)) return "Topic đang chạy task. /stop trước rồi /resume.";
  if (!fs.existsSync(path.join(sessionDir(topic.cwd), `${id}.jsonl`))) return `Không thấy session ${id} trong ${topic.cwd}.`;
  await killLingering(topic.threadId);
  queues.delete(topic.threadId);
  topic.sessionId = id;
  topic.started = true;
  save();
  return null;
}

// /resume           → liệt kê session gần đây trong thư mục topic (kể cả session mở từ terminal), bấm để chọn
// /resume <id|8 ký tự đầu> → chuyển thẳng
bot.command("resume", async (ctx) => {
  const id = ctx.message?.message_thread_id;
  const topic = db.topics[id];
  if (!topic) return ctx.reply("Gõ /resume trong một topic.");
  const sessions = listSessions(topic.cwd, 30);
  const arg = ctx.match?.trim();
  if (arg) {
    const hit = sessions.filter((x) => x.id.startsWith(arg));
    if (hit.length !== 1) return send(topic, hit.length ? "Trùng nhiều session, gõ dài hơn." : `Không thấy session bắt đầu bằng ${arg}.`);
    const err = await switchSession(topic, hit[0].id);
    return send(topic, err || `↩️ Đã chuyển sang session ${tag(topic)}\n${hit[0].prompt.slice(0, 200)}`);
  }
  const top = sessions.slice(0, 8);
  if (!top.length) return send(topic, `Chưa có session nào trong ${topic.cwd}.`);
  const lines = top.map((x, i) =>
    `${i + 1}. #${x.id.slice(0, 8)}${x.id === topic.sessionId ? " (đang dùng)" : ""} · ${ago(x.mtime)}\n   ${x.prompt.slice(0, 80) || "(trống)"}`);
  await ctx.reply(`Session trong ${topic.cwd}:\n\n${lines.join("\n")}\n\nBấm để chuyển:`, {
    message_thread_id: id,
    reply_markup: {
      inline_keyboard: top.map((x, i) => [{
        text: `${i + 1}. #${x.id.slice(0, 8)} · ${ago(x.mtime)}${x.id === topic.sessionId ? " ✓" : ""}`,
        callback_data: `resume:${x.id}`,
      }]),
    },
  });
});

bot.callbackQuery(/^resume:(.+)$/, async (ctx) => {
  const topic = db.topics[ctx.callbackQuery.message?.message_thread_id];
  if (!topic) return ctx.answerCallbackQuery({ text: "Topic không còn." });
  const err = await switchSession(topic, ctx.match[1]);
  await ctx.answerCallbackQuery({ text: err || "Đã chuyển session" });
  if (!err) {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await send(topic, `↩️ Đã chuyển sang session ${tag(topic)}. Nhắn tiếp như bình thường.\n` +
      "Nếu session này đang mở trong terminal, thoát terminal trước để tránh 2 bên cùng ghi.");
  }
});

// /sid → lệnh để mở tiếp session này trên máy bằng Claude CLI
bot.command("sid", async (ctx) => {
  const topic = db.topics[ctx.message?.message_thread_id];
  if (!topic) return ctx.reply("Gõ /sid trong một topic.");
  await send(topic, `cd ${shq(topic.cwd)} && claude -r ${topic.sessionId}\n\n` +
    "Đừng chạy cùng lúc với bot. Làm xong trên terminal thì thoát, quay lại đây nhắn tiếp.");
});

// /exit → dừng task, xoá session khỏi bot và xoá luôn topic (thư mục code giữ nguyên)
bot.command("exit", async (ctx) => {
  const id = ctx.message?.message_thread_id;
  const topic = db.topics[id];
  if (!topic) return ctx.reply("Gõ /exit trong topic muốn đóng.");
  queues.delete(id);
  const w = waiting.indexOf(id);
  if (w >= 0) waiting.splice(w, 1);
  const r = running.get(id);
  if (r) r.stopped = true;
  if (r?.child) {
    r.child.kill("SIGINT");
    setTimeout(() => r.child.exitCode === null && r.child.kill("SIGKILL"), 5000);
  }
  killLingering(id);
  delete db.topics[id];
  save();
  try {
    await bot.api.deleteForumTopic(topic.chatId, topic.threadId);
  } catch (e) {
    // Thiếu quyền "Delete messages" → ít nhất đóng topic lại
    await bot.api.closeForumTopic(topic.chatId, topic.threadId).catch(() => {});
    await send(topic, `🗑 Đã xoá session ${tag(topic)}, nhưng không xoá được topic (${e.description || e.message}). ` +
      "Cấp cho bot quyền Delete Messages, hoặc xoá topic bằng tay.");
  }
});

bot.command("chrome", async (ctx) => {
  const topic = db.topics[ctx.message?.message_thread_id];
  if (!topic) return ctx.reply("Gõ /chrome trong một topic.");
  const arg = ctx.match?.trim().toLowerCase();
  topic.chrome = arg === "on" ? true : arg === "off" ? false : !topic.chrome;
  save();
  await send(topic, topic.chrome
    ? "🌐 Đã bật Chrome cho topic này. Claude điều khiển được Chrome thật trên Mac (kèm đăng nhập của bạn). /chrome off để tắt."
    : "Đã tắt Chrome cho topic này.");
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
    return `${s}  ${t.emoji} ${t.name}  📁 ${t.cwd.replace(os.homedir(), "~")}`;
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
  if (!text && !(ctx.message.photo || ctx.message.document || ctx.message.voice || ctx.message.video || ctx.message.sticker)) return; // tin hệ thống
  if (!text) return send(topic, "Bản này mới nhận text. Gửi link Figma/đường dẫn file thay cho ảnh nhé.");

  // `!cmd` → chạy shell trực tiếp trong thư mục của topic (như ! trong Claude CLI)
  if (text.startsWith("!")) {
    const cmd = text.slice(1).trim();
    if (!cmd) return;
    const { code, out } = await runCapture("/bin/zsh", ["-lc", cmd], topic.cwd);
    return send(topic, `$ ${cmd}\n${out.trim() || "(không có output)"}${code ? `\n[exit ${code}]` : ""}`);
  }

  // `? câu hỏi` → hỏi nhanh trên bản sao (fork) của session, không chặn task đang chạy
  if (text.startsWith("?")) return askSide(topic, text.slice(1).trim() || "Tình hình đang thế nào?");

  // Slash command khác (/context, /compact, ...) → chuyển thẳng cho Claude CLI của session này
  if (text.startsWith("/")) return enqueue(topic, text.replace(/^(\/\w+)@\w+/, "$1"));

  enqueue(topic, text);
});

bot.catch((err) => console.error("bot error:", err.error ?? err));

// ---------- lifecycle ----------
const shutdown = async () => {
  for (const r of running.values()) r.child?.kill("SIGINT");
  for (const c of lingering.values()) c.kill("SIGINT");
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
  { command: "chrome", description: "Bật/tắt Claude in Chrome cho topic này" },
  { command: "exit", description: "Đóng session và xoá topic này" },
  { command: "rename", description: "Đổi tên topic này" },
  { command: "mode", description: "Chế độ quyền của topic (auto/accept/bypass/plan)" },
  { command: "resume", description: "Chọn session khác (kể cả mở từ terminal)" },
  { command: "sid", description: "Lệnh claude -r để mở session này trên máy" },
  { command: "context", description: "Xem context của session này" },
  { command: "compact", description: "Nén context của session này" },
  { command: "id", description: "Xem chat_id / user_id" },
]);
if (CHAT_ID) bot.api.sendMessage(CHAT_ID, "🟢 Agent bot online").catch(() => {});
console.log("router started");
bot.start(); // pending updates (up to 24h) are processed on startup

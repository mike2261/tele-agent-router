# tele-agent-router

1 bot Telegram + 1 group bật Topics. Mỗi topic là 1 session Claude Code riêng.
Trên Mac **không cần session nào chạy sẵn**: có tin nhắn thì router mới chạy `claude -p --resume <session>`, làm xong thì thoát.
Chỉ có router chạy 24/7 (launchd).

```
Group "Agent Team" (Topics)
 ├─ 🐺 Sói      → session A  → ~/agents/soi
 ├─ 🦊 Cáo      → session B  → ~/agents/tuni-web
 └─ # General   → gõ /new, /status ở đây
```

## Setup (Mac mini, ~15 phút)

1. **Tạo bot:** @BotFather → `/newbot` → lưu token.
2. **Tạo group:** tạo group → Settings → bật **Topics**. Add bot vào, cho làm **admin** với quyền **Manage Topics**.
3. **Cài:**
   ```bash
   git clone <repo> ~/tele-agent-router   # hoặc copy thư mục này
   cd ~/tele-agent-router && npm install
   cp .env.example .env                   # điền BOT_TOKEN
   ```
   Kiểm tra: `claude` đã đăng nhập (`claude -p "hi"` chạy được) và `which claude` → đặt `CLAUDE_BIN` nếu cần.
4. **Lấy id:** `npm start`, gõ `/id` trong group. Điền `CHAT_ID` và `ALLOWED_USER_IDS` vào `.env`, rồi chạy lại.
5. **Chạy 24/7:**
   ```bash
   cp com.mike.agentbot.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.mike.agentbot.plist
   sudo pmset -a sleep 0 autorestart 1    # không ngủ, có điện lại thì tự bật
   ```
   Log ở: `tail -f /tmp/agentbot.log /tmp/agentbot.err.log`

## Dùng

| Lệnh | Ở đâu | Làm gì |
|---|---|---|
| `/new` | General | Tạo topic + session mới, làm việc ở `~` (home) |
| `/new work/robo-worker` | General | Tạo topic mới, làm việc trong `~/work/robo-worker` (tương đối tính từ `~`, như `cd`). Thư mục mới tạo thì được copy template; thư mục có sẵn thì giữ nguyên |
| (nhắn bình thường) | trong topic | Giao việc / chat với session đó |
| `/stop` | trong topic | Dừng task đang chạy |
| `/reset` | trong topic | Xoá context, giữ nguyên code |
| `/exit` | trong topic | Dừng task, xoá session và xoá luôn topic (thư mục code giữ nguyên) |
| `/status` | đâu cũng được | Xem session nào đang chạy / chờ / rảnh |
| `!lệnh` | trong topic | Chạy shell trực tiếp trong thư mục của topic (không qua Claude, không tốn token, không bị allow-list chặn) |
| `/usage` | đâu cũng được | Xem quota gói Claude |
| `/chrome` (`on`/`off`) | trong topic | Bật/tắt Claude in Chrome cho topic đó (Chrome thật trên Mac, kèm đăng nhập của bạn) |
| `/context`, `/compact`, `/...` | trong topic | Chuyển thẳng cho Claude CLI của session đó |

Mỗi task: bot gửi `⏳ đang làm...`, cứ ~4 giây cập nhật bước đang làm (tool nào, file nào), xong thì báo `✅` kèm thời gian và số token (in/out), rồi gửi câu trả lời.

## Ghi chú

- **Quyền:** chạy với `acceptEdits`: agent được sửa file, còn lệnh shell chỉ chạy nếu nằm trong allow-list ở `template/.claude/settings.json` (file này được copy vào mỗi project mới). Lệnh không có trong list bị từ chối, agent sẽ báo lại chứ không bị treo. **Đừng** đổi sang `bypassPermissions`.
- **Quota:** mọi session dùng chung gói Claude. `MAX_CONCURRENT=2` là đủ; task thừa sẽ tự xếp hàng.
- **Mac tắt hoặc mất mạng:** Telegram giữ tin chưa đọc tối đa 24h. Router bật lại sẽ xử lý tiếp.
- **`template/CLAUDE.md`:** sửa thành quy tắc / stack mặc định của bạn để agent ít phải hỏi.
- Bản này mới nhận **text**. Ảnh/file (screenshot Figma, nhận lại APK) để cho bản sau.

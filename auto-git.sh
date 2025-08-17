#!/data/data/com.termux/files/usr/bin/bash

cd ~/storage/downloads/web  # ✅ เปลี่ยน path ถ้าโปรเจกต์อยู่ที่อื่น

LOGFILE=~/git-auto.log

while true; do
  # ⏳ รอการเปลี่ยนแปลงในโฟลเดอร์
  inotifywait -e modify,create,delete -r . > /dev/null 2>&1

  # 📦 เพิ่มไฟล์ที่เปลี่ยนเข้า staging
  git add .

  # 🔍 ถ้ามีไฟล์เปลี่ยนจริง ค่อย commit
  if ! git diff --cached --quiet; then
    ADDED=$(git diff --cached --diff-filter=A --name-only | sed 's/^/      /')
    MODIFIED=$(git diff --cached --diff-filter=M --name-only | sed 's/^/      /')
    DELETED=$(git diff --cached --diff-filter=D --name-only | sed 's/^/      /')

    {
      echo "auto update: $(date '+%Y-%m-%d %H:%M:%S')"
      [ -n "$ADDED" ] && echo -e "\n➕ Files Added:\n$ADDED"
      [ -n "$MODIFIED" ] && echo -e "\n✏️ Files Modified:\n$MODIFIED"
      [ -n "$DELETED" ] && echo -e "\n🗑️ Files Deleted:\n$DELETED"
    } | git commit -F - 2>>$LOGFILE

    # 🔄 Pull ก่อน push เผื่อมี update จาก remote
    if ! git pull --rebase origin main >>$LOGFILE 2>&1; then
      echo "❌ Pull failed at $(date '+%Y-%m-%d %H:%M:%S')" >>$LOGFILE
      termux-notification \
        --title "Git AutoPush" \
        --content "❌ Pull ล้มเหลว! ตรวจ network หรือ conflict!" \
        --priority high 2>/dev/null
      continue
    fi

    # 🚀 Push ไป remote
    if git push origin main >>$LOGFILE 2>&1; then
      # 🔔 แจ้งเตือนสำเร็จ
      termux-notification \
        --title "Git AutoPush" \
        --content "📤 Push สำเร็จแล้ว! กดเพื่อดูใน GitHub" \
        --action "termux-open-url https://github.com/Jeffy2600II/Community-test" \
        --priority high 2>/dev/null
    else
      echo "❌ Push failed at $(date '+%Y-%m-%d %H:%M:%S')" >>$LOGFILE
      termux-notification \
        --title "Git AutoPush" \
        --content "❌ Push ล้มเหลว! ตรวจ network หรือ permission!" \
        --priority high 2>/dev/null
    fi
  fi
done
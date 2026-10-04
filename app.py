import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import sqlite3
import secrets
import string
from datetime import datetime
from pathlib import Path
import textwrap

# ============================================================
# SQLite User Password Reset Manager
# - เลือก DB
# - เลือกผู้ใช้
# - ยืนยัน 2 ครั้ง
# - Backup DB ก่อนแก้ไข
# - bcrypt ให้ตรงกับ Node.js bcryptjs
# - สร้าง "ใบแจ้งรหัสผ่าน" สำหรับ Copy / Print / Save TXT
# ============================================================

BCRYPT = True
BCRYPT_ROUNDS = 12
PASSWORD_LENGTH = 16
LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
DIGITS = "23456789"

try:
    if BCRYPT:
        import bcrypt
except ImportError:
    bcrypt = None


def generate_password(length=PASSWORD_LENGTH):
    chars = [secrets.choice(LETTERS), secrets.choice(DIGITS)]
    alphabet = LETTERS + DIGITS
    while len(chars) < length:
        chars.append(secrets.choice(alphabet))
    secrets.SystemRandom().shuffle(chars)
    return "".join(chars)


def make_password_hash(password):
    if BCRYPT:
        if bcrypt is None:
            raise RuntimeError(
                "ยังไม่ได้ติดตั้ง bcrypt\n\n"
                "PowerShell:\n"
                "pip install bcrypt"
            )
        return bcrypt.hashpw(
            password.encode("utf-8"),
            bcrypt.gensalt(rounds=BCRYPT_ROUNDS)
        ).decode("utf-8")
    raise RuntimeError("โปรแกรมนี้ต้องใช้ bcrypt เพื่อให้ตรงกับระบบเดิม")


class ResetReport:
    def __init__(self, parent, report_text, username):
        self.parent = parent
        self.report_text = report_text
        self.username = username

        self.win = tk.Toplevel(parent)
        self.win.title("รายงานแจ้งข้อมูลบัญชี")
        self.win.geometry("820x680")
        self.win.minsize(700, 560)
        self.win.transient(parent)

        self.build()

    def build(self):
        outer = ttk.Frame(self.win, padding=18)
        outer.pack(fill="both", expand=True)

        title = ttk.Label(
            outer,
            text="รายงานแจ้งข้อมูลการรีเซ็ตรหัสผ่าน",
            font=("Segoe UI", 18, "bold")
        )
        title.pack(anchor="w")

        ttk.Label(
            outer,
            text=f"บัญชี: {self.username}   •   สามารถ Copy ส่งให้ผู้ใช้ หรือพิมพ์ได้",
            font=("Segoe UI", 10)
        ).pack(anchor="w", pady=(3, 12))

        card = ttk.Frame(outer)
        card.pack(fill="both", expand=True)

        self.text = tk.Text(
            card,
            wrap="word",
            font=("Leelawadee UI", 12),
            padx=18,
            pady=18,
            relief="solid",
            borderwidth=1
        )
        self.text.pack(side="left", fill="both", expand=True)

        scroll = ttk.Scrollbar(card, command=self.text.yview)
        scroll.pack(side="right", fill="y")
        self.text.configure(yscrollcommand=scroll.set)

        self.text.insert("1.0", self.report_text)
        self.text.configure(state="disabled")

        buttons = ttk.Frame(outer)
        buttons.pack(fill="x", pady=(14, 0))

        ttk.Button(
            buttons,
            text="คัดลอกทั้งหมด",
            command=self.copy_all
        ).pack(side="left", padx=(0, 8), ipadx=12, ipady=5)

        ttk.Button(
            buttons,
            text="บันทึกเป็น TXT",
            command=self.save_txt
        ).pack(side="left", padx=8, ipadx=12, ipady=5)

        ttk.Button(
            buttons,
            text="พิมพ์รายงาน",
            command=self.print_report
        ).pack(side="left", padx=8, ipadx=12, ipady=5)

        ttk.Button(
            buttons,
            text="ปิด",
            command=self.win.destroy
        ).pack(side="right", ipadx=16, ipady=5)

    def copy_all(self):
        self.win.clipboard_clear()
        self.win.clipboard_append(self.report_text)
        self.win.update()
        messagebox.showinfo(
            "คัดลอกแล้ว",
            "คัดลอกรายงานทั้งหมดแล้ว\nสามารถนำไปวางใน LINE, Email หรือแชตได้",
            parent=self.win
        )

    def save_txt(self):
        path = filedialog.asksaveasfilename(
            parent=self.win,
            title="บันทึกรายงาน",
            initialfile=f"แจ้งรหัสผ่าน-{self.username}.txt",
            defaultextension=".txt",
            filetypes=[("Text file", "*.txt"), ("All files", "*.*")]
        )
        if not path:
            return

        Path(path).write_text(self.report_text, encoding="utf-8")
        messagebox.showinfo(
            "บันทึกสำเร็จ",
            f"บันทึกรายงานแล้ว:\n{path}",
            parent=self.win
        )

    def print_report(self):
        # Windows: สร้างไฟล์ชั่วคราวแล้วสั่ง print ด้วยโปรแกรม default
        import os
        import tempfile

        try:
            fd, path = tempfile.mkstemp(
                prefix=f"reset-report-{self.username}-",
                suffix=".txt"
            )
            os.close(fd)
            Path(path).write_text(self.report_text, encoding="utf-8")

            os.startfile(path, "print")

            messagebox.showinfo(
                "ส่งงานพิมพ์แล้ว",
                "ส่งรายงานไปยังเครื่องพิมพ์เริ่มต้นแล้ว\n"
                "หาก Windows ถาม ให้เลือกเครื่องพิมพ์ที่ต้องการ",
                parent=self.win
            )
        except Exception as e:
            messagebox.showerror(
                "พิมพ์ไม่สำเร็จ",
                f"ไม่สามารถสั่งพิมพ์ได้:\n{e}\n\n"
                "สามารถใช้ปุ่ม 'คัดลอกทั้งหมด' แล้วนำไปพิมพ์เองได้",
                parent=self.win
            )


class App:
    def __init__(self, root):
        self.root = root
        self.root.title("PMO • User Account Password Manager")
        self.root.geometry("900x650")
        self.root.minsize(820, 590)

        self.db_path = None
        self.users = []
        self.last_report = None

        self.db_var = tk.StringVar()
        self.user_var = tk.StringVar()
        self.status_var = tk.StringVar(
            value="พร้อมใช้งาน • กรุณาเลือกฐานข้อมูล"
        )
        self.account_var = tk.StringVar(value="ยังไม่ได้เลือกบัญชี")

        self.setup_style()
        self.build_ui()

    def setup_style(self):
        style = ttk.Style()
        try:
            style.theme_use("vista")
        except tk.TclError:
            pass

        style.configure("Title.TLabel", font=("Segoe UI", 21, "bold"))
        style.configure("Sub.TLabel", font=("Segoe UI", 10))
        style.configure("Card.TLabelframe", padding=10)
        style.configure("Action.TButton", font=("Segoe UI", 10, "bold"))
        style.configure("Status.TLabel", font=("Segoe UI", 9))

    def build_ui(self):
        root = ttk.Frame(self.root, padding=22)
        root.pack(fill="both", expand=True)

        header = ttk.Frame(root)
        header.pack(fill="x", pady=(0, 18))

        ttk.Label(
            header,
            text="จัดการรีเซ็ตรหัสผ่าน",
            style="Title.TLabel"
        ).pack(anchor="w")

        ttk.Label(
            header,
            text="SQLite User Account Manager  •  ปลอดภัยด้วยการสำรองฐานข้อมูลก่อนแก้ไข",
            style="Sub.TLabel"
        ).pack(anchor="w", pady=(3, 0))

        # DB card
        db_card = ttk.LabelFrame(
            root, text=" ① ฐานข้อมูล ", style="Card.TLabelframe"
        )
        db_card.pack(fill="x", pady=(0, 12))

        row = ttk.Frame(db_card)
        row.pack(fill="x")

        ttk.Entry(
            row, textvariable=self.db_var, state="readonly"
        ).pack(side="left", fill="x", expand=True, ipady=5)

        ttk.Button(
            row, text="เลือกไฟล์ Database...",
            command=self.choose_db
        ).pack(side="left", padx=(10, 0), ipadx=10, ipady=4)

        # User card
        user_card = ttk.LabelFrame(
            root, text=" ② เลือกบัญชี ", style="Card.TLabelframe"
        )
        user_card.pack(fill="x", pady=(0, 12))

        row2 = ttk.Frame(user_card)
        row2.pack(fill="x")

        ttk.Label(row2, text="Username / ID:", font=("Segoe UI", 10, "bold")).pack(
            side="left"
        )

        self.combo = ttk.Combobox(
            row2,
            textvariable=self.user_var,
            state="readonly",
            width=35,
            font=("Segoe UI", 10)
        )
        self.combo.pack(side="left", padx=12, ipady=4)
        self.combo.bind("<<ComboboxSelected>>", self.user_selected)

        ttk.Button(
            row2, text="↻ โหลดใหม่", command=self.load_users
        ).pack(side="left", ipadx=8, ipady=4)

        # Account info
        info_card = ttk.LabelFrame(
            root, text=" ③ ตรวจสอบบัญชี ", style="Card.TLabelframe"
        )
        info_card.pack(fill="x", pady=(0, 12))

        self.info_label = ttk.Label(
            info_card,
            textvariable=self.account_var,
            justify="left",
            font=("Segoe UI", 10),
            padding=10
        )
        self.info_label.pack(fill="x")

        # Action card
        action = ttk.Frame(root)
        action.pack(fill="x", pady=(5, 10))

        self.reset_btn = ttk.Button(
            action,
            text="🔑  รีเซ็ตรหัสผ่าน",
            command=self.reset_password,
            state="disabled",
            style="Action.TButton"
        )
        self.reset_btn.pack(side="left", fill="x", expand=True, ipady=10)

        self.report_btn = ttk.Button(
            action,
            text="📄  เปิดรายงานล่าสุด",
            command=self.open_last_report,
            state="disabled",
            style="Action.TButton"
        )
        self.report_btn.pack(side="left", fill="x", expand=True, padx=(10, 0), ipady=10)

        # Footer
        footer = ttk.Frame(root)
        footer.pack(fill="x", side="bottom")

        ttk.Separator(footer).pack(fill="x", pady=(5, 8))

        ttk.Label(
            footer,
            textvariable=self.status_var,
            style="Status.TLabel"
        ).pack(side="left")

        ttk.Label(
            footer,
            text="Backup จะถูกเก็บในโฟลเดอร์ backups",
            style="Status.TLabel"
        ).pack(side="right")

    def choose_db(self):
        path = filedialog.askopenfilename(
            title="เลือก SQLite Database",
            filetypes=[
                ("SQLite Database", "*.db *.sqlite *.sqlite3"),
                ("Database files", "*.db"),
                ("All files", "*.*"),
            ]
        )
        if not path:
            return

        self.db_path = Path(path)
        self.db_var.set(str(self.db_path))
        self.users = []
        self.combo["values"] = []
        self.user_var.set("")
        self.reset_btn.config(state="disabled")
        self.report_btn.config(state="disabled")
        self.account_var.set("กำลังตรวจสอบฐานข้อมูล...")
        self.root.update_idletasks()

        try:
            self.inspect_db()
            self.load_users()
        except Exception as e:
            self.account_var.set("ไม่สามารถเปิดฐานข้อมูลได้")
            messagebox.showerror("เกิดข้อผิดพลาด", str(e), parent=self.root)

    def connect(self):
        if not self.db_path:
            raise RuntimeError("ยังไม่ได้เลือกไฟล์ Database")
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        return conn

    def inspect_db(self):
        conn = self.connect()
        try:
            tables = [
                r["name"] for r in conn.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type='table' ORDER BY name"
                )
            ]

            if "users" not in tables:
                raise RuntimeError(
                    "ไม่พบตาราง users ใน Database นี้\n\n"
                    "ตารางที่พบ:\n" +
                    (", ".join(tables) if tables else "(ไม่มี)")
                )

            columns = {
                r["name"] for r in conn.execute("PRAGMA table_info(users)")
            }

            required = {"username", "password"}
            missing = required - columns
            if missing:
                raise RuntimeError(
                    "ตาราง users ไม่มีคอลัมน์ที่จำเป็น: "
                    + ", ".join(sorted(missing))
                )
        finally:
            conn.close()

    def load_users(self):
        if not self.db_path:
            return

        try:
            conn = self.connect()
            rows = conn.execute(
                "SELECT id, username, role, status FROM users "
                "ORDER BY username COLLATE NOCASE"
            ).fetchall()
            conn.close()

            self.users = rows
            usernames = [str(r["username"]) for r in rows]
            self.combo["values"] = usernames

            if usernames:
                self.combo.current(0)
                self.user_selected()
                self.status_var.set(
                    f"พบผู้ใช้ {len(rows)} บัญชี • พร้อมรีเซ็ต"
                )
            else:
                self.account_var.set("ไม่พบผู้ใช้ในตาราง users")
                self.reset_btn.config(state="disabled")
                self.status_var.set("ไม่พบผู้ใช้")

        except Exception as e:
            messagebox.showerror("โหลดผู้ใช้ไม่สำเร็จ", str(e), parent=self.root)

    def user_selected(self, event=None):
        username = self.user_var.get()
        row = next(
            (r for r in self.users if str(r["username"]) == username),
            None
        )

        if not row:
            self.reset_btn.config(state="disabled")
            return

        self.account_var.set(
            f"Username   : {row['username']}\n"
            f"User ID    : {row['id']}\n"
            f"Role       : {row['role']}\n"
            f"Status     : {row['status']}\n\n"
            "⚠ รหัสผ่านเดิมจะใช้ไม่ได้หลังรีเซ็ต"
        )
        self.reset_btn.config(state="normal")

    def backup_database(self):
        backup_dir = self.db_path.parent / "backups"
        backup_dir.mkdir(exist_ok=True)

        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = backup_dir / (
            f"{self.db_path.stem}-before-reset-{stamp}.db"
        )

        source = sqlite3.connect(str(self.db_path))
        target = sqlite3.connect(str(backup))
        try:
            source.backup(target)
        finally:
            target.close()
            source.close()

        return backup

    def reset_password(self):
        username = self.user_var.get()
        row = next(
            (r for r in self.users if str(r["username"]) == username),
            None
        )

        if not row:
            messagebox.showwarning(
                "ยังไม่ได้เลือก",
                "กรุณาเลือกบัญชีที่ต้องการรีเซ็ต",
                parent=self.root
            )
            return

        confirm1 = messagebox.askyesno(
            "ยืนยันการรีเซ็ตรหัสผ่าน",
            f"คุณกำลังจะรีเซ็ตรหัสผ่านของ\n\n"
            f"Username : {row['username']}\n"
            f"Role     : {row['role']}\n"
            f"Status   : {row['status']}\n\n"
            "รหัสผ่านเดิมจะไม่สามารถใช้เข้าสู่ระบบได้\n\n"
            "ต้องการดำเนินการต่อหรือไม่?",
            parent=self.root
        )
        if not confirm1:
            self.status_var.set("ยกเลิกแล้ว • ไม่มีการเปลี่ยนแปลง")
            return

        confirm2 = messagebox.askyesno(
            "ยืนยันครั้งสุดท้าย",
            "⚠️ การดำเนินการนี้จะเปลี่ยนข้อมูลใน Database\n\n"
            f"บัญชี: {row['username']}\n\n"
            "1. สำรอง Database\n"
            "2. สร้างรหัสผ่านใหม่\n"
            "3. บันทึก hash ลง Database\n"
            "4. สร้างรายงานสำหรับแจ้งผู้ใช้\n\n"
            "ยืนยันการเปลี่ยนรหัสผ่าน?",
            parent=self.root
        )
        if not confirm2:
            self.status_var.set("ยกเลิกแล้ว • ไม่มีการเปลี่ยนแปลง")
            return

        try:
            self.reset_btn.config(state="disabled")
            self.root.update_idletasks()

            backup = self.backup_database()
            new_password = generate_password()
            password_hash = make_password_hash(new_password)

            conn = self.connect()
            try:
                columns = {
                    r["name"]
                    for r in conn.execute("PRAGMA table_info(users)")
                }

                sets = ["password = ?"]
                params = [password_hash]

                if "token_version" in columns:
                    sets.append(
                        "token_version = COALESCE(token_version, 0) + 1"
                    )

                if "updated_at" in columns:
                    sets.append(
                        "updated_at = datetime('now','localtime')"
                    )

                if "must_change_password" in columns:
                    sets.append("must_change_password = 1")

                if str(row["role"]) == "admin" and "status" in columns:
                    sets.append("status = 'approved'")

                params.append(row["id"])

                with conn:
                    cur = conn.execute(
                        f"UPDATE users SET {', '.join(sets)} WHERE id = ?",
                        params
                    )

                    if cur.rowcount != 1:
                        raise RuntimeError(
                            "ไม่สามารถแก้ไขบัญชีที่เลือกได้"
                        )
            finally:
                conn.close()

            now = datetime.now().strftime("%d/%m/%Y %H:%M:%S")

            report = f"""
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        แจ้งข้อมูลการรีเซ็ตรหัสผ่าน
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

เรียน ผู้ใช้งาน

ระบบได้ดำเนินการรีเซ็ตรหัสผ่านบัญชีของท่านเรียบร้อยแล้ว

ข้อมูลบัญชี
────────────────────────────────────────
Username : {username}
User ID  : {row['id']}
Role     : {row['role']}
วันที่   : {now}
────────────────────────────────────────

🔐 รหัสผ่านใหม่
────────────────────────────────────────
{new_password}
────────────────────────────────────────

กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่ และเปลี่ยนรหัสผ่าน
เป็นของตนเองทันทีหลังจากเข้าสู่ระบบ

หมายเหตุ:
• รหัสผ่านเดิมไม่สามารถใช้งานได้แล้ว
• ข้อมูล Database ได้สำรองก่อนดำเนินการ
• หากไม่ใช่ผู้ร้องขอการรีเซ็ต กรุณาติดต่อผู้ดูแลระบบทันที

ขอบคุณ
ผู้ดูแลระบบ
""".strip()

            self.last_report = report
            self.report_btn.config(state="normal")
            self.status_var.set(
                f"✓ รีเซ็ต {username} สำเร็จ • สร้างรายงานแล้ว"
            )

            ResetReport(self.root, report, username)

        except Exception as e:
            messagebox.showerror(
                "รีเซ็ตไม่สำเร็จ",
                "ไม่มีการเปลี่ยนรหัสผ่านหากเกิดข้อผิดพลาดก่อน commit\n\n"
                + str(e),
                parent=self.root
            )
            self.status_var.set("เกิดข้อผิดพลาด • กรุณาตรวจสอบ")
        finally:
            self.reset_btn.config(state="normal")

    def open_last_report(self):
        if not self.last_report:
            return
        ResetReport(
            self.root,
            self.last_report,
            self.user_var.get() or "user"
        )


if __name__ == "__main__":
    root = tk.Tk()
    try:
        root.tk.call("tk", "scaling", 1.15)
    except Exception:
        pass

    App(root)
    root.mainloop()

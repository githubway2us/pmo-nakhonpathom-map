# Reset Admin GUI

ไฟล์: `reset_admin_gui.py`

## ติดตั้ง

ถ้า database เดิมของ Node.js ใช้ `bcryptjs` ตามโค้ดที่ส่งมา ให้ติดตั้ง:

```powershell
pip install bcrypt
```

## รัน

```powershell
python reset_admin_gui.py
```

จากนั้น:
1. เลือก `data.db`
2. เลือก username
3. ตรวจสอบ Role/Status
4. กด "รีเซ็ตรหัสผ่านบัญชีที่เลือก"
5. ยืนยัน 2 ครั้ง
6. โปรแกรมจะ backup DB ก่อน
7. สร้างรหัสใหม่แบบสุ่ม 16 ตัว
8. แสดงรหัสใหม่หลังบันทึกสำเร็จ

Backup จะอยู่ในโฟลเดอร์ `backups` ข้างไฟล์ database

**สำคัญ:** โปรแกรมตั้ง `BCRYPT = True` เพราะ schema/สคริปต์เดิมที่ให้มาใช้ `bcryptjs` และรอบ bcrypt = 12

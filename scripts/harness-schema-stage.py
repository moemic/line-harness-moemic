"""本番定義だけを一時SQLiteへ複製し、追加migrationによる既存定義の保持を確認する。"""
import json
import sqlite3
import sys
from pathlib import Path

schema = json.loads(Path(sys.argv[1]).read_text())
migrations = json.loads(Path(sys.argv[2]).read_text())
db = sqlite3.connect(':memory:')
for item in schema:
    db.executescript(item['sql'])
before = dict(db.execute("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL"))
db.execute('CREATE TABLE _harness_preservation_guard (value TEXT)')
db.execute("INSERT INTO _harness_preservation_guard VALUES ('preserve')")
for sql in migrations:
    db.executescript(sql)
after = dict(db.execute("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL"))
assert all(after.get(name) == sql for name, sql in before.items()), '既存schemaが変わりました'
assert db.execute('SELECT value FROM _harness_preservation_guard').fetchall() == [('preserve',)]
print(json.dumps({'stagingSchemaVerified': True, 'existingObjectsPreserved': len(before), 'newObjects': len(after) - len(before) - 1}))

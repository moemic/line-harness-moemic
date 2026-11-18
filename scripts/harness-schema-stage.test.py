"""追加カラムを許可し、既存カラム・indexの破壊は拒否する。"""
import json
import subprocess
import tempfile
from pathlib import Path
script = Path(__file__).with_name('harness-schema-stage.py')
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    schema = [{'sql': 'CREATE TABLE staff_members (id TEXT PRIMARY KEY, api_key TEXT NOT NULL)'},
              {'sql': 'CREATE INDEX staff_key ON staff_members(api_key)'}]
    (root / 'schema.json').write_text(json.dumps(schema))
    for sql, success in [
        ('ALTER TABLE staff_members ADD COLUMN api_key_hash TEXT; CREATE TABLE admin_sessions (id TEXT)', True),
        ('DROP TABLE staff_members;', False),
        ('ALTER TABLE staff_members RENAME COLUMN api_key TO lost;', False),
        ('DROP INDEX staff_key;', False),
    ]:
        (root / 'migrations.json').write_text(json.dumps([sql]))
        result = subprocess.run(['python3', str(script), str(root / 'schema.json'), str(root / 'migrations.json')], capture_output=True)
        assert (result.returncode == 0) == success, sql
print('追加カラム/テーブル成功、既存テーブル/カラム/index破壊拒否の回帰成功')

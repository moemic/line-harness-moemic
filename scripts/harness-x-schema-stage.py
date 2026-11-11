"""既存Xデータを一時SQLiteで移行し、予約時刻と認証・連携を照合する。値は出力しない。"""
import json
import sqlite3
import sys
from pathlib import Path
stage = json.loads(Path(sys.argv[1]).read_text())
db = sqlite3.connect(':memory:')
for row in stage['schema']:
    db.executescript(row['sql'])
for table, rows in stage['data'].items():
    for row in rows:
        keys = list(row)
        db.execute(f'INSERT INTO {table} ({",".join(keys)}) VALUES ({",".join("?" for _ in keys)})', [row[k] for k in keys])
db.commit()
for sql in stage['migrations']:
    db.executescript(sql)
for table, rows in stage['data'].items():
    assert db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] == len(rows), f'{table}: 件数不一致'
    for row in rows:
        keys = list(row)
        actual = db.execute(f'SELECT {",".join(keys)} FROM {table} WHERE id=?', [row['id']]).fetchone()
        for key, value in zip(keys, actual):
            if table == 'scheduled_posts' and key == 'scheduled_at':
                old = row[key].replace(' ', 'T')
                if not (old.endswith('Z') or old[-6:-5] in ('+', '-')):
                    old += '+09:00'
                a, b = db.execute('SELECT julianday(?),julianday(?)', (old, value)).fetchone()
                assert a is not None and abs(a-b) < 1e-8, '予約時刻不一致'
            else:
                assert value == row[key], f'{table}.{key}: 既存値不一致'
print(json.dumps({'xStagingVerified': True, 'preservedRows': {k: len(v) for k,v in stage['data'].items()}}))

"""Run production timeline SQL against SQLite; measure bounded storage with 50 devices.

Rust integration tests cover the buffer/flush lifecycle separately.
"""
import re
import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'zen-traffic/crates/zen-trafficd/src/persistence.rs').read_text(encoding='utf8')
SCHEMA = re.search(r'"(CREATE TABLE IF NOT EXISTS devices .*?)",\s*\)', SOURCE, re.S).group(1)
BODY = SOURCE.split('pub fn save_device_timeline(', 1)[1].split('pub fn wan_window(', 1)[0]
QUERIES = re.findall(r'"((?:INSERT|SELECT|DELETE)[^"]+)"', BODY)
def sql(prefix, table='device_usage_hour'):
    matches = [q for q in QUERIES if q.startswith(prefix)]
    assert len(matches) == 1, (prefix, matches)
    return matches[0].replace('{table}', table)

TABLES = ('device_usage_hour',)
class TimelineSqlTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.executescript(SCHEMA)

    def test_additive_buckets_and_device_isolation(self):
        for table in TABLES:
            self.db.executemany(sql('INSERT INTO {table}', table), [('a',3600,2_000_000_000,100),('a',3600,1_000_000_000,200),('b',3600,7,8)])
            query = sql('SELECT time,download,upload')
            self.assertEqual(self.db.execute(query,('a',0,7200)).fetchall(), [(3600,3_000_000_000,300)])
            self.assertEqual(self.db.execute(query,('b',0,7200)).fetchall(), [(3600,7,8)])
            self.assertEqual(self.db.execute(query,('a',3601,7200)).fetchall(), [])
        reset = SOURCE.split('pub fn reset_device(',1)[1]
        for query in re.findall(r'"(DELETE FROM device_usage_[^"]+)"',reset):
            self.db.execute(query,('a',))
        for table in TABLES:
            self.assertEqual(self.db.execute(f'SELECT mac FROM {table}').fetchall(), [('b',)])

    def test_failed_settings_write_rolls_back_hourly_deltas(self):
        self.db.execute("CREATE TRIGGER fail BEFORE INSERT ON app_settings BEGIN SELECT RAISE(ABORT,'full'); END")
        self.db.commit()
        with self.assertRaises(sqlite3.DatabaseError):
            with self.db:
                for table in TABLES:
                    self.db.execute(sql('INSERT INTO {table}',table), ('a',3600,100,0))
                self.db.execute("INSERT INTO app_settings VALUES('timeline_since','3600')")
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM device_usage_hour').fetchone()[0],0)
        self.db.execute('DROP TRIGGER fail')
        with self.db:
            for table in TABLES:
                self.db.execute(sql('INSERT INTO {table}',table),('a',3600,100,0))
        self.assertEqual(self.db.execute('SELECT download FROM device_usage_hour').fetchone()[0],100)

    def test_retention_boundary_and_complete_quota_buckets(self):
        self.db.executemany(sql('INSERT INTO {table}'), [('a',t,1,0) for t in (3600,7200,10800)])
        self.db.execute(sql('DELETE FROM {table} WHERE time <='),(7200,0))
        self.assertEqual(self.db.execute('SELECT time FROM device_usage_hour').fetchall(),[(10800,)])
        self.db.executemany(sql('INSERT INTO {table}'), [('b',10800,1,0),('a',14400,1,0),('b',14400,1,0)])
        last = self.db.execute(sql('SELECT MAX(time)'),(3,)).fetchone()[0]
        self.assertEqual(last,10800)
        self.db.execute(sql('DELETE FROM {table} WHERE time < ?1'),(last+3600,))
        self.assertEqual(self.db.execute('SELECT time FROM device_usage_hour').fetchall(),[(14400,),(14400,)])
        self.assertIsNone(self.db.execute(sql('SELECT MAX(time)'),(3,)).fetchone()[0])

    def test_upgrade_removes_detail_only_and_is_repeatable(self):
        self.db.executescript("""
            CREATE TABLE device_usage_5m(mac TEXT,time INTEGER,download INTEGER,upload INTEGER);
            INSERT INTO device_usage_5m VALUES('a',3600,50,1);
            INSERT INTO device_usage_hour VALUES('a',3600,100,2);
            INSERT INTO daily_usage VALUES('a','2026-10-10',100,2);
            INSERT INTO app_settings VALUES('timeline_since','3600');
            INSERT INTO app_settings VALUES('timeline_hour_floor','0');
            INSERT INTO app_settings VALUES('timeline_fine_floor','300');
        """)
        migration = re.search(r'"(BEGIN;\s*DROP TABLE IF EXISTS device_usage_5m;.*?)",', SOURCE, re.S).group(1)
        for _ in range(2):
            self.db.executescript(migration)
            self.assertIsNone(self.db.execute("SELECT name FROM sqlite_master WHERE name='device_usage_5m'").fetchone())
            self.assertEqual(self.db.execute('SELECT download,upload FROM device_usage_hour').fetchone(),(100,2))
            self.assertEqual(self.db.execute('SELECT download_bytes,upload_bytes FROM daily_usage').fetchone(),(100,2))
            self.assertEqual(dict(self.db.execute('SELECT * FROM app_settings')),{'timeline_since':'3600','timeline_hour_floor':'0'})

    def test_storage_50_continuously_active_devices_and_page_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'traffic.db'
            db = sqlite3.connect(path)
            try:
                db.executescript(SCHEMA)
                for table,step,days in zip(TABLES,(3600,),(30,)):
                    with db:
                        db.executemany(sql('INSERT INTO {table}',table),
                            ((f'02:00:00:00:{device:02x}:01',1_800_000_000+n*step,10_000_000,100_000)
                             for device in range(50) for n in range(days*86400//step)))
                rows = sum(db.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] for t in TABLES)
                self.assertEqual(rows,36000)
                initial = path.stat().st_size
                with db:
                    for table in TABLES: db.execute(f'DELETE FROM {table}')
                self.assertGreater(db.execute('PRAGMA freelist_count').fetchone()[0],0)
                with db:
                    db.executemany(sql('INSERT INTO {table}'),((f'02:00:00:00:{d:02x}:01',1_900_000_000+n*3600,1,0) for d in range(50) for n in range(720)))
                self.assertLessEqual(path.stat().st_size,initial)
                print(f'50 active devices: {rows:,} rows, {initial/1024**2:.2f} MiB SQLite file; freed pages reused')
            finally: db.close()

if __name__ == '__main__': unittest.main()

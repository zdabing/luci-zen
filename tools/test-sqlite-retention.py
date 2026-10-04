"""Exercise production retention SQL with SQLite, without compiling Rust."""
import re
import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "zen-traffic/crates/zen-trafficd/src"
PERSISTENCE = (SRC / "persistence.rs").read_text(encoding="utf-8")
SCHEMA = re.search(
    r'"(CREATE TABLE IF NOT EXISTS devices .*?)",\s*\)', PERSISTENCE, re.S
).group(1)


def cleanup_sql(method):
    body = PERSISTENCE.split("fn checkpoint_inner(", 1)[1].split("pub fn wan_window(", 1)[0]
    queries = re.findall(r'\.execute\("([^"]+)"', body)
    table = {"prune_days": "daily_usage", "prune_months": "monthly_usage"}[method]
    matches = [sql for sql in queries if sql.startswith(f"DELETE FROM {table} ")]
    assert len(matches) == 1, f"checkpoint must clean {table} exactly once"
    return matches[0]


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.executescript(SCHEMA)
        for mac in ("02:00:00:00:00:01", "02:00:00:00:00:02"):
            self.db.execute(
                "INSERT INTO devices (mac, rx_total, tx_total) VALUES (?, 123, 456)",
                (mac,),
            )
            for date in ("2026-07-01", "2026-07-02", "2026-09-30"):
                self.db.execute("INSERT INTO daily_usage VALUES (?, ?, 111, 222)", (mac, date))
            for month in ("2025-08", "2025-09", "2026-09"):
                self.db.execute("INSERT INTO monthly_usage VALUES (?, ?, 333, 444)", (mac, month))
        self.db.commit()

    def rows(self, table):
        return self.db.execute(f"SELECT * FROM {table} ORDER BY 1, 2").fetchall()

    def test_daily_cleanup_preserves_monthly_and_device_totals(self):
        monthly, devices = self.rows("monthly_usage"), self.rows("devices")
        self.db.execute(cleanup_sql("prune_days"), {"1": "2026-07-02"})
        self.assertEqual(self.rows("monthly_usage"), monthly)
        self.assertEqual(self.rows("devices"), devices)
        self.assertEqual({r[1] for r in self.rows("daily_usage")}, {"2026-07-02", "2026-09-30"})

    def test_monthly_cleanup_preserves_daily_and_device_totals(self):
        daily, devices = self.rows("daily_usage"), self.rows("devices")
        self.db.execute(cleanup_sql("prune_months"), {"1": "2025-09"})
        self.assertEqual(self.rows("daily_usage"), daily)
        self.assertEqual(self.rows("devices"), devices)
        self.assertEqual({r[1] for r in self.rows("monthly_usage")}, {"2025-09", "2026-09"})

    def test_combined_rollover_is_repeatable(self):
        for _ in range(2):
            self.db.execute(cleanup_sql("prune_days"), {"1": "2026-07-02"})
            self.db.execute(cleanup_sql("prune_months"), {"1": "2025-09"})
            self.assertEqual(len(self.rows("daily_usage")), 4)
            self.assertEqual(len(self.rows("monthly_usage")), 4)
        self.assertEqual(len(self.rows("devices")), 2)

    def test_failed_monthly_cleanup_rolls_back_daily_cleanup(self):
        before = {table: self.rows(table) for table in ("daily_usage", "monthly_usage", "devices")}
        self.db.execute("CREATE TRIGGER reject_cleanup BEFORE DELETE ON monthly_usage "
                        "BEGIN SELECT RAISE(ABORT,'test storage failure'); END")
        self.db.commit()
        with self.assertRaises(sqlite3.DatabaseError):
            with self.db:
                self.db.execute(cleanup_sql("prune_days"), {"1": "2026-07-02"})
                self.db.execute(cleanup_sql("prune_months"), {"1": "2025-09"})
        for table, rows in before.items():
            self.assertEqual(self.rows(table), rows)


if __name__ == "__main__":
    unittest.main()

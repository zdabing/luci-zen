"""Run production realtime SQLite statements without compiling the daemon."""
import re
import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "zen-traffic/crates/zen-trafficd/src/persistence.rs").read_text(encoding="utf-8")
SCHEMA = re.search(r'"(CREATE TABLE IF NOT EXISTS devices .*?)",\s*\)', SOURCE, re.S).group(1)
INSERT = re.search(r'prepare_cached\(\s*"(INSERT INTO realtime_usage.*?)"', SOURCE, re.S).group(1)
DELETE = re.search(r'"(DELETE FROM realtime_usage[^"]+)"', SOURCE).group(1)
QUERY = re.search(r'"(SELECT \(\(timestamp - \?2\).*?)"', SOURCE, re.S).group(1)


class RealtimeTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.executescript(SCHEMA)
        self.now = 1_790_769_600

    def insert(self, interface, timestamp, dl, ul):
        self.db.execute(INSERT, (interface, timestamp, dl, ul))

    def query(self, start, end, step=5, pending_from=2**63-1, interface="pppoe-wan"):
        return self.db.execute(QUERY, (interface, start, end, step, pending_from)).fetchall()

    def test_seven_day_cleanup_preserves_boundary_and_other_tables(self):
        cutoff = self.now - 7 * 86400
        for t in (cutoff-1, cutoff, self.now):
            self.insert("pppoe-wan", t, 100, 200)
        self.db.execute("INSERT INTO devices (mac, rx_total) VALUES ('device', 123)")
        self.db.execute("INSERT INTO daily_usage VALUES ('device', '2026-09-30', 123, 456)")
        self.db.execute("INSERT INTO monthly_usage VALUES ('device', '2026-09', 123, 456)")
        self.db.execute(DELETE, (cutoff,))
        self.assertEqual(self.db.execute("SELECT timestamp FROM realtime_usage ORDER BY timestamp").fetchall(), [(cutoff,), (self.now,)])
        for table in ("devices", "daily_usage", "monthly_usage"):
            self.assertEqual(self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 1)

    def test_retry_upserts_without_duplicating_samples(self):
        self.insert("pppoe-wan", self.now, 100, 200)
        self.insert("pppoe-wan", self.now, 300, 400)
        self.assertEqual(self.query(self.now, self.now), [(self.now, 300, 400, 1)])

    def test_query_isolates_interface_and_pending_boundary(self):
        for t in (self.now-10, self.now-5, self.now):
            self.insert("pppoe-wan", t, 100, 200)
            self.insert("eth1", t, 999, 999)
        self.assertEqual(self.query(self.now-10, self.now, pending_from=self.now-5), [(self.now-10, 100, 200, 1)])

    def test_aggregation_keeps_zero_samples_and_correct_sums(self):
        self.insert("pppoe-wan", self.now-10, 0, 0)
        self.insert("pppoe-wan", self.now-5, 100, 200)
        self.insert("pppoe-wan", self.now, 50, 60)
        self.assertEqual(self.query(self.now-10, self.now, step=10), [(self.now-10, 100, 200, 2), (self.now, 50, 60, 1)])

    def test_full_week_returns_bounded_results(self):
        start = self.now - 7 * 86400
        self.db.executemany(INSERT, (("pppoe-wan", t, 100, 200) for t in range(start, self.now+1, 5)))
        limit = 600
        step = ((self.now-start)//limit//5+1)*5
        rows = self.query(start, self.now, step)
        self.assertLessEqual(len(rows), limit)
        self.assertEqual(sum(row[3] for row in rows), 120961)
        self.assertTrue(all(row[1]//row[3] == 100 and row[2]//row[3] == 200 for row in rows))
        plan = self.db.execute("EXPLAIN QUERY PLAN " + QUERY, ("pppoe-wan", start, self.now, step, 2**63-1)).fetchall()
        self.assertTrue(any("USING INDEX" in row[3] and "interface=?" in row[3] for row in plan))


if __name__ == "__main__":
    unittest.main()

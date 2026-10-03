"""Validate the optional fixture clock in child processes; parent time is untouched."""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

library = str(Path(sys.argv[1]).resolve())
with tempfile.TemporaryDirectory(prefix="zen-clock-test-") as folder:
    epoch_file = Path(folder) / "epoch"
    epoch_file.write_text("1704067200\n", encoding="ascii")
    env = {**os.environ, "LD_PRELOAD": library, "ZEN_TEST_EPOCH_FILE": str(epoch_file)}
    code = """
import datetime,json,os,time
from pathlib import Path
assert int(time.time())==1704067200
assert datetime.datetime.now(datetime.timezone.utc).year==2024
start=time.monotonic();time.sleep(.05);assert time.monotonic()-start>=.04
path=Path(os.environ['ZEN_TEST_EPOCH_FILE'])
path.write_text('1790784000\\n',encoding='ascii')
assert int(time.time())==1790784000
path.write_text('invalid\\n',encoding='ascii')
assert abs(time.time()-REAL_PARENT_TIME)<10
print(json.dumps({'controlled_realtime':True,'monotonic_unchanged':True,'invalid_falls_back':True}))
""".replace("REAL_PARENT_TIME", repr(time.time()))
    result = subprocess.run([sys.executable, "-c", code], env=env, text=True, capture_output=True, check=True)
    print(result.stdout.strip())
    assert time.time() > 1704067200 + 86400

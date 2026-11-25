#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root=Path(os.environ["RELAY_FIXTURE"])
if (root/"offline").exists(): sys.exit(2)
with (root/"deliveries.jsonl").open("a") as f: f.write(json.dumps(sys.argv[1:],ensure_ascii=False)+"\n")

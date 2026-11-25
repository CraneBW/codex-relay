#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root=Path(os.environ["RELAY_FIXTURE"])
command, target, *args = sys.argv[1:]


def record(filename, packet):
    with (root / filename).open("a") as f:
        f.write(json.dumps(packet, ensure_ascii=False) + "\n")


if command == "get-conversation-metadata":
    record("metadata-queries.jsonl", target)
    path = root / "metadata.json"
    if not path.exists() or (metadata := json.loads(path.read_text()).get(target)) is None:
        sys.exit("对话不存在")
    print(json.dumps({"response": {"conversationMetadata": {"metadata": metadata, "staticConfig": "x" * 500_000}}}))
elif command == "send-message":
    record("delivery-attempts.jsonl", sys.argv[1:])
    if (root / f"dead-{target}").exists():
        sys.exit("目标子代理已退出")
    if (root / "offline").exists():
        sys.exit(2)
    record("deliveries.jsonl", sys.argv[1:])
else:
    sys.exit("不支持的 agentapi 命令")

import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
_temporary = tempfile.TemporaryDirectory(prefix="codex-relay-test-")
TEMP = Path(_temporary.name)
PROJECT = TEMP / "project"
PROJECT.mkdir()
ORIGIN = str(uuid.uuid4())
NOTICES = TEMP / "deliveries.jsonl"
ENV = dict(os.environ, CODEX_RELAY_DATA=str(TEMP / "state"), CODEX_RELAY_SOCKET_DIR=str(TEMP / "socket"),
           RELAY_FIXTURE=str(TEMP), CODEX_RELAY_AGENTAPI=str(Path(__file__).parent.resolve() / "notify.py"))
(TEMP / "info").write_text(str(ORIGIN))


def start_worker():
    p = subprocess.Popen(["node", "worker.mjs"], cwd=ROOT / "sidecars/events", env=ENV,
                         stdout=(TEMP / "worker.out").open("a"), stderr=(TEMP / "worker.err").open("a"))
    for _ in range(150):
        if p.poll() is not None:
            raise RuntimeError((TEMP / "worker.err").read_text()[-1500:])
        if (TEMP / "socket/events.sock").exists():
            return p
        time.sleep(.04)
    raise TimeoutError("sidecar startup")


class MCP:
    def __init__(self):
        self.p = subprocess.Popen(["node", "dist/server.cjs"], cwd=ROOT, env=ENV, text=True,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=(TEMP / "mcp.err").open("a"), bufsize=1)
        self.index = 0
        self.req("initialize", {"clientInfo": {"name": "relay-check", "version": "1"}, "protocolVersion":"2025-11-25", "capabilities":{}})
        self.send({"method":"notifications/initialized"})

    def send(self, packet):
        self.p.stdin.write(json.dumps({"jsonrpc":"2.0", **packet})+"\n")
        self.p.stdin.flush()

    def req(self, method, params):
        self.index += 1
        self.send({"id":self.index,"method":method,"params":params})
        deadline = time.monotonic()+46
        while time.monotonic()<deadline:
            if not select.select([self.p.stdout],[],[],max(0,deadline-time.monotonic()))[0]:
                break
            line=self.p.stdout.readline()
            if not line: raise RuntimeError((TEMP / "mcp.err").read_text()[-900:])
            reply=json.loads(line)
            if reply.get("id")==self.index:
                if "error" in reply: raise RuntimeError(reply["error"])
                return reply["result"]
        raise TimeoutError(method)

    def call(self, name, args):
        res=self.req("tools/call",{"name":name,"arguments":args})
        if res.get("isError"): raise RuntimeError(res["content"][0]["text"])
        return res.get("structuredContent")

    def scoped(self, name, args, origin=ORIGIN):
        event={"conversationId":origin,"workspacePaths":[str(PROJECT)],"toolCall":{"name":name,"args":args},"stepIdx":3}
        hook=json.loads(subprocess.check_output(["node","scripts/context.mjs"],cwd=ROOT,env=ENV,input=json.dumps(event),text=True))
        assert hook["decision"]=="allow"
        return self.call(name,{**args,**hook["overwrite"]})

    def dispatch(self,key,goal,mode="write"):
        return self.scoped("relay_dispatch",{"requestKey":key,"title":key,"goal":goal,"difficulty":"simple","mode":mode})

    def inspect(self, task): return self.scoped("relay_inspect",{"id": task})
    def control(self, task, action, note="", **extra):
        return self.scoped("relay_control",{"id":task,"action":action,"note":note,**extra})

    def close(self):
        self.p.stdin.close()
        try: self.p.wait(timeout=4)
        except subprocess.TimeoutExpired: self.p.terminate(); self.p.wait()


def messages():
    return [json.loads(v) for v in NOTICES.read_text().splitlines()] if NOTICES.exists() else []


def notice(task, start=0, timeout=220):
    until=time.monotonic()+timeout
    while time.monotonic()<until:
        for packet in messages()[start:]:
            if task in packet[2]:
                assert packet[:2]==["send-message",ORIGIN]
                return packet
        time.sleep(.1)
    raise TimeoutError("notice for "+task)


def until(fn, timeout=8):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        value=fn()
        if value: return value
        time.sleep(.05)
    raise TimeoutError("condition")


def main():
    print("Verification workspace",TEMP,flush=True)
    worker=start_worker(); m=MCP()
    try:
        tools=m.req("tools/list",{})["tools"]
        assert len(tools)==6
        assert m.call("relay_board",{})["total"]==0
        assert "ui://codex-relay/board.html"==m.req("resources/list",{})["resources"][0]["uri"]
        panel=m.req("resources/read",{"uri":"ui://codex-relay/board.html"})["contents"][0]
        assert panel["mimeType"]=="text/html;profile=mcp-app" and "<script>" in panel["text"]
        task=m.dispatch("真实文件及验收测试",
          "仅在指定工作目录完成以下任务。先用命令检查 input.txt。这个文件必须由反重力提供；如果缺少，请立即按协议报告 blocked，等待它补充，不要创建输入或替代内容。"
          "一旦 input.txt 已由反重力提供，读取其内容，转成大写保存到 result.txt，再用命令核对结果。通过后报告 done。")["id"]
        print("Dispatched",task,flush=True)
        notice(task); first=m.inspect(task)
        print("First outcome",first["status"],first["result"],flush=True)
        assert first["status"]=="blocked" and first["threadId"]
        assert first["command"],"First real command was not observed"
        assert first["model"]=="gpt-6-luna" and first["effort"]=="low"
        assert m.control(task,"takeover",expectedNotice=first["noticeId"])["status"]=="host"
        (PROJECT/"input.txt").write_text("codex relay\n")
        n=len(messages()); m.control(task,"resume","反重力已补好 input.txt。请完成原任务并验证。",difficulty="standard")
        notice(task,n); second=m.inspect(task)
        print("Second outcome",second["status"],second["result"],flush=True)
        assert second["threadId"]==first["threadId"] and second["status"]=="review"
        assert second["model"]=="gpt-6.2-sol" and second["effort"]=="high"
        assert (PROJECT/"result.txt").read_text()=="CODEX RELAY\n"
        assert m.control(task,"accept","已核实转换结果。")["status"]=="done"
        assert len(messages())==2
        print("PASS actual Luna low to Sol high in same thread, final file, exactly two event deliveries",flush=True)
    finally:
        m.close(); worker.terminate(); worker.wait(timeout=12)


if __name__=="__main__": main()

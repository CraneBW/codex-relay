#!/usr/bin/env python3
import json, os, sys, threading, time, uuid
from pathlib import Path

root=Path(os.environ["RELAY_FIXTURE"])
def save_thread(thread, turns):
    # Per-thread files allow simultaneous read-only and write tasks.
    (root/(thread+".history")).write_text(json.dumps(turns))
def turns(thread):
    path=root/(thread+".history")
    return json.loads(path.read_text()) if path.exists() else []
def send(x): print(json.dumps(x),flush=True)
def reply(x, data): send({"id":x["id"],"result":data})
def event(name,data): send({"method":name,"params":data})
def permissions(params):
    return {key: params[key] for key in ("sandbox", "approvalPolicy", "sandboxPolicy") if key in params}

def keep_turn_active(thread_id, turn_id, command_id):
    for _ in range(20):
        time.sleep(.1)
        event("item/commandExecution/outputDelta", dict(threadId=thread_id, turnId=turn_id, itemId=command_id, delta="heartbeat\n"))
    (root / (thread_id + '.heartbeat')).touch()


def finish(kind):
    data={"outcome":kind,"summary":"验证交付" if kind=="done" else "缺输入","evidence":"测试证据","next":"由反重力补输入" if kind=="blocked" else ""}
    if discussion:
        data["disagreement"] = ""
        if "WIDE_CONTEXT" in turn["items"][0]["content"][0]["text"]:
            data.update(summary="摘要" * 700, evidence="证据" * 900, disagreement="替代解释仍需源数据")
    i={"type":"agentMessage","text":json.dumps(data),"id":"message","phase":"final_answer"}
    event("item/completed", dict(threadId=thread,turnId=turn["id"],item=i))
    turn["items"].append(i); turn["status"]="completed"; save_thread(thread,records)
    event("turn/completed",dict(threadId=thread,turn=turn))

for raw in sys.stdin:
    x=json.loads(raw); m=x.get("method"); p=x.get("params",{})
    if m=="initialize": reply(x,{"userAgent":"fixture","platformOs":"linux"})
    elif m in ["thread/start","thread/resume"]:
        thread=p.get("threadId") or str(uuid.uuid4()); records=turns(thread)
        selected_model=p.get("model")
        if selected_model not in ("gpt-6-luna","gpt-6.1-terra","gpt-6.2-sol","gpt-6.2-astra"): sys.exit(3)
        selected_effort=p["config"]["model_reasoning_effort"]
        thread_method=m
        thread_permissions=permissions(p)
        reply(x,{"thread":{"id":thread,"status":{"type":"idle"}}})
    elif m=="thread/turns/list": reply(x,{"data":list(reversed(records)),"nextCursor":None})
    elif m=="turn/start":
        assert (p["model"],p["effort"])==(selected_model,selected_effort)
        assert p["effort"] in ("low","medium","high","xhigh","max") or (selected_model=="gpt-6.1-terra" and p["effort"]=="ultra")
        assert p["outputSchema"]["additionalProperties"] is False
        discussion = "disagreement" in p["outputSchema"]["properties"]
        if discussion:
            assert selected_model == "gpt-6.2-astra"
            assert (thread_permissions["sandbox"], thread_permissions["approvalPolicy"], selected_effort) == ("read-only", "on-request", "max")
            assert permissions(p) == {"approvalPolicy": "on-request"}
        text=p["input"][0]["text"]; turn={"id":str(uuid.uuid4()),"status":"inProgress","items":[{"type":"userMessage","content":p["input"]}]}
        turn["rpcProfiles"]={thread_method:[selected_model,selected_effort],m:[p["model"],p["effort"]]}
        turn["rpcPermissions"]={thread_method:thread_permissions,m:permissions(p)}
        records.append(turn); save_thread(thread,records); reply(x,{"turn":turn}); event("turn/started",dict(threadId=thread,turn=turn))
        c={"id":str(uuid.uuid4()),"type":"commandExecution","command":"python -m pytest","status":"inProgress","exitCode":None}
        event("item/started",dict(threadId=thread,turnId=turn["id"],item=c))
        event("item/commandExecution/outputDelta",dict(threadId=thread,turnId=turn["id"],itemId=c["id"],delta="fixture log\n"))
        heartbeat = "HOLD HEARTBEAT" in text
        if not heartbeat:
            c.update(status="failed",exitCode=1); event("item/completed",dict(threadId=thread,turnId=turn["id"],item=c))
        if "MULTI_COMMAND" in text:
            pending = []
            for step in range(1, 6):
                item = dict(id=str(uuid.uuid4()), type="commandExecution", command=f"fixture-step-{step}", status="inProgress")
                event("item/started", dict(threadId=thread, turnId=turn["id"], item=item))
                pending.append(item)
            for step, item in reversed(list(enumerate(pending, 1))):
                event("item/commandExecution/outputDelta", dict(threadId=thread, turnId=turn["id"], itemId=item["id"], delta=f"output-{step}\n"))
                item.update(status="failed" if step == 1 else "completed", exitCode=7 if step == 1 else 0)
                event("item/completed", dict(threadId=thread, turnId=turn["id"], item=item))
        if "原目标" in text or "上次应用退出" in text or "QUICK" in text: finish("done")
        elif "NATIVE" in text:
            send({"id":890,"method":"item/commandExecution/requestApproval","params":{"threadId":thread,"turnId":turn["id"],"command":"example","reason":"needs host"}})
        elif "BLOCK" in text: finish("blocked")
        elif heartbeat:
            threading.Thread(target=keep_turn_active, args=(thread, turn["id"], c["id"]), daemon=True).start()
        elif "HOLD" not in text: finish("done")
    elif m=="turn/steer":
        reply(x,{"turnId":turn["id"]})
        if "finish" in p["input"][0]["text"]: finish("done")
    elif m=="turn/interrupt":
        reply(x,{})
        if turn["status"]=="inProgress":
            turn["status"]="interrupted";save_thread(thread,records);event("turn/completed",dict(threadId=thread,turn=turn))

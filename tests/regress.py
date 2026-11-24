import json, os, signal, time, uuid
from pathlib import Path
from probe import ENV, MCP, NOTICES, ORIGIN, PROJECT, TEMP, messages, notice, start_worker, until

ENV["CODEX_RELAY_CODEX"]=str(Path(__file__).parent.resolve()/"fake_codex.py")

luna, terra, sol, astra = "gpt-6-luna", "gpt-6.1-terra", "gpt-6.2-sol", "gpt-6.2-astra"


def assert_profile(view, model, effort, difficulty):
    assert (view["model"], view["effort"], view["difficulty"]) == (model, effort, difficulty), view


def check_profile(m, task, model, effort, difficulty, thread_method):
    view = m.inspect(task)
    assert view["status"] == "review", view
    board = m.call("relay_board", {})
    selected = m.call("relay_board_changes", {"selected": task})["selected"]
    for display in (view, selected, next(t for t in board["tasks"] if t["id"] == task)):
        assert_profile(display, model, effort, difficulty)
    turns = json.loads((TEMP / (view["threadId"] + ".history")).read_text())
    assert turns[-1]["rpcProfiles"] == {thread_method: [model, effort], "turn/start": [model, effort]}, turns[-1]
    return view["threadId"], board["revision"]


def rejected(call, message):
    try:
        call()
    except RuntimeError as e:
        assert message in str(e), e
    else:
        raise AssertionError("请求应被拒绝")


def check_routing(m):
    cases = [
        ({"difficulty": "simple"}, luna, "low", "simple"),
        ({"difficulty": "browser"}, terra, "medium", "browser"),
        ({}, sol, "high", "standard"),
        ({"difficulty": "standard"}, sol, "high", "standard"),
        ({"difficulty": "hard"}, sol, "xhigh", "hard"),
        ({"difficulty": "exceptional"}, sol, "max", "exceptional"),
        ({"model": luna}, luna, "high", "standard"),
        ({"effort": "low"}, sol, "low", "standard"),
        ({"model": terra, "effort": "ultra"}, terra, "ultra", "standard"),
    ]
    for i, (overrides, model, effort, difficulty) in enumerate(cases):
        args = {"requestKey": f"route-{i}", "title": f"route-{i}", "goal": "QUICK", **overrides}
        item = m.scoped("relay_dispatch", args)
        task = item["id"]
        assert_profile(item, model, effort, difficulty)
        notice(task, timeout=12)
        thread, revision = check_profile(m, task, model, effort, difficulty, "thread/start")
        if overrides == {"effort": "low"}:
            for changes, next_model, next_effort, level in [
                ({"model": terra}, terra, "low", "standard"),
                ({"effort": "medium"}, terra, "medium", "standard"),
                ({}, terra, "medium", "standard"),
                ({"difficulty": "hard"}, sol, "xhigh", "hard"),
                ({"difficulty": "simple", "effort": "high"}, luna, "high", "simple"),
                ({"difficulty": "browser", "model": sol}, sol, "medium", "browser"),
            ]:
                n = len(messages())
                resumed = m.control(task, "resume", "继续核对结果", **changes)
                assert_profile(resumed, next_model, next_effort, level)
                notice(task, n, timeout=12)
                same_thread, new_revision = check_profile(m, task, next_model, next_effort, level, "thread/resume")
                assert same_thread == thread and new_revision != revision
                revision = new_revision
            retry = m.scoped("relay_dispatch", args)
            assert retry["id"] == task
            assert_profile(retry, sol, "medium", "browser")
            rejected(lambda: m.scoped("relay_dispatch", {**args, "effort": "medium"}), "requestKey")
            rejected(lambda: m.scoped("relay_dispatch", {**args, "model": terra}), "requestKey")
        m.control(task, "accept")
    print("PASS default routes, independent dispatch/resume overrides, original-profile retries, board and Codex RPC profiles")

    rejected(lambda: m.scoped("relay_dispatch", {"requestKey": "astra-execution", "title": "astra", "goal": "QUICK",
                                                 "model": astra}), "model")
    item = m.scoped("relay_discuss", {"requestKey": "discussion", "title": "discussion", "question": "QUICK", "position": "初步判断"})
    task = item["id"]
    notice(task, timeout=12)
    thread, _ = check_profile(m, task, astra, "max", None, "thread/start")
    original_notice = m.inspect(task)["noticeId"]
    for changes in ({"model": sol}, {"effort": "high"}, {"difficulty": "standard"}):
        rejected(lambda: m.control(task, "resume", "核对新证据", **changes), "Astra/max")
    assert m.inspect(task)["noticeId"] == original_notice
    n = len(messages())
    m.control(task, "resume", "核对新证据", model=astra, effort="max")
    notice(task, n, timeout=12)
    same_thread, _ = check_profile(m, task, astra, "max", None, "thread/resume")
    assert same_thread == thread
    m.control(task, "accept", "已综合双方判断")
    print("PASS discussion stays on Astra/max and rejects model, effort and difficulty changes")
    return len(cases) + 1


def check():
    print("Regression workspace",TEMP,flush=True)
    worker=start_worker();m=MCP()
    try:
        try: m.call("relay_dispatch",{"requestKey":"bad","title":"bad","goal":"bad","effort":"low"})
        except RuntimeError as e: assert "对话 ID" in str(e)
        else: raise AssertionError("no owner")
        try: m.scoped("relay_dispatch",{"requestKey":"over","title":"over","goal":"over","effort":"ultra"})
        except RuntimeError: pass
        else: raise AssertionError("Sol effort cap")
        try: m.call("relay_dispatch",{"requestKey":"fake","title":"fake","goal":"fake","effort":"max","origin":ORIGIN,"roots":[str(PROJECT)],"hostProof":"0"*64})
        except RuntimeError as e: assert "宿主校验" in str(e)
        else: raise AssertionError("forged context")
        routed_tasks = check_routing(m)
        base = len(messages())
        held=m.dispatch("one","HOLD")["id"]
        assert held==m.dispatch("one","HOLD")["id"]
        until(lambda: m.inspect(held)["command"])
        assert len(messages())==base
        print("PASS no wake for progress or an ordinary failing command; dispatch retry idempotent")
        other=m.dispatch("two","QUICK")["id"]
        assert m.inspect(other)["status"]=="queued"
        reader=m.dispatch("reader","QUICK","read")["id"];notice(reader)
        m.control(reader,"accept")
        try: m.scoped("relay_inspect",{"id":held},str(uuid.uuid4()))
        except RuntimeError: pass
        else: raise AssertionError("cross-conversation ownership")
        before=m.inspect(held)
        assert m.control(held,"takeover","手动排障")["status"]=="host"
        assert m.inspect(other)["status"]=="queued"
        m.control(held,"resume","已核对测试入口");notice(held)
        after=m.inspect(held);assert after["threadId"]==before["threadId"] and after["status"]=="review"
        m.control(held,"accept");notice(other);m.control(other,"accept")
        print("PASS write queue, concurrent reader, authenticated conversation, exclusive handoff")
        native=m.dispatch("native","NATIVE")["id"];notice(native)
        snap=m.inspect(native)
        assert "requestApproval" in snap["result"]["summary"] and "needs host" in snap["result"]["evidence"]
        m.control(native,"ask_user","请选择输入。"); assert m.inspect(native)["status"]=="waiting_user"
        m.control(native,"resume","用户已补齐输入");until(lambda:m.inspect(native)["status"]=="review")
        m.control(native,"accept");print("PASS native input handoff and user response")
        (TEMP/"offline").touch()
        block=m.dispatch("offline","BLOCK")["id"]
        until(lambda: m.inspect(block)["delivery"]=="retry")
        saved=m.inspect(block);assert saved["status"]=="blocked"
        (TEMP/"offline").unlink();notice(block);until(lambda:m.inspect(block)["delivery"]=="sent")
        m.control(block,"resume","新线索");until(lambda:m.inspect(block)["status"]=="review")
        m.control(block,"accept")
        print("PASS durable outbox retries with no agent polling")
        for how in ["clean","crash"]:
            args={"requestKey":how,"title":how,"goal":"HOLD "+how,"model":terra,"effort":"high"}
            t=m.scoped("relay_dispatch",args)["id"];until(lambda: m.inspect(t)["command"])
            thread=m.inspect(t)["threadId"];n=len(messages())
            if how=="clean": worker.terminate()
            else: worker.kill()
            worker.wait(timeout=10)
            worker=start_worker();notice(t,n)
            recovered, _ = check_profile(m, t, terra, "high", "standard", "thread/resume")
            assert recovered==thread and m.scoped("relay_dispatch",args)["id"]==t
            m.control(t,"accept")
        print("PASS orderly exit and crash recovery into the original thread")
        won=m.dispatch("finished-before-checkpoint","HOLD checkpoint")["id"]
        until(lambda:m.inspect(won)["command"]); original=m.inspect(won)
        worker.kill();worker.wait()
        h=TEMP/(original["threadId"]+".history")
        turns=json.loads(h.read_text()); turns[-1]["status"]="completed"
        turns[-1]["items"].append({"type":"agentMessage","text":json.dumps(
            {"outcome":"done","summary":"completed before crash","evidence":"original","next":""})})
        h.write_text(json.dumps(turns));worker=start_worker();notice(won)
        assert m.inspect(won)["result"]["summary"]=="completed before crash" and len(json.loads(h.read_text()))==len(turns)
        m.control(won,"accept");print("PASS recovered already-completed turn without replaying its commands")
        (TEMP/"offline").touch(); retry=m.dispatch("surviving-outbox","BLOCK wait")["id"]
        until(lambda:m.inspect(retry)["delivery"]=="retry");event=m.inspect(retry)["noticeId"]
        worker.terminate();worker.wait(timeout=10);(TEMP/"offline").unlink()
        worker=start_worker();notice(retry)
        assert m.inspect(retry)["noticeId"]==event
        m.control(retry,"cancel")
        print("PASS original event survives full restart; Sol ultra and forged context rejected")
        assert m.call("relay_board",{})["total"]==9+routed_tasks
        assert m.scoped("relay_inspect",{})["total"]==9+routed_tasks
        assert m.scoped("relay_inspect",{},str(uuid.uuid4()))["total"]==0
        print("PASS Antigravity can recover its own task list without asking for IDs")
    finally:
        m.close();worker.terminate();worker.wait(timeout=12)

if __name__=="__main__":check()

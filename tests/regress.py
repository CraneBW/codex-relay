import json, sqlite3, uuid
from pathlib import Path
from probe import ENV, MCP, NOTICES, ORIGIN, PROJECT, TEMP, messages, notice, start_worker, until

ENV["CODEX_RELAY_CODEX"]=str(Path(__file__).parent.resolve()/"fake_codex.py")

luna, terra, sol, astra = "gpt-6-luna", "gpt-6.1-terra", "gpt-6.2-sol", "gpt-6.2-astra"
default_read = ("default", "read-only", "on-request")
default_write = ("default", "workspace-write", "on-request")
auto_write = ("auto", "workspace-write", "never")
full_access = ("full", "danger-full-access", "never")
access_fields = ("permission", "sandbox", "approvalPolicy")


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


def assert_access(view, expected):
    assert tuple(view[key] for key in access_fields) == expected, view


def check_access(m, task, expected, thread_method, status="review"):
    view = m.inspect(task)
    assert view["status"] == status, view
    board = m.call("relay_board", {})
    changes = m.call("relay_board_changes", {"selected": task})
    displays = [view, changes["selected"], next(t for t in board["tasks"] if t["id"] == task)]
    if view["graphId"]:
        for panel in (board, changes):
            graph = next(g for g in panel["graphs"] if g["graphId"] == view["graphId"] and g["origin"] == ORIGIN)
            displays.append(next(t for t in graph["nodes"] if t["id"] == task))
    for display in displays:
        assert_access(display, expected)
    _, sandbox, approval = expected
    turn_params = {"approvalPolicy": approval}
    if sandbox == "danger-full-access":
        turn_params["sandboxPolicy"] = {"type": "dangerFullAccess"}
    turns = json.loads((TEMP / (view["threadId"] + ".history")).read_text())
    assert turns[-1]["rpcPermissions"] == {
        thread_method: {"sandbox": sandbox, "approvalPolicy": approval}, "turn/start": turn_params,
    }, turns[-1]
    recorded = [event["text"] for event in view["events"] if event["kind"] == "permission"]
    assert recorded[-1] == " · ".join(expected), recorded
    return view["threadId"]


def check_permissions(m):
    tools = {tool["name"]: tool for tool in m.req("tools/list", {})["tools"]}
    for name in ("relay_dispatch", "relay_control"):
        schema = tools[name]["inputSchema"]
        assert all(field in schema["properties"] and field not in schema["required"] for field in access_fields)
    assert all(field not in tools["relay_discuss"]["inputSchema"]["properties"] for field in access_fields)

    cases = [
        ({"mode": "read"}, default_read),
        ({"mode": "write"}, default_write),
        ({"mode": "read", "permission": "auto"}, ("auto", "read-only", "never")),
        ({"permission": "auto"}, auto_write),
        ({"permission": "full"}, full_access),
        ({"approvalPolicy": "untrusted"}, ("custom", "workspace-write", "untrusted")),
        ({"sandbox": "danger-full-access"}, ("custom", "danger-full-access", "on-request")),
        ({"permission": "full", "sandbox": "read-only"}, ("custom", "read-only", "never")),
        ({"permission": "full", "approvalPolicy": "on-request"}, ("custom", "danger-full-access", "on-request")),
    ]
    for i, (changes, expected) in enumerate(cases):
        args = dict(requestKey=f"permission-{i}", title=f"permission-{i}", goal="QUICK", graphId="permissions", **changes)
        item = m.scoped("relay_dispatch", args)
        assert_access(item, expected)
        task = item["id"]
        notice(task, timeout=12)
        check_access(m, task, expected, "thread/start")
        assert m.inspect(task)["holdsWriteLock"] == (args.get("mode", "write") == "write")
        m.control(task, "accept")

    read = dict(requestKey="invalid-read", title="invalid-read", goal="QUICK", mode="read")
    for changes in ({"permission": "full"}, {"permission": "full", "sandbox": "read-only"},
                    {"sandbox": "workspace-write"}, {"sandbox": "danger-full-access"}):
        rejected(lambda: m.scoped("relay_dispatch", {**read, **changes}), "只读任务")
    for field, invalid in zip(access_fields, ("custom", "unknown", "always")):
        rejected(lambda: m.scoped("relay_dispatch", {**read, field: invalid}), field)

    args = dict(requestKey="permission-resume", title="审批阻塞后续跑", goal="NATIVE", graphId="permissions")
    task = m.scoped("relay_dispatch", args)["id"]
    notice(task, timeout=12)
    thread = check_access(m, task, default_write, "thread/start", "blocked")
    assert "requestApproval" in m.inspect(task)["result"]["summary"]
    rejected(lambda: m.control(task, "ask_user", "确认权限", permission="full"), "仅用于 resume")
    m.control(task, "ask_user", "确认所需权限")
    for changes, expected in [
        ({"permission": "auto"}, auto_write),
        ({"permission": "full"}, full_access),
        ({}, full_access),
        ({"approvalPolicy": "untrusted"}, ("custom", "danger-full-access", "untrusted")),
        ({"sandbox": "workspace-write"}, ("custom", "workspace-write", "untrusted")),
        ({"permission": "default"}, default_write),
    ]:
        n = len(messages())
        assert_access(m.control(task, "resume", "已取得测试用例所需授权，继续原任务", **changes), expected)
        notice(task, n, timeout=12)
        assert check_access(m, task, expected, "thread/resume") == thread
        assert_access(m.scoped("relay_dispatch", {**args, "permission": "default"}), expected)
        for override in ({"permission": "auto"}, {"sandbox": "danger-full-access"}, {"approvalPolicy": "untrusted"}):
            rejected(lambda: m.scoped("relay_dispatch", {**args, **override}), "新的 requestKey")
        with sqlite3.connect(TEMP / "state" / "tasks.sqlite") as db:
            saved = json.loads(db.execute("SELECT body FROM tasks WHERE id=?", (task,)).fetchone()[0])
        assert_access(saved, expected)
        assert (saved["initialSandbox"], saved["initialApprovalPolicy"]) == default_write[1:]
    m.control(task, "accept")

    reader = m.scoped("relay_dispatch", {**read, "requestKey": "read-resume"})["id"]
    notice(reader, timeout=12)
    prior = m.inspect(reader)
    for changes in ({"permission": "full"}, {"sandbox": "workspace-write"}, {"sandbox": "danger-full-access"}):
        rejected(lambda: m.control(reader, "resume", "继续核对结果", **changes), "只读任务")
    assert m.inspect(reader)["noticeId"] == prior["noticeId"]
    m.control(reader, "accept")
    print("PASS permission presets, overrides, read guards, idempotency, persistence, original-thread resume, board and RPC")
    return len(cases) + 2


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
    check_access(m, task, default_read, "thread/start")
    original_notice = m.inspect(task)["noticeId"]
    for changes in ({"model": sol}, {"effort": "high"}, {"difficulty": "standard"}):
        rejected(lambda: m.control(task, "resume", "核对新证据", **changes), "Astra/max")
    for changes in ({"permission": "auto"}, {"permission": "full"}, {"sandbox": "workspace-write"},
                    {"sandbox": "danger-full-access"}, {"approvalPolicy": "never"}, {"approvalPolicy": "untrusted"}):
        rejected(lambda: m.control(task, "resume", "核对新证据", **changes), "讨论任务权限固定")
    assert m.inspect(task)["noticeId"] == original_notice
    n = len(messages())
    m.control(task, "resume", "核对新证据", model=astra, effort="max", permission="default",
              sandbox="read-only", approvalPolicy="on-request")
    notice(task, n, timeout=12)
    same_thread, _ = check_profile(m, task, astra, "max", None, "thread/resume")
    assert same_thread == thread
    check_access(m, task, default_read, "thread/resume")
    m.control(task, "accept", "已综合双方判断")
    print("PASS discussion stays on Astra/max and read-only/on-request and rejects overrides")
    return len(cases) + 1


def check_parallel_writes(m):
    left, right = PROJECT / 'left', PROJECT / 'left-peer'
    nested = left / 'nested'
    nested.mkdir(parents=True)
    right.mkdir()

    def write(key, cwd, goal='QUICK'):
        return m.scoped('relay_dispatch', dict(requestKey=key, title=key, goal=goal, cwd=str(cwd)))['id']

    a = write('left-owner', left, 'HOLD')
    b = write('right-owner', right, 'HOLD')
    until(lambda: all(m.inspect(task)['status'] == 'running' for task in (a, b)))
    same = write('same-directory', left)
    child = write('nested-directory', nested)
    parent = write('parent-directory', PROJECT)

    def waiting(task, *owners):
        info = m.inspect(task)
        assert info['status'] == 'queued' and info['threadId'] is None, info
        assert info['waitInfo'] == {'kind': 'write_lock', 'blockers': [
            {**{key: owner[key] for key in ('id', 'status', 'cwd')}, 'label': owner['title']} for owner in owners
        ]}, info
        assert all(owner['holdsWriteLock'] for owner in owners)

    for task in (same, child):
        waiting(task, m.inspect(a))
    waiting(parent, m.inspect(a), m.inspect(b))
    m.control(a, 'steer', 'finish')
    notice(a, timeout=12)
    assert m.inspect(a)['status'] == 'review'
    waiting(child, m.inspect(a))
    m.control(a, 'accept')
    notice(same, timeout=12)
    waiting(child, m.inspect(same))
    m.control(same, 'accept')
    notice(child, timeout=12)
    m.control(child, 'accept')
    waiting(parent, m.inspect(b))
    m.control(b, 'cancel')
    notice(parent, timeout=12)
    m.control(parent, 'accept')
    print('PASS simultaneous non-nested writes, same/nested queues, multiple blockers and lock handoff')


def check_dag(m):
    graph = dict(graphId='research', graphTitle='  科研结果复核  ')
    a_args = dict(**graph, requestKey='research-evidence', title='核对原始证据', nodeLabel='  原始证据  ', goal='HOLD', mode='read')
    b_args = dict(**graph, requestKey='research-counterexample', title='复核解释', nodeLabel='反例分析', question='HOLD', position='初步判断')
    a = m.scoped('relay_dispatch', a_args)['id']
    b = m.scoped('relay_discuss', b_args)['id']
    until(lambda: all(m.inspect(task)['status'] == 'running' for task in (a, b)))
    a_view, b_view = m.inspect(a), m.inspect(b)
    assert a_view['cwd'] == b_view['cwd'] and a_view['mode'] == b_view['mode'] == 'read'
    assert_profile(b_view, astra, 'max', None)
    assert not a_view['holdsWriteLock'] and not b_view['holdsWriteLock']

    merge_args = dict(**graph, requestKey='research-merge', title='汇总科研结论', goal='QUICK 汇总两条证据',
                      dependsOn=[' research-evidence ', a, b_args['requestKey']])
    item = m.scoped('relay_dispatch', merge_args)
    merge = item['id']
    assert item['dependsOn'] == [a, b] and item['graphTitle'] == '科研结果复核'
    assert m.scoped('relay_dispatch', {**merge_args, 'dependsOn': [b, a]})['id'] == merge
    assert m.scoped('relay_discuss', b_args)['id'] == b
    for changes in (dict(graphId='另一个图'), dict(nodeLabel='另一个节点名'), dict(graphTitle='另一个标题'), dict(dependsOn=[a])):
        rejected(lambda: m.scoped('relay_dispatch', {**merge_args, **changes}), '新的 requestKey')
    rejected(lambda: m.scoped('relay_discuss', {**b_args, 'nodeLabel': '替换标签'}), '新的 requestKey')

    follow = m.scoped('relay_discuss', dict(graphId='research-followup', requestKey='research-followup', title='复核汇总',
        question='QUICK 复核综合判断', position='等待综合证据', dependsOn=[merge]))['id']
    rejected(lambda: m.scoped('relay_dispatch', {**a_args, 'dependsOn': [follow]}), '不能成环')
    rejected(lambda: m.scoped('relay_dispatch', {**a_args, 'dependsOn': [a]}), '任务自身')
    rejected(lambda: m.scoped('relay_dispatch', {**a_args, 'requestKey': 'self', 'dependsOn': ['self']}), '任务自身')
    rejected(lambda: m.scoped('relay_dispatch', {**a_args, 'requestKey': 'missing', 'dependsOn': ['absent']}), '当前对话内已存在')

    def waiting(expected):
        view = m.inspect(merge)
        assert view['status'] == 'queued' and view['threadId'] is None and view['turnId'] is None, view
        assert view['waitInfo'] == {'kind': 'upstream', 'blockers': expected}, view

    for task in (a, b):
        m.control(task, 'steer', 'finish')
        notice(task, timeout=12)
    a_ref = {'id': a, 'label': '原始证据', 'status': 'review'}
    b_ref = {'id': b, 'label': '反例分析', 'status': 'review'}
    waiting([a_ref, b_ref])
    a_view = m.control(a, 'accept', '反重力核对了原始分母')
    waiting([b_ref])
    b_view = m.control(b, 'accept', '反重力保留替代解释')
    notice(merge, timeout=12)
    merged = m.inspect(merge)
    assert merged['status'] == 'review' and merged['goal'] == merge_args['goal'] and merged['waitInfo'] is None
    assert merged['upstreams'] == [{**ref, 'status': 'done'} for ref in (a_ref, b_ref)]
    assert merged['downstreams'] == [{'id': follow, 'label': '复核汇总', 'status': 'queued'}]
    assert m.inspect(follow)['threadId'] is None
    turns = json.loads((TEMP / (merged['threadId'] + '.history')).read_text())
    prompt = turns[0]['items'][0]['content'][0]['text']
    assert merge_args['goal'] in prompt
    sources = json.loads(prompt.split('已验收的上游产出。以下内容供本任务引用。\n', 1)[1])
    assert sources == [{'节点': view['nodeLabel'], '结论': view['result']['summary'],
                        '证据': view['result']['evidence'], '反重力验收备注': view['current']} for view in (a_view, b_view)]
    m.control(merge, 'accept')
    notice(follow, timeout=12)
    assert_profile(m.inspect(follow), astra, 'max', None)
    m.control(follow, 'accept', '复核通过')

    foreign = str(uuid.uuid4())
    foreign_args = dict(**graph, requestKey='other-conversation', title='另一对话', goal='HOLD', mode='read')
    foreign_task = m.scoped('relay_dispatch', foreign_args, foreign)['id']
    for key in (foreign_task, foreign_args['requestKey']):
        rejected(lambda: m.scoped('relay_dispatch', {**a_args, 'requestKey': 'foreign', 'dependsOn': [key]}), '当前对话内已存在')
    rejected(lambda: m.scoped('relay_discuss', {**b_args, 'requestKey': 'foreign-discuss', 'dependsOn': [a]}, foreign), '当前对话内已存在')
    m.scoped('relay_control', dict(id=foreign_task, action='cancel'), foreign)

    board = m.call('relay_board', {})
    first = m.call('relay_board_changes', {'offset': 0, 'limit': 1, 'selected': merge})
    second = m.call('relay_board_changes', {'offset': 1, 'limit': 1, 'selected': merge})
    assert first['total'] == second['total'] == board['total'] and first['tasks'] != second['tasks']
    assert first['selected']['id'] == second['selected']['id'] == merge
    assert first['graphs'] == second['graphs'] == board['graphs']
    assert [(g['origin'], [t['id'] for t in g['nodes']]) for g in first['graphs'] if g['graphId'] == graph['graphId']] == [
        (ORIGIN, [a, b, merge]), (foreign, [foreign_task])]
    follow_graph = next(g for g in board['graphs'] if g['graphId'] == 'research-followup')
    assert [t['id'] for t in follow_graph['nodes']] == [follow]
    assert [t['id'] for t in follow_graph['externalNodes']] == [merge]
    with sqlite3.connect(TEMP / 'state' / 'tasks.sqlite') as db:
        saved = json.loads(db.execute('SELECT body FROM tasks WHERE id=?', (merge,)).fetchone()[0])
    assert saved['graphId'] == graph['graphId'] and saved['graphTitle'] == '科研结果复核' and saved['dependsOn'] == [a,b]
    print('PASS same-directory read and Astra concurrency, research DAG, accept gate, upstream prompt, DAG validation and isolated full graphs')
    return merge


def check_unavailable_upstreams(m):
    a = m.dispatch('unavailable-upstream', 'BLOCK', 'read')['id']
    b = m.scoped('relay_dispatch', dict(requestKey='blocked-child', title='等待上游', goal='QUICK',
        graphId='blocked-graph', dependsOn=[a]))['id']
    notice(a, timeout=12)

    def waiting(status, kind):
        view = m.inspect(b)
        assert view['status'] == 'queued' and view['threadId'] is None
        assert view['waitInfo'] == {'kind': kind, 'blockers': [{'id': a, 'label': 'unavailable-upstream', 'status': status}]}, view

    waiting('blocked', 'upstream_blocked')
    m.control(a, 'ask_user', '请提供材料')
    waiting('waiting_user', 'upstream_blocked')
    m.control(a, 'takeover', '核对输入')
    waiting('host', 'upstream_blocked')
    m.control(a, 'cancel')
    waiting('cancelled', 'upstream_cancelled')
    nodes = [b]
    for index in range(40):
        nodes.append(m.scoped('relay_dispatch', dict(requestKey=f'pagination-{index}', title=f'分页节点 {index}',
            goal='QUICK', graphId='blocked-graph', dependsOn=[a]))['id'])
    board = m.call('relay_board', {})
    group = next(g for g in board['graphs'] if g['graphId'] == 'blocked-graph')
    assert board['total'] > len(board['tasks']) == 40
    assert [task['id'] for task in group['nodes']] == nodes
    assert m.call('relay_board_changes', {'offset': 40, 'limit': 1})['graphs'] == board['graphs']
    print('PASS blocked, waiting_user, host and cancelled upstream queue reasons')
    print('PASS complete 41-node graph across default and offset task pages')
    return b


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
        permission_tasks = check_permissions(m)
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
            if how == "crash": args["permission"] = "full"
            t=m.scoped("relay_dispatch",args)["id"];until(lambda: m.inspect(t)["command"])
            thread=m.inspect(t)["threadId"];n=len(messages())
            if how=="clean": worker.terminate()
            else: worker.kill()
            worker.wait(timeout=10)
            if how == "clean":
                with sqlite3.connect(TEMP / "state" / "tasks.sqlite") as db:
                    legacy = json.loads(db.execute("SELECT body FROM tasks WHERE id=?", (t,)).fetchone()[0])
                    for field in (*access_fields, "initialSandbox", "initialApprovalPolicy"):
                        legacy.pop(field)
                    db.execute("UPDATE tasks SET body=? WHERE id=?", (json.dumps(legacy), t))
            worker=start_worker();notice(t,n)
            recovered, _ = check_profile(m, t, terra, "high", "standard", "thread/resume")
            assert recovered==thread and m.scoped("relay_dispatch",args)["id"]==t
            assert check_access(m, t, default_write if how == "clean" else full_access, "thread/resume") == thread
            m.control(t,"accept")
        print("PASS orderly recovery of legacy permissions and crash recovery of full permissions in the original thread")
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
        assert m.call("relay_board",{})["total"]==9+routed_tasks+permission_tasks
        assert m.scoped("relay_inspect",{})["total"]==9+routed_tasks+permission_tasks
        assert m.scoped("relay_inspect",{},str(uuid.uuid4()))["total"]==0
        print("PASS Antigravity can recover its own task list without asking for IDs")
        check_parallel_writes(m)
        merge = check_dag(m)
        waiting = check_unavailable_upstreams(m)
        worker.terminate(); worker.wait(timeout=10)
        with sqlite3.connect(TEMP / 'state' / 'tasks.sqlite') as db:
            legacy = json.loads(db.execute('SELECT body FROM tasks WHERE id=?', (held,)).fetchone()[0])
            for field in ('graphId', 'graphTitle', 'nodeLabel', 'dependsOn'):
                legacy.pop(field)
            db.execute('UPDATE tasks SET body=? WHERE id=?', (json.dumps(legacy), held))
        worker = start_worker()
        restored = m.call('relay_board_changes', {'limit': 1, 'selected': merge})
        assert len(restored['selected']['upstreams']) == 2 and restored['selected']['graphTitle'] == '科研结果复核'
        child = m.inspect(waiting)
        assert child['threadId'] is None and child['waitInfo']['kind'] == 'upstream_cancelled'
        original = m.dispatch('one','HOLD')
        assert original['id'] == held and original['graphId'] is None and original['dependsOn'] == []
        print('PASS graph, blocked dependency and legacy task records survive sidecar restart')
    finally:
        m.close();worker.terminate();worker.wait(timeout=12)

if __name__=="__main__":check()

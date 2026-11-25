from probe import MCP,PROJECT,TEMP,messages,notice,start_worker
def main():
    print("Discussion workspace",TEMP,flush=True)
    worker=start_worker(); m=MCP()
    try:
        source=PROJECT/"toy-observations.txt"
        source.write_text("合成验收样例。条件 A 8 次中有 3 次误报；条件 B 8 次中有 1 次误报。每组使用不同材料。\n")
        task=m.scoped("relay_discuss",{"requestKey":"toy-review","title":"复核合成结果",
            "question":"针对 toy-observations.txt，用简短中文给出目前可以直接报告的现象和一个最值得做的对照。",
            "position":"反重力认为 A 的误报次数更高，但每组的材料不同。",
            "materials":"直接读取 toy-observations.txt。这里是集成测试使用的合成数据。"})["id"]
        notice(task,timeout=260); a=m.inspect(task)
        assert a["model"]=="gpt-6.2-astra" and a["mode"]=="read" and a["effort"]=="max",a
        assert a["status"]=="review" and a["result"]["disagreement"],a["result"]
        print("Astra round 1",a["result"]["summary"],flush=True)
        assert [v["speaker"] for v in a["discussion"]]==["反重力","Astra Max"]
        n=len(messages())
        m.control(task,"resume","反重力追问：如果同一批材料在 A 和 B 下各测一次，首要比较什么？一句话回答。")
        notice(task,n,timeout=260); b=m.inspect(task)
        assert a["threadId"]==b["threadId"] and b["status"]=="review",b["result"]
        c=m.control(task,"accept","综合结论：对同一材料做配对比较，并保留改变方向的样例。")
        assert len(c["discussion"])==5 and set(PROJECT.iterdir())=={source}
        print("Astra round 2",b["result"]["summary"],flush=True)
        print("PASS real Astra Max, 2 read-only rounds in same thread and 5 attributed messages",flush=True)
    finally: m.close();worker.terminate();worker.wait(timeout=12)
if __name__=="__main__": main()

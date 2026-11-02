#!/usr/bin/env python3
"""Dry run of FlowBoard's "AI rank" against a local Ollama model. Read-only: nothing is written to the board.

Sends exactly the prompt and JSON schema that worker.mjs aiRank() sends to Workers AI, repeats it
--runs times and reports what a small model gets wrong:
  - tasks missing / duplicated / invented in the answer
  - scores outside 1..5
  - how much the scores move between identical runs (stability)
  - how much the top-20% "focus" set changes between runs

Tasks come from the live board (GET /api/state with the board key) or from an exported backup file.

  python3 ai_rank_dryrun.py --url https://fb.prayforsnow.ch --key "$FB_KEY" \
      --ollama http://ovas01.xtremnet.de:11434 --model qwen2.5:7b --runs 3
  python3 ai_rank_dryrun.py --file flowboard-backup.json --ollama ... --model ... --goal "Ship v1"

Python 3.8+, standard library only.
"""
import argparse, datetime, json, math, os, statistics, sys, time, urllib.request

SYSTEM = ("You prioritise tasks on a small founding team's kanban board using the Pareto principle: a few tasks create most "
          "of the value. Score each task on IMPACT toward the stated goal (1 negligible, 2 minor, 3 useful, 4 important, "
          "5 decisive) and EFFORT (1 under 30 minutes, 2 about an hour, 3 a few hours, 4 a day or two, 5 a week or more). "
          "Be decisive and use the full range: about one task in five deserves impact 4 or 5, and about one in five deserves 1. "
          "Judge impact by what the goal needs, not by urgency alone. Reply with JSON only.")
SCHEMA = {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "object", "properties": {
    "n": {"type": "integer"}, "impact": {"type": "integer"}, "effort": {"type": "integer"}, "why": {"type": "string"}},
    "required": ["n", "impact", "effort"]}}}, "required": ["items"]}


def http_json(url, body=None, headers=None, timeout=300):
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **(headers or {})},
                                 method="GET" if body is None else "POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def load_board(a):
    if a.file:
        with open(a.file, encoding="utf-8") as f:
            data = json.load(f)
    else:
        data = http_json(a.url.rstrip("/") + "/api/state", headers={"x-board-key": a.key})
    boards = data.get("boards") or []
    if not boards:
        sys.exit("no boards found")
    if a.board:
        b = next((x for x in boards if x.get("name") == a.board or x.get("id") == a.board), None)
        if not b:
            sys.exit("board not found; available: " + ", ".join(x.get("name", "?") for x in boards))
    else:
        b = boards[0]
    return b, [x.get("name", "?") for x in boards]


def open_tasks(b):
    done = {c["id"] for c in b.get("columns", []) if c.get("done")}
    cols = {c["id"]: c.get("name", "") for c in b.get("columns", [])}
    labels = {l["id"]: l.get("name", "") for l in b.get("labels", [])}
    out = []
    for t in b.get("tasks", []):
        if t.get("colId") in done or not t.get("title"):
            continue
        out.append({"id": t["id"], "title": t["title"][:140], "desc": " ".join(str(t.get("desc") or "").split())[:200],
                    "labels": [labels[i][:30] for i in (t.get("labels") or []) if i in labels][:6],
                    "due": str(t.get("due") or "")[:16], "est": t.get("est") or 0, "column": cols.get(t.get("colId"), "")[:40]})
    return out[:60]  # same cap as the app


def build_user(goal, tasks):
    lines = []
    for n, t in enumerate(tasks, 1):
        s = f"#{n} {t['title']}"
        if t["column"]: s += f" [{t['column']}]"
        if t["labels"]: s += " {" + ", ".join(t["labels"]) + "}"
        if t["due"]: s += f" due {t['due']}"
        if t["est"]: s += f" est {t['est']}m"
        if t["desc"]: s += "\n   " + t["desc"]
        lines.append(s)
    return ("Today: " + datetime.date.today().isoformat() + "\nGoal: " +
            (goal or "(none given, infer the likely goal from the tasks)") + "\n\nTasks:\n" + "\n".join(lines) +
            '\n\nReturn {"items":[{"n":1,"impact":1-5,"effort":1-5,"why":"at most 12 words"}, ...]} '
            "with every task number exactly once.")


def run_once(a, user, ntasks):
    body = {"model": a.model, "stream": False, "format": SCHEMA, "options": {"temperature": a.temperature},
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]}
    if a.num_ctx:
        body["options"]["num_ctx"] = a.num_ctx
    t0 = time.time()
    resp = http_json(a.ollama.rstrip("/") + "/api/chat", body, timeout=a.timeout)
    secs = time.time() - t0
    text = (resp.get("message") or {}).get("content", "")
    issues, scores = [], {}
    try:
        items = json.loads(text).get("items")
        assert isinstance(items, list)
    except Exception:
        return secs, {}, ["unparseable answer: " + text[:200].replace("\n", " ")], resp
    seen = {}
    for it in items:
        n = it.get("n") if isinstance(it, dict) else None
        if not isinstance(n, int) or not 1 <= n <= ntasks:
            issues.append(f"invented task number {n!r}")
            continue
        seen[n] = seen.get(n, 0) + 1
        imp, eff = it.get("impact"), it.get("effort")
        for name, v in (("impact", imp), ("effort", eff)):
            if not isinstance(v, int) or not 1 <= v <= 5:
                issues.append(f"#{n} {name}={v!r} out of range (app clamps it)")
        clamp = lambda v: max(1, min(5, round(float(v)))) if isinstance(v, (int, float)) else 3
        scores.setdefault(n, (clamp(imp), clamp(eff), str(it.get("why") or "")[:80]))
    for n, c in seen.items():
        if c > 1: issues.append(f"#{n} answered {c}x (first answer used)")
    missing = [n for n in range(1, ntasks + 1) if n not in seen]
    if missing: issues.append(f"{len(missing)} task(s) missing: " + ", ".join(f"#{n}" for n in missing))
    return secs, scores, issues, resp


def focus_set(scores, ntasks):
    ranked = sorted(scores, key=lambda n: -scores[n][0] / scores[n][1])
    return set(ranked[:max(1, math.ceil(ntasks * 0.2))])


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--url", help="FlowBoard base URL, e.g. https://fb.prayforsnow.ch")
    src.add_argument("--file", help="exported backup JSON instead of the live board")
    p.add_argument("--key", default=os.environ.get("FB_KEY"), help="board key (or env FB_KEY)")
    p.add_argument("--board", help="board name or id (default: first board)")
    p.add_argument("--goal", help="goal to score against (default: the board's goal)")
    p.add_argument("--ollama", default="http://localhost:11434")
    p.add_argument("--model", required=True)
    p.add_argument("--runs", type=int, default=3)
    p.add_argument("--temperature", type=float, default=0.2, help="same as the app (0.2)")
    p.add_argument("--num-ctx", type=int, default=8192, help="Ollama context window; 0 = model default")
    p.add_argument("--timeout", type=int, default=600)
    p.add_argument("--show-prompt", action="store_true")
    a = p.parse_args()
    if a.url and not a.key:
        p.error("--key or FB_KEY required with --url")

    b, names = load_board(a)
    tasks = open_tasks(b)
    goal = a.goal if a.goal is not None else (b.get("goal") or "")
    print(f"Board: {b.get('name')}  (boards: {', '.join(names)})")
    print(f"Goal:  {goal or '(none, model infers it)'}")
    print(f"Open tasks sent: {len(tasks)}   model: {a.model}   runs: {a.runs}\n")
    if len(tasks) < 2:
        sys.exit("need at least two open tasks")
    user = build_user(goal, tasks)
    if a.show_prompt:
        print("----- prompt -----\n" + user + "\n------------------\n")

    runs = []
    for i in range(a.runs):
        try:
            secs, scores, issues, resp = run_once(a, user, len(tasks))
        except Exception as e:
            sys.exit(f"Ollama call failed: {e}")
        ptok, etok = resp.get("prompt_eval_count"), resp.get("eval_count")
        print(f"Run {i + 1}: {secs:5.1f}s  prompt {ptok} tok, answer {etok} tok, "
              f"{len(scores)}/{len(tasks)} tasks scored" + ("" if issues else "  OK"))
        if ptok and a.num_ctx and ptok >= a.num_ctx - 16:
            print(f"   ! prompt filled the context window ({a.num_ctx}); raise --num-ctx")
        for s in issues:
            print("   ! " + s)
        runs.append(scores)

    print("\n  #  impact  effort  value  spread  title / reason (last run)")
    spreads = []
    for n, t in enumerate(tasks, 1):
        got = [r[n] for r in runs if n in r]
        if not got:
            print(f"{n:3}       -       -      -       -  {t['title'][:60]}   (never scored)")
            continue
        imps, effs = [g[0] for g in got], [g[1] for g in got]
        spread = max(max(imps) - min(imps), max(effs) - min(effs))
        spreads.append(spread)
        val = statistics.mean(i / e for i, e in zip(imps, effs))
        fmt = lambda xs: "/".join(map(str, xs))
        note = "" if len(got) == len(runs) else f"   (scored in {len(got)}/{len(runs)} runs)"
        print(f"{n:3}  {fmt(imps):>6}  {fmt(effs):>6}  {val:5.2f}  {spread:6}  {t['title'][:60]}{note}")
        if got[-1][2]:
            print(f"{'':37}-> {got[-1][2]}")

    if len(runs) > 1 and spreads:
        sets = [focus_set(r, len(tasks)) for r in runs if r]
        overlaps = [len(x & y) / len(x | y) for i, x in enumerate(sets) for y in sets[i + 1:] if x | y]
        print(f"\nStability: {sum(1 for s in spreads if s == 0)}/{len(spreads)} tasks scored identically in every run; "
              f"{sum(1 for s in spreads if s >= 2)} moved by 2+ points.")
        if overlaps:
            print(f"Top-20% focus set agreement between runs: {100 * statistics.mean(overlaps):.0f}% (100% = same tasks every time).")
    print("\nNothing was written to the board.")


if __name__ == "__main__":
    main()

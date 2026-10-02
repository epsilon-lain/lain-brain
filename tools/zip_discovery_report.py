"""Export real ledger links as ordinary Obsidian notes and a local report."""
from __future__ import annotations

import html
import json
from pathlib import Path
import zipfile


def quote_definition(text):
    # Model prose must not inject unverified wikilinks into the graph export.
    text = html.escape(text, quote=False).replace("[", "&#91;").replace("]", "&#93;")
    return "\n".join("> "+line for line in text.splitlines())


def export_vault(out, library, ledger, *, arm_name):
    vault = Path(out) / "obsidian-notes"
    vault.mkdir(exist_ok=False)
    for note in library.notes.values():
        tags = [t.replace(" ", "-") for t in note["studentTags"]]
        text = ("---\nexperiment: zip-discovery\nformula_certified: true\n"
            "definition_certified: false\nstudent_proposed_tags: "+json.dumps(tags)+"\n---\n\n"
            f"# {note['task']['key']}\n\n学生自己的定义：\n\n"
            +quote_definition(note["claim"]["definition"])+"\n\n"
            f"公式： `{note['claim']['expression']}`\n\n"
            f"解释审阅状态：{note['definitionTeacherStatus']}；公式有程序证书，解释没有真值证书。\n\n"
            "已核验的对象联系：\n\n")
        connected = 0
        for edge in ledger.edges.values():
            if note["id"] not in [edge["sourceZipId"], edge["targetZipId"]]:
                continue
            other = edge["targetZipId"] if note["id"] == edge["sourceZipId"] else edge["sourceZipId"]
            proof = edge["verification"]["certificate"]
            text += (f"- [[{other}]] — {edge['relation']}；方向：{edge['sourceZipId']} → {edge['targetZipId']}。"
                f"第 {edge['episode']} 轮提出；新联系奖励 {edge['discoveryReward']}；"
                f"当时题目覆盖 {edge['currentTaskCoverage']}（不参与该奖励）。\n"
                f"  证书：factor={proof['factor']}，substitution={json.dumps(proof['substitution'])}。\n")
            connected += 1
        if not connected:
            text += "尚无学生提出且通过核验的联系；未自动填充关系。\n"
        text += "\n这里只导出实验对象和联系；这些数学关系不声称为学术新发现。\n"
        (vault / (note["id"]+".md")).write_text(text, encoding="utf-8")
    # No index -> every-note wikilinks: those would inflate the apparent graph.
    (vault / "README.md").write_text(
        f"# Lain Brain 对象联系实验：{arm_name}\n\n"
        "这是普通 Markdown 笔记文件夹。放进 Obsidian 仓库后，笔记中已有的内部链接"
        "可供 Graph view 显示。未改动任何现有仓库或插件。\n\n"
        "笔记保留学生自己的定义与公式；待对齐解释明确标记。图上的笔记间连接仅来自"
        "学生选择后通过代数核验的关系，没有规则自动补边。\n\n"
        "图谱存在不等于学生已经理解；训练报告另列调用记录和关停/置换记忆实验。\n",
        encoding="utf-8")
    destination = Path(out) / "Brain-Discovery-Notes.zip"
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(vault.glob("*.md")):
            archive.write(path, "LainBrainDiscovery/"+path.name)
    return destination


def episode_summary(events):
    return dict(episodes=len(events), newLinks=sum(e["link"]["newlyDiscovered"] for e in events),
        correctAssertions=sum(e["link"]["verification"]["accepted"] for e in events),
        repeatedAssertions=sum(e["link"]["verification"]["accepted"] and not e["link"]["newlyDiscovered"] for e in events),
        falseAssertions=sum(not e["link"]["verification"]["accepted"]
            and not e["link"]["verification"].get("skipped", False) for e in events),
        discoveryRewardSum=sum(e["link"]["discoveryReward"] for e in events),
        newLinksDespiteFailedCurrentGeneration=sum(e["link"]["newlyDiscovered"]
            and e["noteGenerationPerformed"] and e["link"]["currentTaskCoverage"] == 0 for e in events),
        generationCalls=sum(e["noteGenerationPerformed"] for e in events),
        notePromptTokens=sum((e.get("draftTokenUse") or {}).get("promptTokens", 0) for e in events),
        noteGeneratedTokens=sum((e.get("draftTokenUse") or {}).get("generatedTokens", 0) for e in events),
        noteReadsDuringChoices=sum(a["readTrace"] is not None for e in events for a in e["actions"]),
        optimizerSteps=sum(e["update"]["optimizerSteps"] for e in events),
        parameterChangingUpdates=sum(bool(e["update"]["changedParameterTensors"]) for e in events),
        replayForwardBackwardActions=sum(e["update"]["replayActionCount"] for e in events),
        categoricalActionPromptTokens=sum(a["promptTokens"] for e in events for a in e["actions"]),
        categoricalSampledTokens=sum(len(e["actions"]) for e in events))


def write_report(out, results):
    data = json.dumps(results, ensure_ascii=False, allow_nan=False).replace("<", "\\u003c")
    page = r"""<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lain Brain · 联系探索</title><style>
body{font:15px/1.6 system-ui,sans-serif;background:#101923;color:#e3ecee;margin:0;padding:24px}
main{max-width:1150px;margin:auto}h1{font-size:26px}p{max-width:950px;color:#bed0d3}
button{background:#203844;color:#e3ecee;border:1px solid #56898f;border-radius:8px;padding:9px 15px;cursor:pointer;margin:0 8px 12px 0}
.layout{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{background:#172731;padding:18px;border-radius:12px;min-width:0}
svg{width:100%;height:380px}text{fill:#e3ecee;font:12px system-ui}circle{cursor:pointer;stroke:#a7d7d2;stroke-width:2;fill:#355d63}
line{stroke:#a7d7d2;stroke-width:2;opacity:.7}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}
table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #35515b;text-align:left}
.muted{font-size:13px;color:#9fb8bf}@media(max-width:800px){.layout{grid-template-columns:1fr}body{padding:12px}}
</style><main><h1>Lain Brain · 写笔记与发现联系</h1>
<p>联系由学生选择、代数核验。新联系本身获得奖励，题目是否解决另行记录。
这是一轮有限数学动作实验；待对齐解释没有真值证书，图谱和注意力不证明理解能力。</p>
<div id="tabs"></div><div class="layout"><section class="card"><div id="counts"></div>
<svg id="graph" viewBox="0 0 500 400"></svg><p class="muted">点笔记查看原始定义和已核验关系。没有关系时保留孤立笔记。</p></section>
<section class="card"><pre id="detail">点左侧笔记。</pre>
<details><summary>训练前后中文（人工检查）</summary><pre id="language"></pre></details></section></div>
<section class="card" style="margin-top:18px"><h2>同一起点的对照</h2><div id="comparison"></div>
<p class="muted">若两组因时限完成轮数不同，下表只比较共同前缀；没有多种子或隐藏泛化结论。</p></section>
<section class="card" style="margin-top:18px"><h2>实际探索记录</h2><div id="events"></div></section></main>
<script id="data" type="application/json">__DATA__</script><script>
const data=JSON.parse(document.getElementById('data').textContent);
const $=id=>document.getElementById(id),ns='http://www.w3.org/2000/svg';
function cell(row,value,tag='td'){const el=document.createElement(tag);el.textContent=String(value);row.appendChild(el)}
function table(rows,headers){const t=document.createElement('table'),h=document.createElement('tr');headers.forEach(x=>cell(h,x,'th'));t.appendChild(h);rows.forEach(r=>{const tr=document.createElement('tr');r.forEach(x=>cell(tr,x));t.appendChild(tr)});return t}
function select(arm){$('graph').replaceChildren();$('detail').textContent='点左侧笔记。';
 $('language').textContent=JSON.stringify({before:arm.languageBefore?.raw,after:arm.languageAfter?.raw,automaticallyCertified:false},null,2);
 $('counts').textContent=`${arm.name}：${arm.summary.episodes} 轮；${arm.library.length} 份有公式证书的笔记；${arm.summary.newLinks} 条新联系（当前语法和笔记库最多 ${arm.grammarEdgeCeiling} 条）；${arm.summary.parameterChangingUpdates} 次实际参数变化`;
 const pos=new Map(arm.library.map((n,i)=>[n.id,[250+150*Math.cos(2*Math.PI*i/arm.library.length),195+150*Math.sin(2*Math.PI*i/arm.library.length)]]));
 arm.edges.forEach(e=>{const [x1,y1]=pos.get(e.sourceZipId),[x2,y2]=pos.get(e.targetZipId);const l=document.createElementNS(ns,'line');Object.entries({x1,y1,x2,y2}).forEach(([k,v])=>l.setAttribute(k,v));$('graph').appendChild(l)});
 arm.library.forEach(n=>{const [cx,cy]=pos.get(n.id),c=document.createElementNS(ns,'circle');Object.entries({cx,cy,r:13}).forEach(([k,v])=>c.setAttribute(k,v));c.addEventListener('click',()=>{$('detail').textContent=JSON.stringify({object:n.task.key,studentDefinition:n.claim.definition,expression:n.claim.expression,studentTags:n.studentTags,definitionTeacherStatus:n.definitionTeacherStatus,definitionCertified:false,connections:arm.edges.filter(e=>e.sourceZipId===n.id||e.targetZipId===n.id)},null,2)});$('graph').appendChild(c);const label=document.createElementNS(ns,'text');label.setAttribute('x',cx);label.setAttribute('y',cy+29);label.setAttribute('text-anchor','middle');label.textContent=n.task.key;$('graph').appendChild(label)});
 $('events').replaceChildren(table(arm.events.map(e=>[e.episode,e.task.key,e.tag,e.link.relation,e.link.newlyDiscovered?'新联系':e.link.verification.reason,e.link.discoveryReward,e.link.currentTaskCoverage??'未生成',e.actions.filter(a=>a.readTrace).map(a=>a.readTrace.zipIds.join(',')).join(';')]),['轮','当前对象','学生标签','联系提案','核验','发现奖励','题目覆盖','实际读取 zip']));}
data.arms.forEach(arm=>{const b=document.createElement('button');b.textContent=arm.name;b.addEventListener('click',()=>select(arm));$('tabs').appendChild(b)});
const c=data.commonPrefixComparison;$('comparison').appendChild(table(c.arms.map(a=>[a.name,c.episodes,a.summary.newLinks,a.summary.repeatedAssertions,a.summary.falseAssertions,a.summary.noteReadsDuringChoices,a.summary.parameterChangingUpdates]),['组','共同轮数','新联系','重复','错误联系','读取记录','参数变化']));
if(data.arms.length)select(data.arms[0]);
</script></html>"""
    path = Path(out) / "report.html"
    path.write_text(page.replace("__DATA__", data), encoding="utf-8")
    return path

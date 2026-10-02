"""One read-only Notebook cell for the run shown in the user's latest log.

No model imports, training, network calls, file writes, or key entry. Shows
saved evidence; does not infer quality or silently search a different run.
"""
from pathlib import Path
import hashlib
import json
import os


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def inspect_run(notes_dir):
    archive = read_json(notes_dir / "archive.json")
    note_manifest = read_json(notes_dir / "manifest.json")
    if archive.get("protocol") != "lain-zip-notes-v1":
        raise ValueError("不是本实验的笔记记录；未读取其他运行。")
    preparation = Path(note_manifest["warmupRun"])
    result = read_json(preparation / "result.json")
    before, after = read_json(preparation / "before.json"), read_json(preparation / "after.json")
    lines = ["只读检查：本格训练更新=0，老师请求=0，文件写入=0。",
             "运行：" + str(notes_dir)]
    matches = (digest(preparation / "interface.safetensors") == result["adapterSha256"]
               == note_manifest["warmupAdapterSha256"] == archive["warmupAdapterSha256"])
    lines.append("适配器哈希一致=" + str(matches)
        + "；本次纠正更新=" + str(result.get("correctionUpdates", result.get("updates")))
        + "；累计监督更新=" + str(result.get("cumulativeSupervisedUpdates", "未记录"))
        + "；奖励更新=" + str(result.get("rewardUpdates"))
        + "；记录声明基础权重未变=" + str(result.get("baseWeightsUnchanged")))
    loss_before, loss_after = result.get("fixedTrainingContextLossBefore", []), result.get("fixedTrainingContextLossAfter", [])
    examples = read_json(preparation / "supervised-examples.json")["examples"]
    losses = [e["task"]["key"]+"/"+e["context"]+f": {a:.4f}->{b:.4f}"
              for e,a,b in zip(examples, loss_before, loss_after)]
    lines.append("相同训练上下文的损失：" + "；".join(losses))
    earlier = {r["task"]["key"]: r for r in before["records"]}
    for record in after["records"]:
        key, checked = record["task"]["key"], record["verification"]
        lines.append(key + " 覆盖=" + str(earlier[key]["verification"]["score"])+"->"+str(checked["score"])
                     + "；训练后核验=" + checked["reason"] + "；原文=" + compact(record["output"]["raw"]))
    lines.append("训练后中文=" + compact(after["language"]["raw"]))
    for record in archive["records"]:
        key = record["task"]["key"]
        for index, candidate in enumerate(record["candidates"]):
            checked, teacher = candidate["verification"], candidate["teacher"]
            label = key + (" 初稿" if index == 0 else " 修订")
            lines.append(label + "：公式接受=" + str(checked["accepted"])+"，覆盖="+str(checked["score"])
                + "，原因="+checked["reason"]+"；学生="+compact(candidate["output"]["raw"]))
            lines.append("老师：状态=" + str(teacher.get("definitionTeacherStatus"))
                + "，缓存命中=" + str(teacher.get("cacheHit"))
                + "，解析=" + (str(teacher["parseError"]) if teacher.get("parseError") else "JSON通过")
                + "，返回模型=" + str(teacher.get("returnedModel", "未记录"))
                + "；完整原文=" + compact(teacher["raw"]))
    active, pending = archive["activeNotes"], archive["pendingDefinitionNotes"]
    lines.append("最终：实验笔记="+str(len(active))+"，待对齐="+str(len(pending))
        + "；待对齐对象="+compact([n["task"]["key"] for n in pending])
        + "；生成阶段新增老师请求="+str(archive["teacherNetworkCalls"])
        + "，缓存命中="+str(archive.get("teacherCacheHits"))+"；生成阶段权重更新="+str(archive["trainingUpdates"]))
    # Keep the entire report below the usual 30-line Notebook truncation threshold.
    # JSON quoting escapes any newlines in model responses without removing them.
    report = "\n".join(lines)
    secret = os.environ.get("LAIN_TEACHER_API_KEY", "")
    if secret:
        report = report.replace(secret, "[密钥已隐藏]")
    return report


if __name__ == "__main__":
    print(inspect_run(Path("/mnt/workspace/lain-zip-pilot/zip-notes-corrected-5cdb54c9")))

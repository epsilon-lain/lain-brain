"""Build one self-contained cloud notebook. No secrets or model weights."""
import base64
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def cell(kind, source):
    data = dict(cell_type=kind, metadata={}, source=source.splitlines(keepends=True))
    if kind == "code":
        data.update(execution_count=None, outputs=[])
    return data


def build(out):
    payload = {}
    for name in ["zip_pilot.py", "zip_pilot_protocol.py", "zip_pilot_model.py", "research_reward_probe.py"]:
        data = (ROOT/name).read_bytes()
        payload[name] = dict(sha256=hashlib.sha256(data).hexdigest(), base64=base64.b64encode(data).decode())
    cells = [cell("markdown", """# Lain Brain × Apertus：首轮 zip 训练入口

先搭建，再开 GPU。这个 Notebook 内嵌校验过的脚本，不用解压或 clone。
第 1–3 步不下载模型、不调用老师、不训练。收集和训练步骤默认关闭。
已用随机微型 Apertus 和 Qwen2 检查前向与真实梯度；真实模型/GPU 尚未运行。

首轮：学生初稿 → Apertus 一个提示 → 学生修订 → 程序核验 → zip → 短训练。
老师意见不是证明；自然语言解释尚无自动真值证书。
这是接口实验，尚未实现研究调度/暂停重访，也不证明效果或成本优势。
"""), cell("markdown", "## 1. 准备脚本（CPU 即可；不联网）"), cell("code", """from pathlib import Path
import base64, hashlib, json, subprocess, sys, uuid, os

WORK = Path.cwd() / 'lain-zip-pilot'
TOOLS = WORK / 'tools'
TOOLS.mkdir(parents=True, exist_ok=True)
PAYLOAD = json.loads(r'''""" + json.dumps(payload) + """''')
for name, record in PAYLOAD.items():
    data = base64.b64decode(record['base64'])
    assert hashlib.sha256(data).hexdigest() == record['sha256']
    target = TOOLS / name
    if target.exists():
        assert hashlib.sha256(target.read_bytes()).hexdigest() == record['sha256'], '已有脚本版本不同，请换 WORK 目录'
    else:
        target.write_bytes(data)
print('脚本就绪：', WORK)

def run(arguments, timeout=900):
    try:
        subprocess.run([sys.executable, '-u', str(TOOLS/'zip_pilot.py')] + [str(x) for x in arguments],
                       check=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError('达到进程时间上限。已完成记录保留；没有自动重启。')

PLAN = WORK / ('plan-' + uuid.uuid4().hex[:8])
run(['prepare', '--out', PLAN], timeout=30)
"""), cell("markdown", """## 2. 填好配置（先不要申请 GPU）

学生选用 `swiss-ai/Apertus-v1.1-0.5B-Instruct`。
固定版本 `a140fd61fb57422c36a26301caea17edee799874`，使用完整 BF16 safetensors，
不使用推理专用量化文件。原 17M GPT 不用于此实验。
`STUDENT_PATH` 指向完整快照；已有文件可直接填写，或开启下面的独立下载步骤。
老师用独立 Apertus 聊天服务，活动 CSCS 推理或另行部署均可。
`TEACHER_BASE_URL` 是 /v1 这类 API 前缀；实际服务模型名按服务填写。
老师部署身份先声明并保存，客户端不能独立验证权重版本。
这些配置可以保存在 Notebook；密钥不要写进 Notebook。
"""), cell("code", """STUDENT_ID = 'swiss-ai/Apertus-v1.1-0.5B-Instruct'
STUDENT_REVISION = 'a140fd61fb57422c36a26301caea17edee799874'
STUDENT_PATH = WORK / 'models' / 'Apertus-v1.1-0.5B-Instruct'
RUN_DOWNLOAD = False  # 只下载文件；不申请 GPU、不推理、不调用老师
TEACHER_BASE_URL = ''
TEACHER_MODEL = 'swiss-ai/Apertus-v1.5-8B'
TEACHER_REVISION = ''  # 服务部署版本标签；不冒充自动核实
DEVICE = 'cuda'       # CPU 准备时也可改为 'cpu'
COLLECT_DEVICE = 'cuda'  # 老师占同一 GPU 时改 'cpu'，或用本地学生+远程老师
MODE = 'zip'          # 对照可选 'none' 或 'text'
SEED = 1337          # 后续多种子：1337, 2027, 4099
COLLECTION = WORK / ('collection-' + uuid.uuid4().hex[:8])
TRAIN_RUN = WORK / ('train-' + MODE + '-' + uuid.uuid4().hex[:8])
TEACHER_CACHE = WORK / 'teacher-cache'
RUN_COLLECT = False
RUN_BASELINE = False  # 先做学生起点检查；没有老师调用
BASELINE_RUN = WORK / ('baseline-' + uuid.uuid4().hex[:8])
RUN_TRAIN = False
RUN_FINAL = False     # 设置锁定前不要打开最终公开开发测试
"""), cell("markdown", """## 2.5. 可选：下载固定版本的学生（CPU 环境即可）

默认关闭。没有快照时，先安装下一节的依赖，再把 `RUN_DOWNLOAD` 改为 True，
单独运行此格。它只请求官方模型文件，匿名下载，不调用推理或老师；需要网络和磁盘。
不自动安装 PyTorch，不自动重试整个任务。中断后的缓存可用于下次手动重跑。
"""), cell("code", """if RUN_DOWNLOAD:
    import textwrap
    download_code = textwrap.dedent(\"\"\"
        import json, sys
        from pathlib import Path
        from huggingface_hub import snapshot_download
        model_id, revision, output = sys.argv[1:]
        destination = Path(output)
        identity = dict(modelId=model_id, revision=revision)
        marker = destination/'lain-snapshot.json'
        if destination.exists() and any(destination.iterdir()):
            if not marker.is_file() or json.loads(marker.read_text()) != identity:
                raise ValueError('下载目标包含其它版本；请使用新的 STUDENT_PATH')
        destination.mkdir(parents=True, exist_ok=True)
        marker.write_text(json.dumps(identity))
        snapshot_download(repo_id=model_id, revision=revision, token=False, local_dir=destination,
            allow_patterns=['config.json', 'generation_config.json', 'model.safetensors',
                            'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json',
                            'chat_template.jinja'], max_workers=2)
        print('Downloaded fixed revision', revision)
    \"\"\")
    subprocess.run([sys.executable, '-c', download_code, STUDENT_ID, STUDENT_REVISION, str(STUDENT_PATH)],
                   check=True, timeout=900)
    print('学生文件已下载：', STUDENT_PATH)
else:
    print('没有下载；可使用已有完整快照。')
"""), cell("markdown", """## 3. 检查环境（不加载权重）

需要已有 PyTorch；学生使用 Transformers 4.57.6。缺依赖时先在独立环境
安装 `python -m pip install transformers==4.57.6`，不替换已有 CUDA PyTorch。
老师使用官方 Apertus 1.5 独立环境/容器，不混装到学生环境。
输出 GPU 实际型号、显存和 BF16 支持后再决定部署；不假设魔搭分配了什么卡。
"""), cell("code", """run(['preflight', '--student-path', STUDENT_PATH], timeout=60)
"""), cell("markdown", """## 3.5. 学生起点（4 次短推理，老师调用为零）

只在学生快照和算力已经就绪时开启 `RUN_BASELINE`。查看中文/英文原始输出，
再看对象输出是否符合格式。格式通过不等于能力已经被自动认证；格式失败
会在调用老师前停止，先检查语言起点或提示。不要放宽公式核验来制造成功。
"""), cell("code", """if RUN_BASELINE:
    run(['baseline', '--student-path', STUDENT_PATH, '--device', DEVICE, '--out', BASELINE_RUN])
else:
    print('起点推理未启动。没有老师调用。')
BASELINE = BASELINE_RUN / 'baseline.json'
"""), cell("markdown", """## 4. 少量收集：最多 6 次 Apertus 网络调用

确认学生能表达对象、快照存在、老师服务可用后，才把 `RUN_COLLECT` 改为 True。
若需要密钥，下方会用不可见输入放入环境变量，内容不会保存到 Notebook。
相同请求缓存复用；失败不重试。没有接纳的公式就停止，先检查起点和格式。
同一 GPU 部署老师时先完成材料收集，关闭老师后才训练学生。
"""), cell("code", """if RUN_COLLECT:
    assert STUDENT_PATH.is_dir(), '先准备学生完整快照'
    assert BASELINE.is_file(), '先运行起点检查并查看输出'
    assert TEACHER_BASE_URL and TEACHER_REVISION, '先填写老师接口和部署版本'
    if 'LAIN_TEACHER_API_KEY' not in os.environ:
        from getpass import getpass
        secret = getpass('Apertus key（本地无鉴权服务可留空）：')
        if secret:
            os.environ['LAIN_TEACHER_API_KEY'] = secret
        del secret
    run(['collect', '--student-path', STUDENT_PATH, '--device', COLLECT_DEVICE,
         '--teacher-base-url', TEACHER_BASE_URL, '--teacher-model', TEACHER_MODEL,
         '--teacher-revision', TEACHER_REVISION, '--teacher-cache', TEACHER_CACHE,
         '--baseline', BASELINE,
         '--out', COLLECTION, '--max-teacher-calls', 6, '--max-seconds', 600])
else:
    print('收集未启动。没有老师调用。')
"""), cell("markdown", """## 5. 查看收集结果，再训练

不显示密钥，也不自动显示完整老师反馈。初稿和提示后修订要分开看；
只有公式和范围被程序核验，解释文本不等于模型内在思想或已证明的理解。
"""), cell("code", """CORPUS = COLLECTION / 'corpus.json'
if CORPUS.exists():
    corpus = json.loads(CORPUS.read_text())
    print('有效 zip：', len(corpus['notes']), '老师网络调用：', corpus['teacherNetworkCalls'],
          '缓存命中：', corpus['teacherCacheHits'])
    for record in corpus['records']:
        print(record['task']['key'], '独立初稿覆盖', record['initialCheck']['score'],
              '提示后覆盖', record['revisionCheck']['score'])
else:
    print('尚未收集。保持不训练。')
"""), cell("markdown", """## 6. 学生短训练：4 次接口热身 + 2 条两步策略轨迹

把 `RUN_TRAIN` 改为 True 才执行。老师调用为零；基础学生冻结，只更新新增模块。
zip 在隐藏层参与计算；text 对照把同一材料放到文本上下文；none 对照保留普通路径。
默认只是通路测试，生成预算和总运算尚未严格匹配，不作为效果胜负结论。
每次输出新建目录，不覆盖已有结果。超时保留完成记录，不自动继续。
"""), cell("code", """if RUN_TRAIN:
    assert CORPUS.is_file(), '先收集并查看核验材料'
    run(['train', '--student-path', STUDENT_PATH, '--device', DEVICE, '--corpus', CORPUS,
         '--out', TRAIN_RUN, '--mode', MODE, '--seed', SEED,
         '--warmup-steps', 4, '--pg-episodes', 2, '--max-seconds', 600])
    result = json.loads((TRAIN_RUN/'result.json').read_text())
    print(json.dumps(result, ensure_ascii=False, indent=2))
else:
    print('训练未启动。参数更新 0。')
"""), cell("markdown", """## 7. 最终冻结评测（独立执行）

只有设置已经锁定时才把 `RUN_FINAL` 改为 True。无老师，无在线更新。
首次查看后不能反复用这些题调参再称未见测试；当前题目公开，只是开发验证。
训练报告中的关闭/错配 zip 先帮助检查内容依赖，不能靠单个种子断定收益。
"""), cell("code", """if RUN_FINAL:
    FINAL_RUN = WORK / ('final-' + uuid.uuid4().hex[:8])
    run(['final-eval', '--student-path', STUDENT_PATH, '--device', DEVICE,
         '--run', TRAIN_RUN, '--out', FINAL_RUN])
    print('最终记录：', FINAL_RUN/'final.json')
else:
    print('最终题未打开。')
"""), cell("markdown", """## 保存结果后关闭云端 GPU

保留 `lain-zip-pilot` 目录中的 JSON、适配器 safetensors、archive 和老师缓存，
并记录 GPU 型号、实际耗时、额度及网络错误。Notebook 不替你关闭云端实例，
需要在魔搭控制台停止实例。原学生快照不被修改。

下一阶段：冻结材料并匹配总预算，多种子分别检验 SFT、进展奖励、文本/zip
以及调度的贡献。当前没有 Apertus 真实调用或 GPU 成功记录，也没有自我升级结论。
""")]
    notebook = dict(cells=cells, metadata=dict(kernelspec=dict(display_name="Python 3", language="python", name="python3"),
                         language_info=dict(name="python", version="3.12")), nbformat=4, nbformat_minor=5)
    # Stable cell IDs make rebuilds reviewable.
    for index, item in enumerate(cells):
        item["id"] = f"lain-pilot-{index:02d}"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(notebook, ensure_ascii=False, indent=1)+"\n", encoding="utf-8")
    print(f"Built {out}: {out.stat().st_size} bytes")


if __name__ == "__main__":
    build(ROOT.parent / "notebooks/Lain-Apertus-Pilot.ipynb")

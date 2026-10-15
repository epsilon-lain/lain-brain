"""Quietly separate mock student counters from actual pretrained-model work."""
from contextlib import redirect_stdout,redirect_stderr
import importlib.util
import io
import sys
import unittest


def run_checks(names,require_torch=False):
    if require_torch and not importlib.util.find_spec('torch'):
        print('原学生环境缺少 PyTorch；尚未调用真实学生。',flush=True);return 1
    diagnostics=io.StringIO();output=io.StringIO()
    with redirect_stdout(diagnostics),redirect_stderr(diagnostics):
        tests=unittest.defaultTestLoader.loadTestsFromNames(names)
        result=unittest.TextTestRunner(stream=output,verbosity=1).run(tests)
    if result.wasSuccessful():
        print('离线检查通过：'+str(result.testsRun-len(result.skipped))+' 项；跳过 '+str(len(result.skipped))+
            ' 项；真实学生生成＝0、真实学生更新＝0。',flush=True)
        if result.skipped:print('跳过的实际梯度检查将在原学生 PyTorch 环境入口执行。',flush=True)
    else:
        print(output.getvalue(),end='',flush=True)
        print('以下仅为离线模拟诊断：',flush=True);print(diagnostics.getvalue(),end='',flush=True)
    return 0 if result.wasSuccessful() else 1


if __name__=='__main__':
    args=sys.argv[1:];strict='--require-torch' in args
    raise SystemExit(run_checks([x for x in args if x!='--require-torch'],strict))

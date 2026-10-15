"""Run simulations quietly; their fabricated student counters are not runtime progress."""
from contextlib import redirect_stdout, redirect_stderr
import io
import sys
import unittest


def run_checks(names,verbosity=1):
    diagnostics=io.StringIO();report=io.StringIO()
    with redirect_stdout(diagnostics),redirect_stderr(diagnostics):
        suite=unittest.defaultTestLoader.loadTestsFromNames(names)
        outcome=unittest.TextTestRunner(stream=report,verbosity=verbosity).run(suite)
    if outcome.wasSuccessful():
        print('离线检查通过：'+str(outcome.testsRun)+' 项；真实学生生成＝0、真实学生更新＝0。',flush=True)
    else:
        print(report.getvalue(),end='',flush=True)
        print('以下为离线模拟诊断，不是真实学生训练：',flush=True)
        print(diagnostics.getvalue(),end='',flush=True)
    return 0 if outcome.wasSuccessful() else 1


if __name__=='__main__':raise SystemExit(run_checks(sys.argv[1:]))

"""Strict offline preflight. It never loads or updates the actual student."""
import argparse
import importlib.util
import sys
import unittest


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--require-torch',action='store_true')
    args=parser.parse_args()
    if args.require_torch and importlib.util.find_spec('torch') is None:
        raise RuntimeError('原训练 Python 缺少 Torch；不能跳过真实小模型梯度检查后继续训练')
    suite=unittest.defaultTestLoader.loadTestsFromNames(['test_rr_core','test_rr_engine','test_rr_torch'])
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    ok=result.wasSuccessful() and (not args.require_torch or len(result.skipped)==0)
    passed=result.testsRun-len(result.skipped)-len(result.failures)-len(result.errors)
    print('离线入口检查：'+str(passed)+' 项通过；跳过 '+str(len(result.skipped))+
        ' 项；失败／异常 '+str(len(result.failures)+len(result.errors))+' 项。',flush=True)
    print('这些是题库／事务测试和真实小模型梯度测试；实际学生生成＝0、实际学生更新＝0。',flush=True)
    if not ok:raise SystemExit(2)


if __name__=='__main__':main()

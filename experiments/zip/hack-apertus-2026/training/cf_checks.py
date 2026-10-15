"""Offline tests are not student results. Strict Notebook preflight permits zero skips."""
import argparse
import importlib.util
import unittest


def main():
    p=argparse.ArgumentParser();p.add_argument('--require-torch',action='store_true');a=p.parse_args()
    if a.require_torch and importlib.util.find_spec('torch') is None:raise RuntimeError('原训练Python缺少Torch；不能跳过真实小模型梯度检查后训练学生')
    suite=unittest.defaultTestLoader.loadTestsFromNames(['test_rr_core','test_rr_engine','test_rr_torch','test_cf_core','test_cf_engine','test_cf_torch'])
    r=unittest.TextTestRunner(verbosity=2).run(suite);passed=r.testsRun-len(r.skipped)-len(r.failures)-len(r.errors)
    print('离线检查：'+str(passed)+'项通过；跳过'+str(len(r.skipped))+'；失败／异常'+str(len(r.failures)+len(r.errors))+'。',flush=True)
    print('题库、事务恢复与真实小模型梯度测试；实际学生生成=0、更新=0。',flush=True)
    if not r.wasSuccessful() or a.require_torch and r.skipped:raise SystemExit(2)


if __name__=='__main__':main()

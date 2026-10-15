"""Reuse the independent child monitor with frozen retest counts."""
import json
import time
from writer_check_progress import (StageProgress as BaseProgress,
    LaunchMonitor as BaseMonitor, run_child)


class StageProgress(BaseProgress):
    def __init__(self, path=None):
        super().__init__(path)
        self.state.update(featureForwardBatches=0, completeNewObjects=0)


class LaunchMonitor(BaseMonitor):
    def __init__(self):
        super().__init__(interval=10., total_seconds=1200.)
        self.stage='准备 两分支 ZIP 冻结比较'

    def report(self):
        with self.lock:
            child, path, stage = self.child, self.progress_path, self.stage
        row = None
        if child is not None and path and child.poll() is None:
            try:
                saved=json.loads(path.read_text(encoding='utf-8'))
                if saved.get('pid')==child.pid and all(type(saved.get(k)) is int and saved[k]>=0 for k in
                    ('rawResponsesSaved','scoredResponses','featureForwardBatches','coldReproductions','completeNewObjects')):
                    row=saved; stage=saved['stage']
            except (OSError,ValueError,TypeError): pass
        process='子进程尚未启动' if child is None else 'PID '+str(child.pid)+(
            ' 存活' if child.poll() is None else ' 已退出('+str(child.returncode)+')')
        text='[ZIP冻结比较计时] 已用 '+str(int(time.monotonic()-self.started))+' 秒 | '+stage+' | '+process
        if row:
            text += ' | 原文 '+str(row['rawResponsesSaved'])+'/56 | 特征批 '+str(row['featureForwardBatches'])+'/40'
            text += ' | 新题 '+str(row['completeNewObjects'])+'/8 | 旧复现 '+str(row['coldReproductions'])+'/8 | 更新 0'
        print(text,flush=True)

"""Clock shows the actual budgets of the editable-guidance course."""
import json
from pathlib import Path
import time
from writer_check_progress import LaunchMonitor as BaseMonitor
from zip_summary_training_v9_progress import run_child

class LaunchMonitor(BaseMonitor):
    def __init__(self,total_seconds=2100):
        super().__init__(interval=10.,total_seconds=total_seconds)
        self.stage='准备可修订弱引导训练'
    def report(self):
        with self.lock:child,path,stage=self.child,self.progress_path,self.stage
        row=None
        if child is not None and path and child.poll() is None:
            try:
                value=json.loads(Path(path).read_text())
                if value.get('pid')==child.pid:row=value;stage=value['stage']
            except (OSError,ValueError):pass
        process='子进程尚未启动' if child is None else 'PID '+str(child.pid)+(' 存活' if child.poll() is None else ' 已退出('+str(child.returncode)+')')
        text='[弱引导ZIP计时] 已用 '+str(int(time.monotonic()-self.started))+' 秒 | '+stage+' | '+process
        if row:text+=' | 原文 '+str(row.get('rawResponsesSaved',0))+'/86 | 动作编码更新 '+str(row.get('warmUpdates',0))+'/16 | 用途更新 '+str(row.get('managementUpdates',0))+'/4 | 引导写作更新 '+str(row.get('guideUpdates',0))+'/1 | 完成题 '+str(row.get('completeNewObjects',0))+'/8'
        print(text,flush=True)

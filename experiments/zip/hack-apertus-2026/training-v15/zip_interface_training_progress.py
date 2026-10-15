"""Report sampled originals and real optimizer commits separately."""
import json
import time
from writer_check_progress import LaunchMonitor as BaseMonitor,run_child


class LaunchMonitor(BaseMonitor):
    def __init__(self):
        super().__init__(interval=10.,total_seconds=600.)
        self.stage='准备独立接口适配器训练与同题复验'
    def phase(self,stage):
        with self.lock:self.stage=stage
        self.report()
        if time.monotonic()>=self.deadline:raise TimeoutError('接口训练十分钟总上限已到')
    def report(self):
        with self.lock:child,path,stage=self.child,self.progress_path,self.stage
        row=None
        if child is not None and path and child.poll() is None:
            try:
                value=json.loads(path.read_text())
                if value.get('pid')==child.pid and all(type(value.get(k)) is int and value[k]>=0
                    for k in ('rawResponsesSaved','scoredResponses','generationAttempts','interfaceUpdates')):
                    row=value;stage=row['stage']
            except (OSError,ValueError,TypeError):pass
        process='子进程尚未启动' if child is None else 'PID '+str(child.pid)+(' 存活' if child.poll() is None else ' 已退出('+str(child.returncode)+')')
        message='[接口训练ZIP计时] 已用 '+str(int(time.monotonic()-self.started))+' 秒 | '+stage+' | '+process
        if row:message+=' | 学生原文 '+str(row['rawResponsesSaved'])+'/6 | 已审计 '+str(row['scoredResponses'])+'/6 | 实际接口更新 '+str(row['interfaceUpdates'])+'/6 | 学生假设 ZIP '+str(row.get('studentObservationZips',0))
        print(message,flush=True)

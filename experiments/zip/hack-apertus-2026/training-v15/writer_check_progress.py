"""Independent progress clock, with counts only after saved evidence exists."""
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time
import uuid


class StageProgress:
    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self.state = dict(pid=os.getpid(), stage='子进程入口', rawResponsesSaved=0,
            scoredResponses=0, coldReproductions=0, oldDraftReproductions=0,
            completePairs=0, generationAttempts=0, trainingUpdates=0, inFlight=None)

    def mark(self, stage=None, **fields):
        now = time.time()
        changed = stage is not None and stage != self.state['stage']
        if changed or 'stageStartedAt' not in self.state:
            self.state['stageStartedAt'] = now
        if stage is not None:
            self.state['stage'] = stage
        self.state.update(fields)
        self.state['updatedAt'] = now
        if self.path:
            temporary = self.path.with_name(self.path.name + '.' + uuid.uuid4().hex + '.tmp')
            with temporary.open('x', encoding='utf-8') as f:
                json.dump(self.state, f, ensure_ascii=False)
                f.flush()
            os.replace(temporary, self.path)
        if changed:
            print('[草稿检查阶段] ' + self.state['stage'], flush=True)


class LaunchMonitor:
    def __init__(self, interval=10., total_seconds=1200.):
        self.interval = interval
        self.total_seconds = total_seconds
        self.started = time.monotonic()
        self.deadline = self.started + total_seconds
        self.stage = '准备冻结草稿配对检查'
        self.child = None
        self.progress_path = None
        self.stopped = threading.Event()
        self.thread = None
        self.lock = threading.Lock()

    def start(self):
        self.report()
        self.thread = threading.Thread(target=self.tick, daemon=True)
        self.thread.start()
        return self

    def tick(self):
        while not self.stopped.wait(self.interval):
            self.report()

    def phase(self, stage):
        with self.lock:
            self.stage = stage
        self.report()
        if time.monotonic() >= self.deadline:
            raise TimeoutError('20 分钟总时间上限已到')

    def report(self):
        with self.lock:
            child, path, stage = self.child, self.progress_path, self.stage
        saved = None
        if child is not None and path and child.poll() is None:
            try:
                row = json.loads(path.read_text(encoding='utf-8'))
                counts = ('rawResponsesSaved', 'scoredResponses', 'coldReproductions',
                          'oldDraftReproductions', 'completePairs')
                if row.get('pid') == child.pid and isinstance(row.get('stage'), str) and all(
                        type(row.get(k)) is int and row[k] >= 0 for k in counts):
                    saved = row
                    stage = row['stage']
            except (OSError, ValueError, TypeError):
                pass
        process = '尚未启动学生子进程' if child is None else 'PID ' + str(child.pid) + (
            ' 存活' if child.poll() is None else ' 已退出(' + str(child.returncode) + ')')
        message = '[草稿检查计时] 已用 ' + str(int(time.monotonic() - self.started)) + ' 秒 | ' + stage + ' | ' + process
        if saved:
            message += ' | 原文 ' + str(saved['rawResponsesSaved']) + '/12 | 数学复现 ' + str(
                saved['coldReproductions']) + '/8 | 原草稿复现 ' + str(saved['oldDraftReproductions']) + '/2 | 配对 ' + str(
                saved['completePairs']) + '/2 | 更新 0'
        print(message, flush=True)

    def close(self):
        self.stopped.set()
        if self.thread:
            self.thread.join(timeout=1.)


def run_child(command, environment, monitor, progress_path=None):
    """Stream quiet or chatty children without postponing the clock."""
    child = subprocess.Popen(command, env=environment, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, bufsize=1)
    with monitor.lock:
        monitor.child = child
        monitor.progress_path = Path(progress_path) if progress_path else None
    monitor.report()
    lines = queue.Queue()
    def collect():
        try:
            for line in child.stdout:
                lines.put(line)
        finally:
            lines.put(None)
    reader = threading.Thread(target=collect, daemon=True)
    reader.start()
    exceeded = False
    closed = False
    grace = None
    try:
        while not (closed and child.poll() is not None):
            if time.monotonic() >= monitor.deadline and child.poll() is None:
                if not exceeded:
                    exceeded = True
                    grace = time.monotonic() + 20
                    child.terminate()  # Runner saves partial evidence on SIGTERM.
                    print('已到总上限，正在保存已完成原文。', flush=True)
                elif time.monotonic() >= grace:
                    child.kill()
            try:
                line = lines.get(timeout=.2)
            except queue.Empty:
                continue
            if line is None:
                closed = True
            else:
                print(line, end='', flush=True)
    except BaseException:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        raise
    finally:
        reader.join(timeout=1.)
        if not reader.is_alive():
            child.stdout.close()
    return dict(exitCode=child.returncode, parentTotalBudgetReached=exceeded, childPid=child.pid)

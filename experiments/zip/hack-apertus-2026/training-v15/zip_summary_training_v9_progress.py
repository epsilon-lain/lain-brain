"""Separate compute deadline and a bounded 120-second saving grace."""
import queue
import subprocess
import threading
import time
from pathlib import Path
from zip_summary_training_v8_progress import LaunchMonitor, StageProgress

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
                    grace = time.monotonic() + 120
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
                child.wait(timeout=120)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        raise
    finally:
        reader.join(timeout=1.)
        if not reader.is_alive():
            child.stdout.close()
    return dict(exitCode=child.returncode, parentTotalBudgetReached=exceeded, childPid=child.pid)

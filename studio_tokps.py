#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""studio_tokps —— 给 Ekko Studio（Hermes Studio 桌面端）前端加运行统计浮标。

无常驻后台：只在「打补丁 / 启动 / 还原」这些被你触发的时刻运行。

子命令:
  status                     查看当前状态（版本、是否已注入、是否原生自带统计）
  apply [--force]            文件注入（幂等；先备份 index.html 为 index.html.tokps.bak）
  revert                     还原文件注入
  launch [--cdp] [--dry-run] 打补丁并启动 Studio（--cdp 改为「运行时注入、不碰文件」）
  cdp [--port N] [--restart] 仅用 CDP 运行时注入（需要先关掉正在运行的 Studio）

用法示例:
  python studio_tokps.py launch          # 日常：双击 studio-tokps.cmd 等价
  python studio_tokps.py apply           # 只想打补丁，稍后自己 Ctrl+R 重载
  python studio_tokps.py launch --cdp    # 不修改任何文件的运行时注入
"""
import argparse, json, os, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
TAG = '<script src="/tokps-overlay.js"></script>'
OVERLAY = os.path.join(HERE, 'tokps-overlay.js')
CDP_INJECTOR = os.path.join(HERE, 'inject-cdp.mjs')
NATIVE_MARKERS = ['tok/s', 'TTFT', 'tokensPerSecond', '输出速度', '会话统计', '首 token 平均']
DEFAULT_PORT = 9223
NO_WINDOW = 0x08000000

APP_CANDIDATES = [
    r'%LOCALAPPDATA%\Programs\Hermes Studio\Ekko Studio',
    r'%PROGRAMFILES%\Hermes Studio\Ekko Studio',
    r'%APPDATA%\..\Local\Programs\Hermes Studio\Ekko Studio',
    '~/Applications/Hermes Studio/Ekko Studio.app/Contents/Resources/app',
    '/Applications/Ekko Studio.app/Contents/Resources/app',
    '/opt/Ekko Studio/resources/app',
]
EXE_CANDIDATES = ['Ekko Studio.exe', 'ekko-studio', 'Ekko Studio', 'Hermes Studio.exe']


# ---------------------------------------------------------------- 定位安装
def running_exe():
    """从正在运行的 Studio 进程反推安装位置（最可靠的来源）。"""
    try:
        if os.name == 'nt':
            out = subprocess.run(['powershell', '-NoProfile', '-Command',
                                  "(Get-Process -Name 'Ekko Studio' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)"],
                                 capture_output=True).stdout.decode('utf-8', 'replace').strip()
            if out and os.path.isfile(out):
                return out
        else:
            r = subprocess.run(['pgrep', '-f', 'Ekko Studio'], capture_output=True, text=True).stdout.split()
            if r:
                exe = os.path.realpath('/proc/%s/exe' % r[0]) if os.path.exists('/proc') else None
                if exe and os.path.isfile(exe):
                    return exe
    except Exception:
        pass
    return None


def drive_scan_candidates():
    """安装目录不一定在 %LOCALAPPDATA% 那个盘（本机就在 D:），把各盘的常见位置都试一遍。"""
    user = os.path.basename(os.path.expanduser('~'))
    out = []
    if os.name == 'nt':
        for letter in 'CDEFGHIJ':
            root = letter + ':' + os.sep
            if not os.path.isdir(root):
                continue
            for rel in (('Users', user, 'AppData', 'Local', 'Programs'),
                        ('Program Files',), ('Program Files (x86)',)):
                base = os.path.join(root, *rel)
                for name in ('Hermes Studio' + os.sep + 'Ekko Studio', 'Ekko Studio', 'Hermes Studio'):
                    out.append(os.path.join(base, name))
    else:
        out += ['~/Applications/Hermes Studio/Ekko Studio.app/Contents/Resources/app',
                '/Applications/Ekko Studio.app/Contents/Resources/app',
                '/opt/Ekko Studio/resources/app']
    return out


def find_app(explicit=None):
    if explicit:
        return explicit if os.path.isdir(explicit) else None
    exe = running_exe()
    if exe:
        for cand in (os.path.dirname(exe), os.path.dirname(os.path.dirname(exe))):
            if find_client(cand):
                return cand
    for c in drive_scan_candidates() + APP_CANDIDATES:
        p = os.path.expandvars(os.path.expanduser(c))
        if os.path.isdir(p) and find_client(p):
            return p
    # 兜底：在常见目录里找「名字像 Studio」且结构匹配的安装
    bases = [os.path.expandvars(r'%LOCALAPPDATA%\Programs'), os.path.expandvars(r'%PROGRAMFILES%'),
             os.path.expanduser('~/Applications'), '/Applications', '/opt']
    for base in bases:
        if not os.path.isdir(base):
            continue
        for name in os.listdir(base):
            p = os.path.join(base, name)
            if not os.path.isdir(p) or 'studio' not in name.lower():
                continue
            if find_client(p):
                return p
            for sub in os.listdir(p):
                if 'studio' in sub.lower() and find_client(os.path.join(p, sub)):
                    return os.path.join(p, sub)
    return None


def find_client(app):
    """只用明确的前端目录，绝不乱猜 —— 猜错会把补丁打到别的应用上。"""
    if not app:
        return None
    for rel in (('resources', 'webui', 'dist', 'client'),
                ('resources', 'app', 'webui', 'dist', 'client'),
                ('resources', 'app', 'dist', 'client')):
        c = os.path.join(app, *rel)
        idx = os.path.join(c, 'index.html')
        if os.path.isfile(idx) and 'node_modules' not in c:
            try:
                if b'<script type="module"' in open(idx, 'rb').read():
                    return c
            except Exception:
                pass
    return None


def find_exe(app):
    for name in EXE_CANDIDATES:
        for cand in (os.path.join(app, name), os.path.join(app, '..', name)):
            if os.path.isfile(cand):
                return os.path.abspath(cand)
    if app.endswith('.app/Contents/Resources/app'):
        return app.split('/Contents/')[0]
    return None


def app_version(app):
    try:
        return json.load(open(os.path.join(app, 'resources', 'webui', 'package.json'), encoding='utf-8')).get('version', '?')
    except Exception:
        return '?'


def native_support(client):
    for dp, dirs, fs in os.walk(client):
        for f in fs:
            if not f.endswith(('.js', '.mjs')) or f == 'tokps-overlay.js':
                continue
            p = os.path.join(dp, f)
            try:
                b = open(p, 'rb').read()
            except Exception:
                continue
            for m in NATIVE_MARKERS:
                if m.encode('utf-8') in b:
                    return m, os.path.relpath(p, client)
    return None, None


# ---------------------------------------------------------------- 文件注入
def cmd_apply(app, force=False, quiet=False):
    client = find_client(app)
    if not client:
        print('[x] 找不到 Studio 前端目录，可能是结构变了（例如搬进 app.asar）'); return 2
    marker, where = native_support(client)
    if marker and not force:
        print(f'[=] 该版本前端已自带运行统计（命中 "{marker}" @ {where}），无需打补丁')
        return 0
    with open(os.path.join(client, 'index.html'), 'rb') as fh:
        raw = fh.read()
    if TAG.encode('utf-8') in raw:
        if not quiet:
            print('[=] 已注入，跳过')
    else:
        shutil.copy2(os.path.join(client, 'index.html'), os.path.join(client, 'index.html.tokps.bak'))
        pos = raw.find(b'<script type="module"')
        if pos < 0:
            print('[x] 没找到 module script 插入点，未修改'); return 3
        eol = b'\r\n' if b'\r\n' in raw[:pos] else b'\n'
        with open(os.path.join(client, 'index.html'), 'wb') as fh:
            fh.write(raw[:pos] + TAG.encode('utf-8') + eol + raw[pos:])
        if not quiet:
            print('[+] 已注入 script 标签（备份 index.html.tokps.bak）')
    shutil.copy2(OVERLAY, os.path.join(client, 'tokps-overlay.js'))
    if not quiet:
        print('[+] 补丁文件 tokps-overlay.js 已就位')
    return 0


def cmd_revert(app):
    client = find_client(app)
    if not client:
        print('[x] 找不到 Studio 前端目录'); return 2
    bak = os.path.join(client, 'index.html.tokps.bak')
    if os.path.isfile(bak):
        shutil.copy2(bak, client + os.sep + 'index.html')
        print('[+] index.html 已还原')
    else:
        p = os.path.join(client, 'index.html')
        raw = open(p, 'rb').read().replace(TAG.encode('utf-8') + b'\r\n', b'').replace(TAG.encode('utf-8'), b'')
        open(p, 'wb').write(raw)
        print('[+] index.html 里的注入行已移除')
    ov = os.path.join(client, 'tokps-overlay.js')
    if os.path.isfile(ov):
        os.remove(ov); print('[+] 补丁文件已删除')
    print('[i] 重载 Studio（Ctrl+R）即恢复原样')
    return 0


# ---------------------------------------------------------------- 状态
def cmd_status(app):
    client = find_client(app)
    print('安装目录 :', app or '(未找到)')
    print('前端目录 :', client or '(未找到)')
    if client:
        print('应用版本 :', app_version(app))
        injected = TAG.encode('utf-8') in open(os.path.join(client, 'index.html'), 'rb').read()
        print('补丁状态 :', '已注入' if injected else '未注入')
        marker, where = native_support(client)
        print('原生统计 :', f'有（"{marker}" @ {where}）' if marker else '无')
        print('备份文件 :', '有' if os.path.isfile(os.path.join(client, 'index.html.tokps.bak')) else '无')
    print('可执行文件:', find_exe(app) or '(未找到)')
    return 0


# ---------------------------------------------------------------- 启动
def studio_running():
    """用进程路径判断（tasklist 对带空格的进程名不可靠，且中文系统输出是 GBK）。"""
    return running_exe() is not None


def cmd_launch(app, use_cdp=False, dry_run=False, port=DEFAULT_PORT):
    exe = find_exe(app)
    if not exe:
        print('[x] 找不到 Studio 可执行文件'); return 2
    if use_cdp:
        return cmd_cdp(app, port=port, dry_run=dry_run)
    rc = cmd_apply(app)
    if rc != 0:
        return rc
    if dry_run:
        print('[dry-run] 将要启动:', exe); return 0
    if studio_running():
        print('[i] Studio 已在运行：补丁已就位，在窗口里按 Ctrl+R（或重开窗口）即生效')
        return 0
    print('[i] 启动 Studio ...')
    return subprocess.call([exe], creationflags=NO_WINDOW if os.name == 'nt' else 0)


def cmd_cdp(app, port=DEFAULT_PORT, dry_run=False, restart=False):
    """运行时注入：不修改任何文件。需要 Studio 未在运行（Electron 单实例）。"""
    exe = find_exe(app)
    if not exe:
        print('[x] 找不到 Studio 可执行文件'); return 2
    if studio_running():
        if not restart:
            print('[!] Studio 正在运行 —— Electron 单实例锁会让新进程直接退出，调试端口不会打开。')
            print('    加 --restart 可先关闭再以调试模式启动，或改用 `apply`（文件注入）。')
            return 4
        if dry_run:
            print('[dry-run] 将关闭正在运行的 Studio')
        else:
            subprocess.call(['taskkill', '/IM', 'Ekko Studio.exe', '/F'], capture_output=True)
            time.sleep(2)
    args = [exe, f'--remote-debugging-port={port}', '--remote-allow-origins=*']
    if dry_run:
        print('[dry-run] 将要启动:', ' '.join(args))
        print('[dry-run] 然后执行: node inject-cdp.mjs --source tokps-overlay.js --port', port, '--match 127.0.0.1')
        return 0
    print('[i] 以调试端口', port, '启动 Studio ...')
    subprocess.Popen(args, creationflags=NO_WINDOW if os.name == 'nt' else 0)
    node = shutil.which('node')
    if not node:
        print('[!] 没找到 node，无法执行 CDP 注入；Studio 已按普通方式启动')
        return 5
    return subprocess.call([node, CDP_INJECTOR, '--source', OVERLAY, '--port', str(port), '--match', '127.0.0.1'])


# ---------------------------------------------------------------- 入口
def main():
    ap = argparse.ArgumentParser(prog='studio_tokps', description='Ekko Studio tok/s 浮标补丁（无常驻后台）')
    ap.add_argument('command', nargs='?', default='launch',
                    choices=['status', 'apply', 'revert', 'launch', 'cdp'])
    ap.add_argument('--app', default=None, help='Studio 安装目录（默认自动探测）')
    ap.add_argument('--force', action='store_true', help='即使前端已自带统计也注入')
    ap.add_argument('--cdp', action='store_true', help='launch 时改用运行时注入（不碰文件）')
    ap.add_argument('--port', type=int, default=DEFAULT_PORT)
    ap.add_argument('--restart', action='store_true', help='cdp 模式下先关闭正在运行的 Studio')
    ap.add_argument('--dry-run', action='store_true', help='只打印将要做什么，不实际执行')
    a = ap.parse_args()

    app = find_app(a.app)
    if not app:
        print('[x] 没有找到 Ekko Studio 安装目录，请用 --app 指定'); return 2
    print(f'[i] 安装目录: {app}')
    if a.command == 'status':
        return cmd_status(app)
    if a.command == 'apply':
        return cmd_apply(app, force=a.force)
    if a.command == 'revert':
        return cmd_revert(app)
    if a.command == 'cdp':
        return cmd_cdp(app, port=a.port, dry_run=a.dry_run, restart=a.restart)
    return cmd_launch(app, use_cdp=a.cdp, dry_run=a.dry_run, port=a.port)


if __name__ == '__main__':
    sys.exit(main())

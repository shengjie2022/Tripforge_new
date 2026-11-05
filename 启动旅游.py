# -*- coding: utf-8 -*-
"""
旅游攻略 · 启动器

  python 启动旅游.py              仅本机访问   http://127.0.0.1:8901/
  python 启动旅游.py --lan        允许同一 WiFi 下的手机/平板访问
  python 启动旅游.py --port 9000  换端口
  python 启动旅游.py --no-browser 不自动开浏览器

启动后：
  · 自动起一个只读本地 HTTP 服务（账单文件在浏览器里解析，不会传给这个服务）
  · 等端口真正就绪后才打开浏览器，避免"第一次打开显示无法访问"
  · Ctrl+C 或关掉窗口即停止服务
"""
import argparse
import http.server
import os
import socket
import socketserver
import sys
import threading
import time
import urllib.request
import webbrowser

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")


class Handler(http.server.SimpleHTTPRequestHandler):
    """只提供本目录下的静态文件，并关掉缓存，改完代码刷新就生效。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass  # 不刷屏

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def port_open(host, port):
    try:
        with socket.create_connection((host, port), timeout=0.4):
            return True
    except OSError:
        return False


def is_own_service(port):
    """端口上跑的是不是旅游攻略。

    端口被占用有两种情况：上次的服务还在跑（可以直接用），
    或者被别的程序占了（这时把浏览器打开过去只会看到一个陌生的网站）。
    """
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d/index.html' % port, timeout=1.2) as r:
            body = r.read(8192).decode('utf-8', 'ignore')
        return '旅游攻略' in body or 'TripForge' in body
    except Exception:
        return False


def local_ip():
    """取本机在局域网里的 IP，给手机用。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--port', type=int, default=8901)
    ap.add_argument('--lan', action='store_true', help='允许局域网（手机）访问')
    ap.add_argument('--no-browser', action='store_true', help='不自动打开浏览器')
    args = ap.parse_args()

    if not os.path.isfile(os.path.join(ROOT, 'index.html')):
        print('缺少 dist 构建产物。请在本目录执行 npm ci 和 npm run build。')
        return 1
    host = '0.0.0.0' if args.lan else '127.0.0.1'
    shown = '127.0.0.1' if not args.lan else local_ip()
    url = 'http://%s:%d/index.html' % (shown, args.port)

    # 端口已被占用：先分清是"上次的服务还在跑"还是"别的程序占了"
    if port_open('127.0.0.1', args.port):
        if is_own_service(args.port):
            print('检测到端口 %d 上已经在跑旅游攻略，直接打开现有服务。' % args.port)
            if not args.no_browser:
                webbrowser.open(url)
            return 0
        print('端口 %d 被别的程序占用了，那上面不是旅游攻略。' % args.port)
        print('可以用 --port 换一个端口，例如：python 启动旅游.py --port %d' % (args.port + 1))
        print('或者直接双击 index.html 用浏览器打开。')
        return 1

    try:
        httpd = Server((host, args.port), Handler)
    except OSError as e:
        print('端口 %d 无法启动：%s' % (args.port, e))
        print('可以用 --port 换一个端口，或直接双击 index.html 用浏览器打开。')
        return 1

    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()

    # 等端口真的起来了再开浏览器
    for _ in range(50):
        if port_open('127.0.0.1', args.port):
            break
        time.sleep(0.1)

    print('')
    print('  旅游攻略已启动')
    print('  本机访问： http://127.0.0.1:%d/index.html' % args.port)
    if args.lan:
        print('  手机访问： http://%s:%d/index.html   (需连同一个 WiFi)' % (local_ip(), args.port))
    print('')
    print('  行程编排在浏览器完成；天气、图片与可选 AI 会按功能联网。')
    print('  按 Ctrl+C 停止服务。')
    print('')

    if not args.no_browser:
        webbrowser.open(url)

    try:
        while t.is_alive():
            t.join(0.5)
    except KeyboardInterrupt:
        print('\n已停止服务。')
        httpd.shutdown()
    return 0


if __name__ == '__main__':
    sys.exit(main())

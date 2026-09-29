# -*- coding: utf-8 -*-
"""本地测试用：模拟 Studio 的 /chat-run NDJSON 流，用来验证补丁的流式嗅探。仅监听 127.0.0.1。"""
import json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.send_header("Content-Length", "0"); self.end_headers()
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n: self.rfile.read(n)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self._cors()
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        def send(obj):
            b = (json.dumps(obj, ensure_ascii=False) + "\n").encode()
            self.wfile.write(b"%x\r\n" % len(b) + b + b"\r\n"); self.wfile.flush()
        try:
            send({"event": "run.started", "session_id": "ndjson-test"})
            for i in range(40):
                send({"event": "message.delta", "session_id": "ndjson-test", "delta": "中文输出测试一二三四五六"})
                time.sleep(0.05)
            send({"event": "usage.updated", "session_id": "ndjson-test", "output_tokens": 640, "input_tokens": 3000, "context_tokens": 3400})
            send({"event": "run.completed", "session_id": "ndjson-test", "output_tokens": 640})
        except Exception:
            pass
        self.wfile.write(b"0\r\n\r\n"); self.wfile.flush()
    def log_message(self, *a):
        pass

ThreadingHTTPServer(("127.0.0.1", 8899), H).serve_forever()

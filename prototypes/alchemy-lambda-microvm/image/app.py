import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        payload = self.rfile.read(length).decode("utf-8")
        if self.path == "/aws/lambda-microvms/runtime/v1/ready":
            print(
                json.dumps(
                    {
                        "marker": "FIRECLANKER_READY_HOOK",
                        "initializedAt": datetime.now(timezone.utc).isoformat(),
                    }
                ),
                flush=True,
            )
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ready")
            return

        if self.path == "/aws/lambda-microvms/runtime/v1/run":
            print(
                json.dumps(
                    {
                        "marker": "FIRECLANKER_RUN_HOOK",
                        "payload": payload,
                        "initializedAt": datetime.now(timezone.utc).isoformat(),
                    }
                ),
                flush=True,
            )
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ready")
            return

        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        print(format % args, flush=True)


HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()

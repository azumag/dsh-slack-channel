# Answers every connection on :8443 with plain-text HTTP, like the box behind :443 on Muse's VM.
import socketserver

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            self.request.recv(4096)
            self.request.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 11\r\n\r\nplain text\n")
        except OSError:
            pass

socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer(("0.0.0.0", 8443), Handler).serve_forever()

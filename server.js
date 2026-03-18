const http = require("http");

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Hello from BTB server!");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});

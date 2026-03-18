import { createServer } from "http";

const PORT = parseInt(process.env.PORT || "3001", 10);

const server = createServer((req, res) => {
  console.log(`${req.method} ${req.url}`);

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Hello from test server!");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Test server listening on 0.0.0.0:${PORT}`);
});

import http from "http";
import app from "./app.js";
import { config } from "./config/index.js";

const port = process.env.PORT || config.port;

const server = http.createServer(app);
server.listen(port, () => {
  console.log(`🚀  API running on http://localhost:${port}`);
});

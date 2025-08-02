import http from "http";
import app from "./app.js";
import { config } from "./config/index.js";

const server = http.createServer(app);
server.listen(config.port, () => {
  /* eslint-disable no-console */
  console.log(`🚀  API ready on http://localhost:${config.port}`);
  /* eslint-enable no-console */
});

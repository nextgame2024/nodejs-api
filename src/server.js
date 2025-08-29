import app from "./app.js";
import { pingDb } from "./config/db.js";

const port = Number(process.env.PORT || 3300);

(async () => {
  try {
    await pingDb();
    console.log("✅ DB reachable");
  } catch (e) {
    console.error("❌ DB ping failed on startup:", e?.code || e?.message || e);
    process.exit(1);
  }

  app.listen(port, () => {
    console.log(`API listening on :${port}`);
  });
})();

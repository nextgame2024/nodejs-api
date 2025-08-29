import { Router } from "express";
import dns from "node:dns/promises";
import net from "node:net";
import pool, { pingDb } from "../config/db.js";

const router = Router();

router.get("/diag/db", async (_req, res) => {
  const host =
    process.env.DB_HOST ||
    (process.env.DATABASE_URL || process.env.MYSQL_URL || "")
      .split("@")
      .pop()
      ?.split(":")[0];

  const port = Number(process.env.DB_PORT || 3306);
  const out = { host, port };

  try {
    const addrs = await dns.lookup(host, { all: true });
    out.dns = addrs;
  } catch (e) {
    out.dnsError = e.message || String(e);
    return res.status(500).json(out);
  }

  // raw TCP test
  out.tcp = { ok: false };
  await new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 5000 }, () => {
      out.tcp.ok = true;
      socket.destroy();
      resolve();
    });
    socket.on("timeout", () => {
      out.tcp.error = "timeout";
      socket.destroy();
      resolve();
    });
    socket.on("error", (err) => {
      out.tcp.error = err.code || err.message;
      resolve();
    });
  });

  if (!out.tcp.ok) return res.status(500).json(out);

  // mysql ping
  try {
    await pingDb();
    out.mysql = "pong";
    res.json(out);
  } catch (e) {
    out.mysql = e.code || e.message || String(e);
    res.status(500).json(out);
  }
});

export default router;

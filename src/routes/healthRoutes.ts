import { Router } from "express";
import { pool } from "../db/client";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: "error", message: String(err) });
  }
});

import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.sites.service.js";

export const listSites = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { q, status, page = "1", limit = "20" } = req.query;
  const result = await service.listSites(companyId, {
    q,
    status,
    page: Number(page),
    limit: Number(limit),
  });
  res.json(result);
});

export const getSite = asyncHandler(async (req, res) => {
  const site = await service.getSite(req.user.companyId, req.params.siteId);
  if (!site) return res.status(404).json({ error: "Site not found" });
  res.json({ site });
});

export const createSite = asyncHandler(async (req, res) => {
  const payload = req.body?.site || req.body || {};
  if (!payload.site_name) {
    return res.status(400).json({ error: "site_name is required" });
  }
  const site = await service.createSite(req.user.companyId, req.user.id, payload);
  res.status(201).json({ site });
});

export const updateSite = asyncHandler(async (req, res) => {
  const payload = req.body?.site || req.body || {};
  const site = await service.updateSite(
    req.user.companyId,
    req.params.siteId,
    payload,
  );
  if (!site) return res.status(404).json({ error: "Site not found" });
  res.json({ site });
});

export const archiveSite = asyncHandler(async (req, res) => {
  const ok = await service.archiveSite(req.user.companyId, req.params.siteId);
  if (!ok) return res.status(404).json({ error: "Site not found" });
  res.status(204).send();
});

import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.company.service.js";

const SUPER_ADMIN_ID = "c2dad143-077c-4082-92f0-47805601db3b";
const isSuperAdmin = (req) => req.user?.id === SUPER_ADMIN_ID;
const WORKSPACE_PROFILES = new Set(["project_map", "student_operations"]);

function validateWorkspaceProfile(payload) {
  if (payload.workspace_profile === undefined) return;
  if (!WORKSPACE_PROFILES.has(payload.workspace_profile)) {
    const error = new Error("Invalid workspace_profile");
    error.status = 400;
    throw error;
  }
}

export const listCompanies = asyncHandler(async (req, res) => {
  const companyId = isSuperAdmin(req) ? null : req.user.companyId;
  const { q, status, page = "1", limit = "20" } = req.query;

  const result = await service.listCompanies(companyId, {
    q,
    status,
    page: Number(page),
    limit: Number(limit),
  });

  res.json(result);
});

export const getCompany = asyncHandler(async (req, res) => {
  const companyId = isSuperAdmin(req)
    ? req.params.companyId
    : req.user.companyId;
  const { companyId: targetCompanyId } = req.params;

  const company = await service.getCompany(companyId, targetCompanyId);
  if (!company) return res.status(404).json({ error: "Company not found" });

  res.json({ company });
});

export const createCompany = asyncHandler(async (req, res) => {
  if (!isSuperAdmin(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const companyId = null;
  const userId = req.user.id;
  const payload = req.body?.company || req.body || {};

  if (!payload.company_name) {
    return res.status(400).json({ error: "company_name is required" });
  }
  validateWorkspaceProfile(payload);

  const company = await service.createCompany(companyId, userId, payload);
  res.status(201).json({ company });
});

export const updateCompany = asyncHandler(async (req, res) => {
  const superAdmin = isSuperAdmin(req);
  const companyId = isSuperAdmin(req)
    ? req.params.companyId
    : req.user.companyId;
  const { companyId: targetCompanyId } = req.params;
  const payload = req.body?.company || req.body || {};

  if (!superAdmin) {
    delete payload.status;
    delete payload.workspace_profile;
  } else {
    validateWorkspaceProfile(payload);
  }

  const company = await service.updateCompany(
    companyId,
    targetCompanyId,
    payload,
  );
  if (!company) return res.status(404).json({ error: "Company not found" });

  res.json({ company });
});

export const archiveCompany = asyncHandler(async (req, res) => {
  if (!isSuperAdmin(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const companyId = req.params.companyId;
  const { companyId: targetCompanyId } = req.params;

  const ok = await service.archiveCompany(companyId, targetCompanyId);
  if (!ok) return res.status(404).json({ error: "Company not found" });

  res.status(204).send();
});

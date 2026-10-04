import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.navigation.links.service.js";

const SUPER_ADMIN_ID = "c2dad143-077c-4082-92f0-47805601db3b";
const isSuperAdmin = (req) => req.user?.id === SUPER_ADMIN_ID;
const SOPHIA_ADMIN_LABEL = "Sophia Ai admin";
const SOPHIA_ADMIN_MODULES = new Set([
  "ADM-01", "ADM-02", "ADM-03", "ADM-04", "ADM-05", "ADM-06", "ADM-07", "ADM-08",
  "ADM-09", "ADM-10", "ADM-11", "ADM-12", "ADM-13", "ADM-14", "ADM-15", "ADM-16",
]);

const NAVIGATION_LABELS_BY_TYPE = {
  header: [
    "Home",
    "Town planner",
    "Business manager",
    "Explore Business Manager",
    "Ai Toolkit",
    "Dashboard",
    "Settings",
    SOPHIA_ADMIN_LABEL,
  ],
  menu: [
    "Clients",
    "Sites",
    "Pallets",
    "Projects",
    "Project types",
    "Scheduling",
    "Users",
    "Company",
    "Navigation links",
    "Suppliers",
    "Materials",
    "Labor costs",
    "Pricing",
    "Quotes",
    "Invoices",
  ],
};

const ALLOWED_TYPES = new Set(Object.keys(NAVIGATION_LABELS_BY_TYPE));

const badRequest = (message) => {
  const err = new Error(message);
  err.status = 400;
  return err;
};

const normalizeText = (value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed || null;
};

const normalizeNavigationType = (value) => {
  const normalized = normalizeText(value);
  return typeof normalized === "string" ? normalized.toLowerCase() : normalized;
};

const parseBoolean = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
};

const labelEquals = (a, b) =>
  String(a || "")
    .trim()
    .toLowerCase() ===
  String(b || "")
    .trim()
    .toLowerCase();

const validateTypeAndLabel = ({ navigationType, navigationLabel }) => {
  if (!navigationType) throw badRequest("navigation_type is required");
  if (!ALLOWED_TYPES.has(navigationType)) {
    throw badRequest("navigation_type must be one of: header, menu");
  }

  if (!navigationLabel) throw badRequest("navigation_label is required");

  const allowedLabels = NAVIGATION_LABELS_BY_TYPE[navigationType] ?? [];
  const allowed = allowedLabels.some((label) =>
    labelEquals(label, navigationLabel),
  );
  if (!allowed) {
    throw badRequest(
      `navigation_label is invalid for navigation_type '${navigationType}'`,
    );
  }
};

const validateTypeAndLabels = ({ navigationType, navigationLabels }) => {
  if (!navigationType) throw badRequest("navigation_type is required");
  if (!ALLOWED_TYPES.has(navigationType)) {
    throw badRequest("navigation_type must be one of: header, menu");
  }
  if (!Array.isArray(navigationLabels)) {
    throw badRequest("navigation_labels must be an array");
  }

  const allowedLabels = NAVIGATION_LABELS_BY_TYPE[navigationType] ?? [];
  const invalid = navigationLabels.find(
    (label) => !allowedLabels.some((allowed) => labelEquals(allowed, label)),
  );

  if (invalid) {
    throw badRequest(
      `navigation_label '${invalid}' is invalid for navigation_type '${navigationType}'`,
    );
  }
};

const normalizePayload = (rawPayload) => {
  const payload = rawPayload || {};
  const next = {
    ...payload,
    company_id:
      payload.company_id !== undefined ? payload.company_id : payload.companyId,
  };

  if (next.navigation_type !== undefined) {
    next.navigation_type = normalizeNavigationType(next.navigation_type);
  }

  if (next.navigation_label !== undefined) {
    const rawLabel = normalizeText(next.navigation_label);
    if (rawLabel) {
      const labels =
        NAVIGATION_LABELS_BY_TYPE[next.navigation_type] ||
        Object.values(NAVIGATION_LABELS_BY_TYPE).flat();
      const canonical = labels.find((label) => labelEquals(label, rawLabel));
      next.navigation_label = canonical || rawLabel;
    } else {
      next.navigation_label = null;
    }
  }

  if (next.navigation_labels !== undefined) {
    if (!Array.isArray(next.navigation_labels)) {
      throw badRequest("navigation_labels must be an array");
    }
    next.navigation_labels = next.navigation_labels
      .map((label) => normalizeText(label))
      .filter((label) => !!label);

    if (next.navigation_type) {
      const labels = NAVIGATION_LABELS_BY_TYPE[next.navigation_type] ?? [];
      next.navigation_labels = next.navigation_labels.map((rawLabel) => {
        const canonical = labels.find((label) => labelEquals(label, rawLabel));
        return canonical || rawLabel;
      });
    }
  }

  if (next.active !== undefined) {
    const parsed = parseBoolean(next.active);
    if (parsed === null) throw badRequest("active must be true or false");
    next.active = parsed;
  }

  if (next.company_id !== undefined && next.company_id !== null) {
    next.company_id = String(next.company_id);
  }

  delete next.companyId;
  return next;
};

const resolveCompanyScopeForList = async (req) => {
  if (!isSuperAdmin(req)) return req.user.companyId;

  const requested = normalizeText(req.query.companyId);
  if (!requested) return null;

  const exists = await service.companyExists(requested);
  if (!exists) throw badRequest("Invalid companyId");

  return requested;
};

const resolveCompanyIdForCreate = async (req, payload) => {
  if (!isSuperAdmin(req)) return req.user.companyId;

  const requested = normalizeText(payload.company_id);
  if (!requested) throw badRequest("company_id is required for super admin");

  const exists = await service.companyExists(requested);
  if (!exists) throw badRequest("Invalid company_id");

  return requested;
};

const withDuplicateKeyHandling = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (err?.code === "23505") {
      const duplicate = new Error(
        "navigation_label already exists for this company",
      );
      duplicate.status = 409;
      throw duplicate;
    }
    throw err;
  }
};

export const listNavigationLinks = asyncHandler(async (req, res) => {
  const companyId = await resolveCompanyScopeForList(req);
  const { q, page = "1", limit = "20" } = req.query;
  const navigationType = normalizeNavigationType(
    req.query.navigationType ?? req.query.navigation_type,
  );

  if (navigationType && !ALLOWED_TYPES.has(navigationType)) {
    throw badRequest("navigationType must be one of: header, menu");
  }

  const activeRaw = req.query.active;
  let active;
  if (activeRaw !== undefined) {
    active = parseBoolean(activeRaw);
    if (active === null) throw badRequest("active must be true or false");
  }

  const result = await service.listNavigationLinks(companyId, {
    q,
    navigationType,
    active,
    page: Number(page),
    limit: Number(limit),
  });

  res.json(result);
});

export const getNavigationLink = asyncHandler(async (req, res) => {
  const companyId = isSuperAdmin(req) ? null : req.user.companyId;
  const { navigationLinkId } = req.params;

  const navigationLink = await service.getNavigationLink(
    companyId,
    navigationLinkId,
  );
  if (!navigationLink) {
    return res.status(404).json({ error: "Navigation link not found" });
  }

  res.json({ navigationLink });
});

export const createNavigationLink = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const payload = normalizePayload(req.body?.navigationLink || req.body || {});

  const companyId = await resolveCompanyIdForCreate(req, payload);
  validateTypeAndLabel({
    navigationType: payload.navigation_type,
    navigationLabel: payload.navigation_label,
  });
  if (labelEquals(payload.navigation_label, SOPHIA_ADMIN_LABEL)) {
    throw badRequest("Use the user-scoped navigation sync to assign Sophia Admin access");
  }

  const navigationLink = await withDuplicateKeyHandling(() =>
    service.createNavigationLink(companyId, userId, payload),
  );

  res.status(201).json({ navigationLink });
});

export const syncNavigationLabels = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const payload = normalizePayload(
    req.body?.navigationLinksSync || req.body || {},
  );

  const companyId = await resolveCompanyIdForCreate(req, payload);
  validateTypeAndLabels({
    navigationType: payload.navigation_type,
    navigationLabels: payload.navigation_labels ?? [],
  });

  const selectedSophiaAdmin = (payload.navigation_labels ?? []).some((label) =>
    labelEquals(label, SOPHIA_ADMIN_LABEL),
  );
  const targetUserId = normalizeText(
    payload.target_user_id ?? payload.targetUserId,
  );
  const targetUserIds = Array.from(
    new Set(
      (Array.isArray(payload.target_user_ids) ? payload.target_user_ids : [])
        .map(normalizeText)
        .filter(Boolean),
    ),
  );
  if (targetUserId) targetUserIds.unshift(targetUserId);
  const uniqueTargetUserIds = Array.from(new Set(targetUserIds));
  if (uniqueTargetUserIds.length > 100) {
    throw badRequest("A maximum of 100 target users may be updated at once");
  }
  if (uniqueTargetUserIds.length && companyId !== req.user.companyId) {
    const error = new Error("Sophia Admin access can only be assigned within the internal operator company");
    error.status = 403;
    throw error;
  }
  const requestedModules = Array.isArray(payload.sophia_admin_modules)
    ? Array.from(new Set(payload.sophia_admin_modules.map(normalizeText).filter(Boolean)))
    : [];
  const invalidModule = requestedModules.find((moduleId) => !SOPHIA_ADMIN_MODULES.has(moduleId));
  if (invalidModule) throw badRequest(`Unknown Sophia Admin module: ${invalidModule}`);
  if (selectedSophiaAdmin && !isSuperAdmin(req)) {
    const error = new Error("Only the platform super administrator can assign Sophia Admin access");
    error.status = 403;
    throw error;
  }
  if (selectedSophiaAdmin && payload.navigation_type !== "header") {
    throw badRequest("Sophia Ai admin is available only as a header link");
  }
  if (selectedSophiaAdmin && uniqueTargetUserIds.length === 0) {
    throw badRequest("At least one target user is required for Sophia Admin access");
  }
  const enableSophiaAdmin = selectedSophiaAdmin && requestedModules.length > 0;

  const genericLabels = (payload.navigation_labels ?? []).filter(
    (label) => !labelEquals(label, SOPHIA_ADMIN_LABEL),
  );

  const result = await withDuplicateKeyHandling(() =>
    service.syncNavigationLabels(companyId, userId, {
      navigation_type: payload.navigation_type,
      navigation_labels: genericLabels,
    }),
  );

  let sophiaAdminEntitlement = null;
  let sophiaAdminEntitlements = [];
  if (isSuperAdmin(req) && payload.navigation_type === "header" && uniqueTargetUserIds.length) {
    sophiaAdminEntitlements = await service.syncSophiaAdminEntitlements({
      companyId,
      targetUserIds: uniqueTargetUserIds,
      actorUserId: userId,
      modules: requestedModules,
      enabled: enableSophiaAdmin,
    });
    sophiaAdminEntitlement = sophiaAdminEntitlements[0] ?? null;
  }

  res.json({ ...result, sophiaAdminEntitlement, sophiaAdminEntitlements });
});

export const getSophiaAdminEntitlement = asyncHandler(async (req, res) => {
  if (!isSuperAdmin(req)) {
    return res.status(403).json({ error: "Platform super administrator access is required" });
  }
  const companyId = normalizeText(req.query.companyId);
  const targetUserId = normalizeText(req.query.userId);
  if (!companyId || !targetUserId) {
    throw badRequest("companyId and userId are required");
  }
  if (companyId !== req.user.companyId) {
    return res.status(403).json({ error: "Sophia Admin access is restricted to the internal operator company" });
  }
  const entitlement = await service.getSophiaAdminEntitlement(companyId, targetUserId);
  if (!entitlement) {
    return res.status(404).json({ error: "The selected company user was not found" });
  }
  res.json({ entitlement });
});

export const updateNavigationLink = asyncHandler(async (req, res) => {
  const scopeCompanyId = isSuperAdmin(req) ? null : req.user.companyId;
  const { navigationLinkId } = req.params;
  const payload = normalizePayload(req.body?.navigationLink || req.body || {});

  const current = await service.getNavigationLink(
    scopeCompanyId,
    navigationLinkId,
  );
  if (!current) {
    return res.status(404).json({ error: "Navigation link not found" });
  }

  if (!isSuperAdmin(req)) {
    delete payload.company_id;
  } else if (payload.company_id !== undefined) {
    const exists = await service.companyExists(payload.company_id);
    if (!exists) throw badRequest("Invalid company_id");
  }

  const nextType = payload.navigation_type ?? current.navigationType;
  const nextLabel = payload.navigation_label ?? current.navigationLabel;

  validateTypeAndLabel({
    navigationType: nextType,
    navigationLabel: nextLabel,
  });
  if (labelEquals(nextLabel, SOPHIA_ADMIN_LABEL)) {
    throw badRequest("Use the user-scoped navigation sync to assign Sophia Admin access");
  }

  const navigationLink = await withDuplicateKeyHandling(() =>
    service.updateNavigationLink(scopeCompanyId, navigationLinkId, payload),
  );

  if (!navigationLink) {
    return res.status(404).json({ error: "Navigation link not found" });
  }

  res.json({ navigationLink });
});

export const deleteNavigationLink = asyncHandler(async (req, res) => {
  const companyId = isSuperAdmin(req) ? null : req.user.companyId;
  const { navigationLinkId } = req.params;

  const ok = await service.deleteNavigationLink(companyId, navigationLinkId);
  if (!ok) {
    return res.status(404).json({ error: "Navigation link not found" });
  }

  res.status(204).send();
});

export const listActiveNavigationLinks = asyncHandler(async (req, res) => {
  let companyId = req.user.companyId;

  if (isSuperAdmin(req)) {
    const requested = normalizeText(req.query.companyId);
    if (requested) {
      const exists = await service.companyExists(requested);
      if (!exists) throw badRequest("Invalid companyId");
      companyId = requested;
    }
  }

  const navigationType = normalizeNavigationType(
    req.query.navigationType ?? req.query.navigation_type ?? req.query.type,
  );
  if (navigationType && !ALLOWED_TYPES.has(navigationType)) {
    throw badRequest("navigationType must be one of: header, menu");
  }

  const includeUserEntitlement = companyId === req.user.companyId;
  const navigationLinks = await service.listActiveNavigationLinks(
    companyId,
    includeUserEntitlement ? req.user.id : null,
    { navigationType },
  );

  res.json({ navigationLinks });
});

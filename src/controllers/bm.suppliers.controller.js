import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.suppliers.service.js";

export const listSuppliers = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { q, status, page = "1", limit = "20" } = req.query;

  const result = await service.listSuppliers(companyId, {
    q,
    status,
    page: Number(page),
    limit: Number(limit),
  });

  res.json(result);
});

export const getSupplier = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { supplierId } = req.params;

  const supplier = await service.getSupplier(companyId, supplierId);
  if (!supplier) return res.status(404).json({ error: "Supplier not found" });

  res.json({ supplier });
});

export const createSupplier = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const userId = req.user.id;
  const payload = req.body?.supplier || req.body || {};

  if (!payload.supplier_name)
    return res.status(400).json({ error: "supplier_name is required" });

  const supplier = await service.createSupplier(companyId, userId, payload);
  res.status(201).json({ supplier });
});

export const updateSupplier = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { supplierId } = req.params;
  const payload = req.body?.supplier || req.body || {};

  const supplier = await service.updateSupplier(companyId, supplierId, payload);
  if (!supplier) return res.status(404).json({ error: "Supplier not found" });

  res.json({ supplier });
});

export const removeSupplier = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { supplierId } = req.params;

  const result = await service.removeSupplier(companyId, supplierId);
  if (!result?.ok) return res.status(404).json({ error: "Supplier not found" });

  res.json({ supplierId, action: result.action });
});

// Contacts
export const listSupplierContacts = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { supplierId } = req.params;
  const { page = "1", limit = "20" } = req.query;

  const result = await service.listSupplierContacts(companyId, supplierId, {
    page: Number(page),
    limit: Number(limit),
  });
  if (result === null)
    return res.status(404).json({ error: "Supplier not found" });

  res.json(result);
});

export const createSupplierContact = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { supplierId } = req.params;
  const payload = req.body?.contact || req.body || {};

  if (!payload.name)
    return res.status(400).json({ error: "contact name is required" });

  const contact = await service.createSupplierContact(
    companyId,
    supplierId,
    payload
  );
  if (!contact) return res.status(404).json({ error: "Supplier not found" });

  res.status(201).json({ contact });
});

export const updateSupplierContact = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { supplierId, contactId } = req.params;
  const payload = req.body?.contact || req.body || {};

  const contact = await service.updateSupplierContact(
    companyId,
    supplierId,
    contactId,
    payload
  );
  if (!contact) return res.status(404).json({ error: "Contact not found" });

  res.json({ contact });
});

export const deleteSupplierContact = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { supplierId, contactId } = req.params;

  const ok = await service.deleteSupplierContact(
    companyId,
    supplierId,
    contactId
  );
  if (!ok) return res.status(404).json({ error: "Contact not found" });

  res.status(204).send();
});

// Supplier ↔ Materials
export const listSupplierMaterials = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { supplierId } = req.params;
  const { page = "1", limit = "20" } = req.query;

  const result = await service.listSupplierMaterials(companyId, supplierId, {
    page: Number(page),
    limit: Number(limit),
  });
  if (result === null)
    return res.status(404).json({ error: "Supplier not found" });

  res.json(result);
});

export const addSupplierMaterial = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { supplierId } = req.params;
  const payload = req.body?.supplierMaterial || req.body || {};

  if (!payload.material_id)
    return res.status(400).json({ error: "material_id is required" });

  const row = await service.addSupplierMaterial(companyId, supplierId, payload);
  if (!row)
    return res
      .status(404)
      .json({ error: "Supplier not found or material not accessible" });

  res.status(201).json({ supplierMaterial: row });
});

export const updateSupplierMaterial = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { supplierId, materialId } = req.params;
  const payload = req.body?.supplierMaterial || req.body || {};

  const row = await service.updateSupplierMaterial(
    companyId,
    supplierId,
    materialId,
    payload
  );
  if (!row)
    return res
      .status(404)
      .json({ error: "Supplier material mapping not found" });

  res.json({ supplierMaterial: row });
});

export const removeSupplierMaterial = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { supplierId, materialId } = req.params;

  const ok = await service.removeSupplierMaterial(
    companyId,
    supplierId,
    materialId
  );
  if (!ok)
    return res
      .status(404)
      .json({ error: "Supplier material mapping not found" });

  res.status(204).send();
});

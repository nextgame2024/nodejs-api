import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.suppliers.service.js";

export const listSuppliers = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { q, status, page = "1", limit = "20" } = req.query;

  const result = await service.listSuppliers(userId, {
    q,
    status,
    page: Number(page),
    limit: Number(limit),
  });

  res.json(result); // { suppliers, page, limit, total }
});

export const getSupplier = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { supplierId } = req.params;

  const supplier = await service.getSupplier(userId, supplierId);
  if (!supplier) return res.status(404).json({ error: "Supplier not found" });

  res.json({ supplier });
});

export const createSupplier = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const payload = req.body?.supplier || req.body || {};

  if (!payload.supplier_name)
    return res.status(400).json({ error: "supplier_name is required" });

  const supplier = await service.createSupplier(userId, payload);
  res.status(201).json({ supplier });
});

export const updateSupplier = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { supplierId } = req.params;
  const payload = req.body?.supplier || req.body || {};

  const supplier = await service.updateSupplier(userId, supplierId, payload);
  if (!supplier) return res.status(404).json({ error: "Supplier not found" });

  res.json({ supplier });
});

export const archiveSupplier = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { supplierId } = req.params;

  const ok = await service.archiveSupplier(userId, supplierId);
  if (!ok) return res.status(404).json({ error: "Supplier not found" });

  res.status(204).send();
});

// Contacts
export const listSupplierContacts = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { supplierId } = req.params;

  const contacts = await service.listSupplierContacts(userId, supplierId);
  if (contacts === null)
    return res.status(404).json({ error: "Supplier not found" });

  res.json({ contacts });
});

export const createSupplierContact = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { supplierId } = req.params;
  const payload = req.body?.contact || req.body || {};

  if (!payload.name)
    return res.status(400).json({ error: "contact name is required" });

  const contact = await service.createSupplierContact(
    userId,
    supplierId,
    payload
  );
  if (!contact) return res.status(404).json({ error: "Supplier not found" });

  res.status(201).json({ contact });
});

export const updateSupplierContact = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { supplierId, contactId } = req.params;
  const payload = req.body?.contact || req.body || {};

  const contact = await service.updateSupplierContact(
    userId,
    supplierId,
    contactId,
    payload
  );
  if (!contact) return res.status(404).json({ error: "Contact not found" });

  res.json({ contact });
});

export const deleteSupplierContact = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { supplierId, contactId } = req.params;

  const ok = await service.deleteSupplierContact(userId, supplierId, contactId);
  if (!ok) return res.status(404).json({ error: "Contact not found" });

  res.status(204).send();
});

// Supplier materials mapping
export const listSupplierMaterials = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { supplierId } = req.params;

  const materials = await service.listSupplierMaterials(userId, supplierId);
  if (materials === null)
    return res.status(404).json({ error: "Supplier not found" });

  res.json({ materials });
});

export const addSupplierMaterial = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { supplierId } = req.params;
  const payload = req.body?.supplierMaterial || req.body || {};

  if (!payload.material_id)
    return res.status(400).json({ error: "material_id is required" });

  const row = await service.addSupplierMaterial(userId, supplierId, payload);
  if (!row)
    return res
      .status(404)
      .json({ error: "Supplier not found or material not accessible" });

  res.status(201).json({ supplierMaterial: row });
});

export const updateSupplierMaterial = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { supplierId, materialId } = req.params;
  const payload = req.body?.supplierMaterial || req.body || {};

  const row = await service.updateSupplierMaterial(
    userId,
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
  const userId = req.user.id;
  const { supplierId, materialId } = req.params;

  const ok = await service.removeSupplierMaterial(
    userId,
    supplierId,
    materialId
  );
  if (!ok)
    return res
      .status(404)
      .json({ error: "Supplier material mapping not found" });

  res.status(204).send();
});

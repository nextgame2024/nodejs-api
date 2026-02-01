import * as model from "../models/bm.suppliers.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listSuppliers(companyId, { q, status, page, limit }) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [suppliers, total] = await Promise.all([
    model.listSuppliers(companyId, { q, status, limit: safeLimit, offset }),
    model.countSuppliers(companyId, { q, status }),
  ]);

  return { suppliers, page: safePage, limit: safeLimit, total };
}

export const getSupplier = (companyId, supplierId) =>
  model.getSupplier(companyId, supplierId);
export const createSupplier = (companyId, userId, payload) =>
  model.createSupplier(companyId, userId, payload);
export const updateSupplier = (companyId, supplierId, payload) =>
  model.updateSupplier(companyId, supplierId, payload);
export const archiveSupplier = (companyId, supplierId) =>
  model.archiveSupplier(companyId, supplierId);

// Contacts
export async function listSupplierContacts(companyId, supplierId, { page, limit }) {
  const exists = await model.supplierExists(companyId, supplierId);
  if (!exists) return null;
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [contacts, total] = await Promise.all([
    model.listSupplierContacts(companyId, supplierId, { limit: safeLimit, offset }),
    model.countSupplierContacts(companyId, supplierId),
  ]);

  return { contacts, page: safePage, limit: safeLimit, total };
}

export const createSupplierContact = (companyId, supplierId, payload) =>
  model.createSupplierContact(companyId, supplierId, payload);

export const updateSupplierContact = (
  companyId,
  supplierId,
  contactId,
  payload
) => model.updateSupplierContact(companyId, supplierId, contactId, payload);

export const deleteSupplierContact = (companyId, supplierId, contactId) =>
  model.deleteSupplierContact(companyId, supplierId, contactId);

// Supplier ↔ materials
export async function listSupplierMaterials(companyId, supplierId, { page, limit }) {
  const exists = await model.supplierExists(companyId, supplierId);
  if (!exists) return null;
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [materials, total] = await Promise.all([
    model.listSupplierMaterials(companyId, supplierId, { limit: safeLimit, offset }),
    model.countSupplierMaterials(companyId, supplierId),
  ]);

  return { materials, page: safePage, limit: safeLimit, total };
}

export const addSupplierMaterial = (companyId, supplierId, payload) =>
  model.addSupplierMaterial(companyId, supplierId, payload);

export const updateSupplierMaterial = (
  companyId,
  supplierId,
  materialId,
  payload
) => model.updateSupplierMaterial(companyId, supplierId, materialId, payload);

export const removeSupplierMaterial = (companyId, supplierId, materialId) =>
  model.removeSupplierMaterial(companyId, supplierId, materialId);

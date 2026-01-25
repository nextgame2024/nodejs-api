import * as model from "../models/bm.suppliers.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listSuppliers(userId, { q, status, page, limit }) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [suppliers, total] = await Promise.all([
    model.listSuppliers(userId, { q, status, limit: safeLimit, offset }),
    model.countSuppliers(userId, { q, status }),
  ]);

  return { suppliers, page: safePage, limit: safeLimit, total };
}

export const getSupplier = (userId, supplierId) =>
  model.getSupplier(userId, supplierId);
export const createSupplier = (userId, payload) =>
  model.createSupplier(userId, payload);
export const updateSupplier = (userId, supplierId, payload) =>
  model.updateSupplier(userId, supplierId, payload);
export const archiveSupplier = (userId, supplierId) =>
  model.archiveSupplier(userId, supplierId);

// Contacts
export async function listSupplierContacts(userId, supplierId) {
  const exists = await model.supplierExists(userId, supplierId);
  if (!exists) return null;
  return model.listSupplierContacts(userId, supplierId);
}

export async function createSupplierContact(userId, supplierId, payload) {
  const exists = await model.supplierExists(userId, supplierId);
  if (!exists) return null;
  return model.createSupplierContact(userId, supplierId, payload);
}

export const updateSupplierContact = (userId, supplierId, contactId, payload) =>
  model.updateSupplierContact(userId, supplierId, contactId, payload);

export const deleteSupplierContact = (userId, supplierId, contactId) =>
  model.deleteSupplierContact(userId, supplierId, contactId);

// Supplier materials mapping
export async function listSupplierMaterials(userId, supplierId) {
  const exists = await model.supplierExists(userId, supplierId);
  if (!exists) return null;
  return model.listSupplierMaterials(userId, supplierId);
}

export const addSupplierMaterial = (userId, supplierId, payload) =>
  model.addSupplierMaterial(userId, supplierId, payload);

export const updateSupplierMaterial = (
  userId,
  supplierId,
  materialId,
  payload
) => model.updateSupplierMaterial(userId, supplierId, materialId, payload);

export const removeSupplierMaterial = (userId, supplierId, materialId) =>
  model.removeSupplierMaterial(userId, supplierId, materialId);

import * as model from "../models/bm.suppliers.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listSuppliers(
  companyId,
  { q, status, page, limit, sort, direction },
) {
  const safeLimit = clamp(Math.trunc(Number(limit)) || 25, 1, 100);
  const safePage = clamp(Math.trunc(Number(page)) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [suppliers, total] = await Promise.all([
    model.listSuppliers(companyId, {
      q,
      status,
      limit: safeLimit,
      offset,
      sort,
      direction,
    }),
    model.countSuppliers(companyId, { q, status }),
  ]);

  return { suppliers, page: safePage, limit: safeLimit, total };
}

export const getSupplier = (companyId, supplierId) =>
  model.getSupplier(companyId, supplierId);
function validateSupplier(payload) {
  if (
    payload.supplier_type !== undefined &&
    !["services", "products"].includes(payload.supplier_type)
  )
    throw Object.assign(
      new Error("Select Services or Products for the supplier type."),
      { status: 400 },
    );
  return payload;
}
export const createSupplier = (companyId, userId, payload) =>
  model.createSupplier(companyId, userId, validateSupplier(payload));
export const updateSupplier = (companyId, supplierId, payload) =>
  model.updateSupplier(companyId, supplierId, validateSupplier(payload));

export const removeSupplier = async (companyId, supplierId) => {
  const hasRelations = await model.supplierHasRelations(companyId, supplierId);
  if (hasRelations) {
    const ok = await model.archiveSupplier(companyId, supplierId);
    return { ok, action: "archived" };
  }
  const ok = await model.deleteSupplier(companyId, supplierId);
  return { ok, action: "deleted" };
};

// Contacts
export async function listSupplierContacts(
  companyId,
  supplierId,
  { page, limit },
) {
  const exists = await model.supplierExists(companyId, supplierId);
  if (!exists) return null;
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [contacts, total] = await Promise.all([
    model.listSupplierContacts(companyId, supplierId, {
      limit: safeLimit,
      offset,
    }),
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
  payload,
) => model.updateSupplierContact(companyId, supplierId, contactId, payload);

export const deleteSupplierContact = (companyId, supplierId, contactId) =>
  model.deleteSupplierContact(companyId, supplierId, contactId);

// Supplier ↔ materials
export async function listSupplierMaterials(
  companyId,
  supplierId,
  { q, page, limit },
) {
  const exists = await model.supplierExists(companyId, supplierId);
  if (!exists) return null;
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [materials, total] = await Promise.all([
    model.listSupplierMaterials(companyId, supplierId, {
      q,
      limit: safeLimit,
      offset,
    }),
    model.countSupplierMaterials(companyId, supplierId, { q }),
  ]);

  return { materials, page: safePage, limit: safeLimit, total };
}

export const addSupplierMaterial = async (companyId, supplierId, payload) => {
  const row = await model.addSupplierMaterial(companyId, supplierId, payload);
  if (row) return row;

  // Retry once to tolerate rare stale-read timing when supplier/material
  // was just created/updated immediately before linking.
  return model.addSupplierMaterial(companyId, supplierId, payload);
};

export const updateSupplierMaterial = (
  companyId,
  supplierId,
  materialId,
  payload,
) => model.updateSupplierMaterial(companyId, supplierId, materialId, payload);

export const removeSupplierMaterial = (companyId, supplierId, materialId) =>
  model.removeSupplierMaterial(companyId, supplierId, materialId);

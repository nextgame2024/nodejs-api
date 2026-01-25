import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  listSuppliers,
  getSupplier,
  createSupplier,
  updateSupplier,
  archiveSupplier,
  listSupplierContacts,
  createSupplierContact,
  updateSupplierContact,
  deleteSupplierContact,
  listSupplierMaterials,
  addSupplierMaterial,
  updateSupplierMaterial,
  removeSupplierMaterial,
} from "../controllers/bm.suppliers.controller.js";

const router = Router();

// Suppliers
router.get("/bm/suppliers", authRequired, listSuppliers);
router.post("/bm/suppliers", authRequired, createSupplier);
router.get("/bm/suppliers/:supplierId", authRequired, getSupplier);
router.put("/bm/suppliers/:supplierId", authRequired, updateSupplier);
router.delete("/bm/suppliers/:supplierId", authRequired, archiveSupplier);

// Contacts
router.get(
  "/bm/suppliers/:supplierId/contacts",
  authRequired,
  listSupplierContacts
);
router.post(
  "/bm/suppliers/:supplierId/contacts",
  authRequired,
  createSupplierContact
);
router.put(
  "/bm/suppliers/:supplierId/contacts/:contactId",
  authRequired,
  updateSupplierContact
);
router.delete(
  "/bm/suppliers/:supplierId/contacts/:contactId",
  authRequired,
  deleteSupplierContact
);

// Supplier materials mapping
router.get(
  "/bm/suppliers/:supplierId/materials",
  authRequired,
  listSupplierMaterials
);
router.post(
  "/bm/suppliers/:supplierId/materials",
  authRequired,
  addSupplierMaterial
);
router.put(
  "/bm/suppliers/:supplierId/materials/:materialId",
  authRequired,
  updateSupplierMaterial
);
router.delete(
  "/bm/suppliers/:supplierId/materials/:materialId",
  authRequired,
  removeSupplierMaterial
);

export default router;

import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  listDocuments,
  getDocument,
  createDocument,
  updateDocument,
  archiveDocument,
  recalcDocumentTotals,
  getDocumentQuotePdf,
  listDocumentMaterialLines,
  createDocumentMaterialLine,
  updateDocumentMaterialLine,
  deleteDocumentMaterialLine,
  listDocumentLaborLines,
  createDocumentLaborLine,
  updateDocumentLaborLine,
  deleteDocumentLaborLine,
} from "../controllers/bm.documents.controller.js";

const router = Router();

// Documents
router.get("/bm/documents", authRequired, listDocuments);
router.post("/bm/documents", authRequired, createDocument);
router.get("/bm/documents/:documentId", authRequired, getDocument);
router.put("/bm/documents/:documentId", authRequired, updateDocument);
router.delete("/bm/documents/:documentId", authRequired, archiveDocument);

// Totals recalculation
router.post(
  "/bm/documents/:documentId/recalculate",
  authRequired,
  recalcDocumentTotals
);

router.get(
  "/bm/documents/:documentId/quote-pdf",
  authRequired,
  getDocumentQuotePdf
);

// Material lines
router.get(
  "/bm/documents/:documentId/material-lines",
  authRequired,
  listDocumentMaterialLines
);
router.post(
  "/bm/documents/:documentId/material-lines",
  authRequired,
  createDocumentMaterialLine
);
router.put(
  "/bm/documents/:documentId/material-lines/:lineId",
  authRequired,
  updateDocumentMaterialLine
);
router.delete(
  "/bm/documents/:documentId/material-lines/:lineId",
  authRequired,
  deleteDocumentMaterialLine
);

// Labor lines
router.get(
  "/bm/documents/:documentId/labor-lines",
  authRequired,
  listDocumentLaborLines
);
router.post(
  "/bm/documents/:documentId/labor-lines",
  authRequired,
  createDocumentLaborLine
);
router.put(
  "/bm/documents/:documentId/labor-lines/:lineId",
  authRequired,
  updateDocumentLaborLine
);
router.delete(
  "/bm/documents/:documentId/labor-lines/:lineId",
  authRequired,
  deleteDocumentLaborLine
);

export default router;

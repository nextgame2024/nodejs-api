import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.documents.service.js";

export const listDocuments = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const {
    q,
    status,
    type,
    clientId,
    projectId,
    page = "1",
    limit = "20",
  } = req.query;

  const result = await service.listDocuments(userId, {
    q,
    status,
    type,
    clientId,
    projectId,
    page: Number(page),
    limit: Number(limit),
  });

  res.json(result); // { documents, page, limit, total }
});

export const getDocument = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { documentId } = req.params;
  const { includeLines = "false" } = req.query;

  const doc = await service.getDocument(userId, documentId);
  if (!doc) return res.status(404).json({ error: "Document not found" });

  if (includeLines === "true") {
    const [materialLines, laborLines] = await Promise.all([
      service.listDocumentMaterialLines(userId, documentId),
      service.listDocumentLaborLines(userId, documentId),
    ]);
    return res.json({ document: doc, materialLines, laborLines });
  }

  res.json({ document: doc });
});

export const createDocument = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const payload = req.body?.document || req.body || {};

  if (!payload.client_id)
    return res.status(400).json({ error: "client_id is required" });
  if (!payload.type)
    return res.status(400).json({ error: "type is required (quote|invoice)" });

  const doc = await service.createDocument(userId, payload);
  if (!doc)
    return res
      .status(404)
      .json({ error: "Client not found or project not accessible" });

  res.status(201).json({ document: doc });
});

export const updateDocument = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { documentId } = req.params;
  const payload = req.body?.document || req.body || {};

  const doc = await service.updateDocument(userId, documentId, payload);
  if (!doc) return res.status(404).json({ error: "Document not found" });

  res.json({ document: doc });
});

export const archiveDocument = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { documentId } = req.params;

  const ok = await service.archiveDocument(userId, documentId);
  if (!ok) return res.status(404).json({ error: "Document not found" });

  res.status(204).send();
});

export const recalcDocumentTotals = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { documentId } = req.params;

  const doc = await service.recalcDocumentTotals(userId, documentId);
  if (!doc) return res.status(404).json({ error: "Document not found" });

  res.json({ document: doc });
});

// Material lines
export const listDocumentMaterialLines = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { documentId } = req.params;

  const lines = await service.listDocumentMaterialLines(userId, documentId);
  if (lines === null)
    return res.status(404).json({ error: "Document not found" });

  res.json({ materialLines: lines });
});

export const createDocumentMaterialLine = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { documentId } = req.params;
  const payload = req.body?.line || req.body || {};

  if (payload.unit_price === undefined)
    return res.status(400).json({ error: "unit_price is required" });

  const line = await service.createDocumentMaterialLine(
    userId,
    documentId,
    payload
  );
  if (!line) return res.status(404).json({ error: "Document not found" });

  res.status(201).json({ materialLine: line });
});

export const updateDocumentMaterialLine = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { documentId, lineId } = req.params;
  const payload = req.body?.line || req.body || {};

  const line = await service.updateDocumentMaterialLine(
    userId,
    documentId,
    lineId,
    payload
  );
  if (!line) return res.status(404).json({ error: "Line not found" });

  res.json({ materialLine: line });
});

export const deleteDocumentMaterialLine = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { documentId, lineId } = req.params;

  const ok = await service.deleteDocumentMaterialLine(
    userId,
    documentId,
    lineId
  );
  if (!ok) return res.status(404).json({ error: "Line not found" });

  res.status(204).send();
});

// Labor lines
export const listDocumentLaborLines = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { documentId } = req.params;

  const lines = await service.listDocumentLaborLines(userId, documentId);
  if (lines === null)
    return res.status(404).json({ error: "Document not found" });

  res.json({ laborLines: lines });
});

export const createDocumentLaborLine = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { documentId } = req.params;
  const payload = req.body?.line || req.body || {};

  if (payload.unit_price === undefined)
    return res.status(400).json({ error: "unit_price is required" });

  const line = await service.createDocumentLaborLine(
    userId,
    documentId,
    payload
  );
  if (!line) return res.status(404).json({ error: "Document not found" });

  res.status(201).json({ laborLine: line });
});

export const updateDocumentLaborLine = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { documentId, lineId } = req.params;
  const payload = req.body?.line || req.body || {};

  const line = await service.updateDocumentLaborLine(
    userId,
    documentId,
    lineId,
    payload
  );
  if (!line) return res.status(404).json({ error: "Line not found" });

  res.json({ laborLine: line });
});

export const deleteDocumentLaborLine = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { documentId, lineId } = req.params;

  const ok = await service.deleteDocumentLaborLine(userId, documentId, lineId);
  if (!ok) return res.status(404).json({ error: "Line not found" });

  res.status(204).send();
});

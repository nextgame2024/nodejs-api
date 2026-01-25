import * as model from "../models/bm.documents.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listDocuments(
  userId,
  { q, status, type, clientId, projectId, page, limit }
) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [documents, total] = await Promise.all([
    model.listDocuments(userId, {
      q,
      status,
      type,
      clientId,
      projectId,
      limit: safeLimit,
      offset,
    }),
    model.countDocuments(userId, { q, status, type, clientId, projectId }),
  ]);

  return { documents, page: safePage, limit: safeLimit, total };
}

export const getDocument = (userId, documentId) =>
  model.getDocument(userId, documentId);
export const createDocument = (userId, payload) =>
  model.createDocument(userId, payload);
export const updateDocument = (userId, documentId, payload) =>
  model.updateDocument(userId, documentId, payload);
export const archiveDocument = (userId, documentId) =>
  model.archiveDocument(userId, documentId);

// Lines
export async function listDocumentMaterialLines(userId, documentId) {
  const exists = await model.documentExists(userId, documentId);
  if (!exists) return null;
  return model.listDocumentMaterialLines(userId, documentId);
}
export async function listDocumentLaborLines(userId, documentId) {
  const exists = await model.documentExists(userId, documentId);
  if (!exists) return null;
  return model.listDocumentLaborLines(userId, documentId);
}

export const createDocumentMaterialLine = (userId, documentId, payload) =>
  model.createDocumentMaterialLine(userId, documentId, payload);

export const updateDocumentMaterialLine = (
  userId,
  documentId,
  lineId,
  payload
) => model.updateDocumentMaterialLine(userId, documentId, lineId, payload);

export const deleteDocumentMaterialLine = (userId, documentId, lineId) =>
  model.deleteDocumentMaterialLine(userId, documentId, lineId);

export const createDocumentLaborLine = (userId, documentId, payload) =>
  model.createDocumentLaborLine(userId, documentId, payload);

export const updateDocumentLaborLine = (userId, documentId, lineId, payload) =>
  model.updateDocumentLaborLine(userId, documentId, lineId, payload);

export const deleteDocumentLaborLine = (userId, documentId, lineId) =>
  model.deleteDocumentLaborLine(userId, documentId, lineId);

// Totals recalculation (uses pricing GST where possible)
export const recalcDocumentTotals = (userId, documentId) =>
  model.recalcDocumentTotals(userId, documentId);

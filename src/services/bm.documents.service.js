import * as model from "../models/bm.documents.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listDocuments(
  companyId,
  { q, status, type, clientId, projectId, page, limit }
) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [documents, total] = await Promise.all([
    model.listDocuments(companyId, {
      q,
      status,
      type,
      clientId,
      projectId,
      limit: safeLimit,
      offset,
    }),
    model.countDocuments(companyId, { q, status, type, clientId, projectId }),
  ]);

  return { documents, page: safePage, limit: safeLimit, total };
}

export const getDocument = (companyId, documentId) =>
  model.getDocument(companyId, documentId);

export const getCompanyProfile = (companyId) =>
  model.getCompanyProfile(companyId);

export const createDocument = (companyId, userId, payload) =>
  model.createDocument(companyId, userId, payload);

export const updateDocument = (companyId, documentId, payload) =>
  model.updateDocument(companyId, documentId, payload);

export const archiveDocument = (companyId, documentId) =>
  model.archiveDocument(companyId, documentId);

// Lines
export async function listDocumentMaterialLines(companyId, documentId) {
  const exists = await model.documentExists(companyId, documentId);
  if (!exists) return null;
  return model.listDocumentMaterialLines(companyId, documentId);
}

export async function listDocumentLaborLines(companyId, documentId) {
  const exists = await model.documentExists(companyId, documentId);
  if (!exists) return null;
  return model.listDocumentLaborLines(companyId, documentId);
}

export const createDocumentMaterialLine = (companyId, documentId, payload) =>
  model.createDocumentMaterialLine(companyId, documentId, payload);

export const updateDocumentMaterialLine = (
  companyId,
  documentId,
  lineId,
  payload
) => model.updateDocumentMaterialLine(companyId, documentId, lineId, payload);

export const deleteDocumentMaterialLine = (companyId, documentId, lineId) =>
  model.deleteDocumentMaterialLine(companyId, documentId, lineId);

export const createDocumentLaborLine = (companyId, documentId, payload) =>
  model.createDocumentLaborLine(companyId, documentId, payload);

export const updateDocumentLaborLine = (
  companyId,
  documentId,
  lineId,
  payload
) => model.updateDocumentLaborLine(companyId, documentId, lineId, payload);

export const deleteDocumentLaborLine = (companyId, documentId, lineId) =>
  model.deleteDocumentLaborLine(companyId, documentId, lineId);

// Totals
export const recalcDocumentTotals = (companyId, documentId) =>
  model.recalcDocumentTotals(companyId, documentId);

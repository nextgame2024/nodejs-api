import * as model from "../models/bm.documents.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/**
 * Status transition guardrails
 * Adjust as needed for your business process.
 */
const ALLOWED_TRANSITIONS = {
  draft: new Set(["sent", "void"]),
  sent: new Set(["accepted", "rejected", "void"]),
  accepted: new Set(["paid", "void"]),
  rejected: new Set(["void"]),
  paid: new Set([]),
  void: new Set([]),
};

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

/**
 * Update with validation:
 * - Validate status transitions
 * - Allow document type changes only while status is 'draft'
 */
export async function updateDocument(userId, documentId, payload) {
  // Only validate if there is a relevant change requested
  const statusRequested = payload?.status !== undefined;
  const typeRequested = payload?.type !== undefined;

  if (statusRequested || typeRequested) {
    const current = await model.getDocument(userId, documentId);
    if (!current) return null;

    if (statusRequested) {
      const from = current.status;
      const to = payload.status;

      if (to !== from) {
        const allowed = ALLOWED_TRANSITIONS[from] || new Set();
        if (!allowed.has(to)) {
          const err = new Error(`Invalid status transition: ${from} -> ${to}`);
          err.statusCode = 400;
          throw err;
        }
      }
    }

    if (typeRequested) {
      // You can only change quote <-> invoice while still a draft
      if (current.type !== payload.type && current.status !== "draft") {
        const err = new Error(
          "Document type can only be changed while status is draft"
        );
        err.statusCode = 400;
        throw err;
      }
    }
  }

  return model.updateDocument(userId, documentId, payload);
}

export const archiveDocument = (userId, documentId) =>
  model.archiveDocument(userId, documentId);

/**
 * Create document from project (quote/invoice) – passthrough to model.
 * Requires model.createDocumentFromProject(userId, projectId, payload)
 */
export const createDocumentFromProject = (userId, projectId, payload) =>
  model.createDocumentFromProject(userId, projectId, payload);

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

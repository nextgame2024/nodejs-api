import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.documents.service.js";
import * as model from "../models/bm.documents.model.js";
import * as clientsModel from "../models/bm.clients.model.js";
import { buildQuotePdf } from "../services/bm.quote_pdf.service.js";
import * as projectsService from "../services/bm.projects.service.js";

// Basic status transition guardrails
const ALLOWED_TRANSITIONS = {
  draft: new Set(["sent", "void"]),
  sent: new Set(["accepted", "rejected", "void"]),
  accepted: new Set(["paid", "void"]),
  rejected: new Set(["void"]),
  paid: new Set([]),
  void: new Set([]),
};

export const listDocuments = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const {
    q,
    status,
    type,
    clientId,
    projectId,
    page = "1",
    limit = "20",
  } = req.query;

  const result = await service.listDocuments(companyId, {
    q,
    status,
    type,
    clientId,
    projectId,
    page: Number(page),
    limit: Number(limit),
  });

  res.json(result);
});

export const getDocument = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { documentId } = req.params;
  const { includeLines = "false" } = req.query;

  const doc = await service.getDocument(companyId, documentId);
  if (!doc) return res.status(404).json({ error: "Document not found" });

  if (includeLines === "true") {
    const [materialLines, laborLines] = await Promise.all([
      service.listDocumentMaterialLines(companyId, documentId),
      service.listDocumentLaborLines(companyId, documentId),
    ]);
    return res.json({ document: doc, materialLines, laborLines });
  }

  res.json({ document: doc });
});

export const createDocument = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const userId = req.user.id;
  const payload = req.body?.document || req.body || {};

  if (!payload.client_id)
    return res.status(400).json({ error: "client_id is required" });
  if (!payload.type)
    return res.status(400).json({ error: "type is required (quote|invoice)" });

  const doc = await service.createDocument(companyId, userId, payload);
  if (!doc)
    return res
      .status(404)
      .json({ error: "Client not found or project not accessible" });

  res.status(201).json({ document: doc });
});

export const updateDocument = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const userId = req.user.id; // not used in model, but kept for future audit
  const { documentId } = req.params;
  const payload = req.body?.document || req.body || {};

  // Guardrails on status transitions
  if (payload.status !== undefined || payload.type !== undefined) {
    const current = await model.getDocument(companyId, documentId);
    if (!current) return res.status(404).json({ error: "Document not found" });

    if (payload.status !== undefined) {
      const from = current.status;
      const to = payload.status;
      if (to !== from) {
        const allowed = ALLOWED_TRANSITIONS[from] || new Set();
        if (!allowed.has(to)) {
          return res
            .status(400)
            .json({ error: `Invalid status transition: ${from} -> ${to}` });
        }
      }
    }

    if (
      payload.type !== undefined &&
      current.type !== payload.type &&
      current.status !== "draft"
    ) {
      return res.status(400).json({
        error: "Document type can only be changed while status is draft",
      });
    }
  }

  const doc = await service.updateDocument(companyId, documentId, payload);
  if (!doc) return res.status(404).json({ error: "Document not found" });

  res.json({ document: doc });
});

export const archiveDocument = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { documentId } = req.params;

  const ok = await service.archiveDocument(companyId, documentId);
  if (!ok) return res.status(404).json({ error: "Document not found" });

  res.status(204).send();
});

export const recalcDocumentTotals = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { documentId } = req.params;

  const doc = await service.recalcDocumentTotals(companyId, documentId);
  if (!doc) return res.status(404).json({ error: "Document not found" });

  res.json({ document: doc });
});

export const getDocumentQuotePdf = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { documentId } = req.params;

  const doc = await service.getDocument(companyId, documentId);
  if (!doc) return res.status(404).json({ error: "Document not found" });
  if (doc.type !== "quote") {
    return res.status(400).json({ error: "Document is not a quote" });
  }

  const [materialLines, laborLines, company, client] = await Promise.all([
    service.listDocumentMaterialLines(companyId, documentId),
    service.listDocumentLaborLines(companyId, documentId),
    service.getCompanyProfile(companyId),
    clientsModel.getClient(companyId, doc.clientId),
  ]);

  const refreshed = await service.recalcDocumentTotals(companyId, documentId);
  const document = refreshed || doc;
  const project = doc.projectId
    ? await projectsService.getProject(companyId, doc.projectId)
    : null;

  const pdfBuffer = await buildQuotePdf({
    document,
    company: company || {},
    client: client || {},
    project: project || (doc.projectName ? { projectName: doc.projectName } : null),
    materialLines,
    laborLines,
  });

  const filename = `Quote-${doc.docNumber || doc.documentId}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.send(pdfBuffer);
});

// Material lines
export const listDocumentMaterialLines = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { documentId } = req.params;

  const lines = await service.listDocumentMaterialLines(companyId, documentId);
  if (lines === null)
    return res.status(404).json({ error: "Document not found" });

  res.json({ materialLines: lines });
});

export const createDocumentMaterialLine = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { documentId } = req.params;
  const payload = req.body?.line || req.body || {};

  if (payload.unit_price === undefined)
    return res.status(400).json({ error: "unit_price is required" });

  const line = await service.createDocumentMaterialLine(
    companyId,
    documentId,
    payload
  );
  if (!line) return res.status(404).json({ error: "Document not found" });

  res.status(201).json({ materialLine: line });
});

export const updateDocumentMaterialLine = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { documentId, lineId } = req.params;
  const payload = req.body?.line || req.body || {};

  const line = await service.updateDocumentMaterialLine(
    companyId,
    documentId,
    lineId,
    payload
  );
  if (!line) return res.status(404).json({ error: "Line not found" });

  res.json({ materialLine: line });
});

export const deleteDocumentMaterialLine = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { documentId, lineId } = req.params;

  const ok = await service.deleteDocumentMaterialLine(
    companyId,
    documentId,
    lineId
  );
  if (!ok) return res.status(404).json({ error: "Line not found" });

  res.status(204).send();
});

// Labor lines
export const listDocumentLaborLines = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { documentId } = req.params;

  const lines = await service.listDocumentLaborLines(companyId, documentId);
  if (lines === null)
    return res.status(404).json({ error: "Document not found" });

  res.json({ laborLines: lines });
});

export const createDocumentLaborLine = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { documentId } = req.params;
  const payload = req.body?.line || req.body || {};

  if (payload.unit_price === undefined)
    return res.status(400).json({ error: "unit_price is required" });

  const line = await service.createDocumentLaborLine(
    companyId,
    documentId,
    payload
  );
  if (!line) return res.status(404).json({ error: "Document not found" });

  res.status(201).json({ laborLine: line });
});

export const updateDocumentLaborLine = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { documentId, lineId } = req.params;
  const payload = req.body?.line || req.body || {};

  const line = await service.updateDocumentLaborLine(
    companyId,
    documentId,
    lineId,
    payload
  );
  if (!line) return res.status(404).json({ error: "Line not found" });

  res.json({ laborLine: line });
});

export const deleteDocumentLaborLine = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { documentId, lineId } = req.params;

  const ok = await service.deleteDocumentLaborLine(
    companyId,
    documentId,
    lineId
  );
  if (!ok) return res.status(404).json({ error: "Line not found" });

  res.status(204).send();
});

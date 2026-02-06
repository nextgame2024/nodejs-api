// src/controllers/bm.projects.controller.js
import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.projects.service.js";
import * as documentsService from "../services/bm.documents.service.js";
import * as clientsModel from "../models/bm.clients.model.js";
import { buildInvoicePdf } from "../services/bm.invoice_pdf.service.js";
import { putToS3 } from "../services/s3.js";

const S3_PUBLIC_PREFIX = process.env.S3_PUBLIC_PREFIX || "public/";

export const listProjects = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { q, status, clientId, page = "1", limit = "20" } = req.query;

  const result = await service.listProjects(companyId, {
    q,
    status,
    clientId,
    page: Number(page),
    limit: Number(limit),
  });

  res.json(result);
});

export const getProject = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectId } = req.params;

  const project = await service.getProject(companyId, projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  res.json({ project });
});

export const createProject = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const userId = req.user.id;
  const payload = req.body?.project || req.body || {};

  if (!payload.client_id)
    return res.status(400).json({ error: "client_id is required" });
  if (!payload.project_name)
    return res.status(400).json({ error: "project_name is required" });

  const project = await service.createProject(companyId, userId, payload);
  if (!project) return res.status(404).json({ error: "Client not found" });

  res.status(201).json({ project });
});

export const updateProject = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectId } = req.params;
  const payload = req.body?.project || req.body || {};

  const project = await service.updateProject(companyId, projectId, payload);
  if (!project) return res.status(404).json({ error: "Project not found" });

  res.json({ project });
});

export const archiveProject = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectId } = req.params;

  const ok = await service.archiveProject(companyId, projectId);
  if (!ok) return res.status(404).json({ error: "Project not found" });

  res.status(204).send();
});

// Materials
export const listProjectMaterials = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectId } = req.params;

  const materials = await service.listProjectMaterials(companyId, projectId);
  if (materials === null)
    return res.status(404).json({ error: "Project not found" });

  res.json({ materials });
});

export const upsertProjectMaterial = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectId, materialId } = req.params;
  const payload = req.body?.projectMaterial || req.body || {};

  const row = await service.upsertProjectMaterial(
    companyId,
    projectId,
    materialId,
    payload
  );
  if (!row)
    return res.status(404).json({ error: "Project/material not accessible" });

  res.json({ projectMaterial: row });
});

export const removeProjectMaterial = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectId, materialId } = req.params;

  const ok = await service.removeProjectMaterial(
    companyId,
    projectId,
    materialId
  );
  if (!ok) return res.status(404).json({ error: "Project material not found" });

  res.status(204).send();
});

// Labor
export const listProjectLabor = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectId } = req.params;

  const labor = await service.listProjectLabor(companyId, projectId);
  if (labor === null)
    return res.status(404).json({ error: "Project not found" });

  res.json({ labor });
});

export const upsertProjectLabor = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectId, laborId } = req.params;
  const payload = req.body?.projectLabor || req.body || {};

  const row = await service.upsertProjectLabor(
    companyId,
    projectId,
    laborId,
    payload
  );
  if (!row)
    return res.status(404).json({ error: "Project/labor not accessible" });

  res.json({ projectLabor: row });
});

export const removeProjectLabor = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectId, laborId } = req.params;

  const ok = await service.removeProjectLabor(companyId, projectId, laborId);
  if (!ok) return res.status(404).json({ error: "Project labor not found" });

  res.status(204).send();
});

/**
 * POST /api/bm/projects/:projectId/create-document
 * Body: { type: "quote"|"invoice", doc_number?, issue_date?, due_date?, notes?, status? }
 */
export const createDocumentFromProject = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const userId = req.user.id;
  const { projectId } = req.params;

  const payload = req.body?.document || req.body || {};

  if (!payload.type) {
    return res.status(400).json({ error: "type is required (quote|invoice)" });
  }
  if (payload.type !== "quote" && payload.type !== "invoice") {
    return res.status(400).json({ error: "type must be 'quote' or 'invoice'" });
  }

  const result = await service.createDocumentFromProject(
    companyId,
    userId,
    projectId,
    payload
  );

  if (!result) {
    return res.status(404).json({ error: "Project not found" });
  }

  if (payload.type === "invoice" && result?.document?.documentId) {
    const documentId = result.document.documentId;
    const [company, client, project] = await Promise.all([
      documentsService.getCompanyProfile(companyId),
      clientsModel.getClient(companyId, result.document.clientId),
      service.getProject(companyId, projectId),
    ]);

    const pdfBuffer = await buildInvoicePdf({
      document: result.document,
      company: company || {},
      client: client || {},
      project: project || null,
      materialLines: result.materialLines || [],
      laborLines: result.laborLines || [],
    });

    const key =
      S3_PUBLIC_PREFIX +
      `business-manager/invoices/${companyId}/${result.document.docNumber || documentId}.pdf`;
    const pdfUrl = await putToS3({
      key,
      body: pdfBuffer,
      contentType: "application/pdf",
    });

    const updated = await documentsService.updateDocument(
      companyId,
      documentId,
      {
        pdf_url: pdfUrl,
        pdf_key: key,
        invoice_status: "invoice_created",
      }
    );
    if (updated) result.document = updated;
  }

  // result: { document, materialLines, laborLines }
  res.status(201).json(result);
});

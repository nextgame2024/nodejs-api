import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.clients.service.js";

export const listClients = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { q, status, page = "1", limit = "20" } = req.query;

  const result = await service.listClients(companyId, {
    q,
    status,
    page: Number(page),
    limit: Number(limit),
  });

  res.json(result);
});

export const getClient = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { clientId } = req.params;

  const client = await service.getClient(companyId, clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });

  res.json({ client });
});

export const createClient = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const userId = req.user.id;
  const payload = req.body?.client || req.body || {};

  if (!payload.client_name) {
    return res.status(400).json({ error: "client_name is required" });
  }

  const client = await service.createClient(companyId, userId, payload);
  res.status(201).json({ client });
});

export const updateClient = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { clientId } = req.params;
  const payload = req.body?.client || req.body || {};

  const client = await service.updateClient(companyId, clientId, payload);
  if (!client) return res.status(404).json({ error: "Client not found" });

  res.json({ client });
});

export const archiveClient = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { clientId } = req.params;

  const ok = await service.archiveClient(companyId, clientId);
  if (!ok) return res.status(404).json({ error: "Client not found" });

  res.status(204).send();
});

// Contacts
export const listClientContacts = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { clientId } = req.params;
  const { page = "1", limit = "20" } = req.query;

  const result = await service.listClientContacts(companyId, clientId, {
    page: Number(page),
    limit: Number(limit),
  });
  if (result === null)
    return res.status(404).json({ error: "Client not found" });

  res.json(result);
});

export const createClientContact = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { clientId } = req.params;
  const payload = req.body?.contact || req.body || {};

  if (!payload.name)
    return res.status(400).json({ error: "contact name is required" });

  const contact = await service.createClientContact(
    companyId,
    clientId,
    payload
  );
  if (!contact) return res.status(404).json({ error: "Client not found" });

  res.status(201).json({ contact });
});

export const updateClientContact = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { clientId, contactId } = req.params;
  const payload = req.body?.contact || req.body || {};

  const contact = await service.updateClientContact(
    companyId,
    clientId,
    contactId,
    payload
  );
  if (!contact) return res.status(404).json({ error: "Contact not found" });

  res.json({ contact });
});

export const deleteClientContact = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { clientId, contactId } = req.params;

  const ok = await service.deleteClientContact(companyId, clientId, contactId);
  if (!ok) return res.status(404).json({ error: "Contact not found" });

  res.status(204).send();
});

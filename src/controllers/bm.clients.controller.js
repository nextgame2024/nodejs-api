import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.clients.service.js";

export const listClients = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { q, status, page = "1", limit = "20" } = req.query;

  const result = await service.listClients(userId, {
    q,
    status,
    page: Number(page),
    limit: Number(limit),
  });

  res.json(result); // { clients, page, limit, total }
});

export const getClient = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { clientId } = req.params;

  const client = await service.getClient(userId, clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });

  res.json({ client });
});

export const createClient = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const payload = req.body?.client || req.body || {};

  if (!payload.client_name) {
    return res.status(400).json({ error: "client_name is required" });
  }

  const client = await service.createClient(userId, payload);
  res.status(201).json({ client });
});

export const updateClient = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { clientId } = req.params;
  const payload = req.body?.client || req.body || {};

  const client = await service.updateClient(userId, clientId, payload);
  if (!client) return res.status(404).json({ error: "Client not found" });

  res.json({ client });
});

export const archiveClient = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { clientId } = req.params;

  const ok = await service.archiveClient(userId, clientId);
  if (!ok) return res.status(404).json({ error: "Client not found" });

  res.status(204).send();
});

// Contacts
export const listClientContacts = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { clientId } = req.params;

  const contacts = await service.listClientContacts(userId, clientId);
  if (contacts === null)
    return res.status(404).json({ error: "Client not found" });

  res.json({ contacts });
});

export const createClientContact = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { clientId } = req.params;
  const payload = req.body?.contact || req.body || {};

  if (!payload.name)
    return res.status(400).json({ error: "contact name is required" });

  const contact = await service.createClientContact(userId, clientId, payload);
  if (!contact) return res.status(404).json({ error: "Client not found" });

  res.status(201).json({ contact });
});

export const updateClientContact = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { clientId, contactId } = req.params;
  const payload = req.body?.contact || req.body || {};

  const contact = await service.updateClientContact(
    userId,
    clientId,
    contactId,
    payload
  );
  if (!contact) return res.status(404).json({ error: "Contact not found" });

  res.json({ contact });
});

export const deleteClientContact = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { clientId, contactId } = req.params;

  const ok = await service.deleteClientContact(userId, clientId, contactId);
  if (!ok) return res.status(404).json({ error: "Contact not found" });

  res.status(204).send();
});

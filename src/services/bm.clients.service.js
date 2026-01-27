import * as model from "../models/bm.clients.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listClients(companyId, { q, status, page, limit }) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [clients, total] = await Promise.all([
    model.listClients(companyId, { q, status, limit: safeLimit, offset }),
    model.countClients(companyId, { q, status }),
  ]);

  return { clients, page: safePage, limit: safeLimit, total };
}

export const getClient = (companyId, clientId) =>
  model.getClient(companyId, clientId);
export const createClient = (companyId, userId, payload) =>
  model.createClient(companyId, userId, payload);
export const updateClient = (companyId, clientId, payload) =>
  model.updateClient(companyId, clientId, payload);
export const archiveClient = (companyId, clientId) =>
  model.archiveClient(companyId, clientId);

// Contacts
export async function listClientContacts(companyId, clientId) {
  const exists = await model.clientExists(companyId, clientId);
  if (!exists) return null;
  return model.listClientContacts(companyId, clientId);
}

export const createClientContact = (companyId, clientId, payload) =>
  model.createClientContact(companyId, clientId, payload);

export const updateClientContact = (companyId, clientId, contactId, payload) =>
  model.updateClientContact(companyId, clientId, contactId, payload);

export const deleteClientContact = (companyId, clientId, contactId) =>
  model.deleteClientContact(companyId, clientId, contactId);

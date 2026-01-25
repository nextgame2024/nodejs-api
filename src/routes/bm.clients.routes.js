import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  listClients,
  getClient,
  createClient,
  updateClient,
  archiveClient,
  listClientContacts,
  createClientContact,
  updateClientContact,
  deleteClientContact,
} from "../controllers/bm.clients.controller.js";

const router = Router();

// Clients
router.get("/bm/clients", authRequired, listClients);
router.post("/bm/clients", authRequired, createClient);
router.get("/bm/clients/:clientId", authRequired, getClient);
router.put("/bm/clients/:clientId", authRequired, updateClient);
router.delete("/bm/clients/:clientId", authRequired, archiveClient);

// Client contacts (nested)
router.get("/bm/clients/:clientId/contacts", authRequired, listClientContacts);
router.post(
  "/bm/clients/:clientId/contacts",
  authRequired,
  createClientContact
);
router.put(
  "/bm/clients/:clientId/contacts/:contactId",
  authRequired,
  updateClientContact
);
router.delete(
  "/bm/clients/:clientId/contacts/:contactId",
  authRequired,
  deleteClientContact
);

export default router;

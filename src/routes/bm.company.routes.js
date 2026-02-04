import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  listCompanies,
  getCompany,
  createCompany,
  updateCompany,
  archiveCompany,
} from "../controllers/bm.company.controller.js";

const router = Router();

router.get("/bm/company", authRequired, listCompanies);
router.post("/bm/company", authRequired, createCompany);
router.get("/bm/company/:companyId", authRequired, getCompany);
router.put("/bm/company/:companyId", authRequired, updateCompany);
router.delete("/bm/company/:companyId", authRequired, archiveCompany);

export default router;

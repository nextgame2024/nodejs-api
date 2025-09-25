import { Router } from "express";
import { authOptional } from "../middlewares/authOptional.js";
import { listEmployees } from "../controllers/employee.controller.js";

const router = Router();
router.get("/employees", authOptional, listEmployees);

export default router;

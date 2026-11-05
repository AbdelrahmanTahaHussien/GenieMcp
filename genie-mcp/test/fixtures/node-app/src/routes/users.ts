import { Router } from "express";
import { getUsers, createUser } from "../controllers/userController";
import { requireAuth } from "../middleware/auth";

export const userRouter = Router();
userRouter.get("/", requireAuth, getUsers);
userRouter.post("/", createUser);

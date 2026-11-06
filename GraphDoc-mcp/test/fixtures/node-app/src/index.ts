import express from "express";
import { userRouter } from "./routes/users";
import { connectDb } from "./db";

const app = express();
app.use("/users", userRouter);

connectDb();
app.listen(3000);

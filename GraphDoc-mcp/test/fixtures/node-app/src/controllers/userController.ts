import { UserService } from "../services/UserService";

const service = new UserService();

export function getUsers(_req: unknown, res: { json(v: unknown): void }) {
  res.json(service.list());
}

export const createUser = (req: { body: unknown }, res: { json(v: unknown): void }) => {
  res.json(service.create(req.body));
};

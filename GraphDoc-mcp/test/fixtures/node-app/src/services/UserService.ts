import { db } from "../db";

/** Users domain logic. */
export class UserService {
  list() {
    return db.query("users");
  }
  create(user: unknown) {
    return db.insert("users", user);
  }
}
